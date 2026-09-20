/**
 * WebSocket 事件流隔离。
 *
 * 事实（此前误判为 SSE 已修正）：浏览器的两条实时事件流是 **WebSocket 升级**
 * （GET + `Upgrade: websocket`），路径 `/api/events.mux`、`/api/events.host`，
 * 由 webserver 的独立升级分发处理 —— HTTP exact/prefix 路由**不参与升级**，
 * 本插件在 HTTP 层的接管拦不住它。不处理这里，浏览器就能实时收到他人会话的
 * 全部帧（新建会话会立刻出现在他人侧边栏）。
 *
 * 实现分两半，都不依赖装配时序彩票：
 *   1. `hijackEventUpgrades`：在 http server 上拦截 'upgrade' 事件 —— 摘掉
 *      webserver 已注册的升级监听器，换成我们的包装：事件流路径先过 Cookie
 *      鉴权（未登录 401），再把「本连接的帧过滤器」放进 AsyncLocalStorage，
 *      最后调用原监听器。不与 connection 插件抢 `registerUpgrade`（同路径
 *      重复注册会抛错，且注册顺序不可控）。
 *   2. `wrapEventStreams`：包装 `apiProxy.events.mux/host`。downlink 每次
 *      WebSocket 连接都在调用栈内同步打开上游流（ws 的 handleUpgrade 回调
 *      在原监听器栈内同步执行，AsyncLocalStorage 上下文必然存活），包装层
 *      读到上下文后逐帧过滤再产出；无上下文（进程内其他调用方）则透传。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Server, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { principalFromRequest } from './http.js'
import { claimSubagentChild, hostPredicate, muxPredicate, type StreamFrame } from './gate.js'
import type { StateStore } from './store.js'
import type { ResolvedAuthConfig, SessionPrincipal } from './types.js'


/** 事件流的 WebSocket 升级路径（与 harness `api-path.ts` 一致）。 */
const MUX_PATH = '/api/events.mux'
const HOST_PATH = '/api/events.host'

/** 帧过滤所需的最小依赖（gate 的谓词用得到 store 与 auth 策略）。 */
export interface FrameFilterContext {
  store: StateStore
  auth: ResolvedAuthConfig
  log: (message: string) => void
}

/** 本连接的帧过滤规则（升级握手时确定，经 AsyncLocalStorage 传入上游流包装）。 */
interface ConnectionFilter {
  filterFrame: (frame: StreamFrame) => boolean
  beforeFilter?: (frame: StreamFrame) => void
}

const connectionFilter = new AsyncLocalStorage<ConnectionFilter>()

/** 本插件用到的 webServer 形状（窄化；server 是 TS private 但运行时可读）。 */
export interface UpgradeServer {
  /** node:http server 实例（webServer [Service.init] 之后可用）。 */
  server?: Server
}

/** makeFilter 依赖的鉴权读取面。 */
type AuthView = Parameters<typeof principalFromRequest>[1]

/**
 * 拦截 http server 的升级分发：事件流路径加登录态校验 + 帧过滤上下文。
 * @returns 恢复原升级监听器的 disposer。
 */
export function hijackEventUpgrades(
  ctx: FrameFilterContext & { authView: AuthView },
  webServer: UpgradeServer,
): () => void {
  const server = webServer.server
  if (server === undefined) {
    ctx.log('webServer 尚未监听，无法拦截 WebSocket 升级，实时事件流隔离未启用')
    return () => undefined
  }
  const originalListeners = server.listeners('upgrade')
  server.removeAllListeners('upgrade')
  server.on('upgrade', hijacked)

  function hijacked(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      path = ''
    }
    if (path !== MUX_PATH && path !== HOST_PATH) {
      dispatch(req, socket, head)
      return
    }
    const principal = principalFromRequest(req, ctx.authView)
    if (principal === undefined) {
      rejectUpgrade(socket)
      return
    }
    const isMux = path === MUX_PATH
    const filter: ConnectionFilter = isMux
      ? { filterFrame: frame => muxPredicate(ctx, principal)(frame.payload) }
      : {
          filterFrame: frame => hostPredicate(ctx, principal)(frame.payload),
          beforeFilter: frame => claimSubagentChild(ctx, frame),
        }
    // ws 的 handleUpgrade 回调（downlink 在这里打开上游流）在原监听器调用栈内
    // 同步执行，因此 run 块内的上下文必然被上游流包装读到。
    connectionFilter.run(filter, () => dispatch(req, socket, head))
  }

  function dispatch(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    for (const listener of originalListeners) {
      ;(listener as (r: IncomingMessage, s: Duplex, h: Buffer) => void).call(server, req, socket, head)
    }
  }

  ctx.log('已拦截 WebSocket 升级分发：事件流连接需登录态，实时帧按归属过滤')

  return () => {
    server.off('upgrade', hijacked)
    for (const listener of originalListeners) server.on('upgrade', listener as never)
  }
}

/** `apiProxy.events` 的窄化形状（可变属性，包装用）。 */
export interface EventsStreams {
  mux: (request: { rpcId: string; payload: Record<string, unknown> }, signal: AbortSignal) => AsyncIterable<StreamFrame>
  host: (request: { rpcId: string; payload: Record<string, unknown> }, signal: AbortSignal) => AsyncIterable<StreamFrame>
}

/**
 * 包装 `apiProxy.events.mux/host`：处于某连接的过滤上下文时逐帧过滤，
 * 否则透传。须在浏览器建立 WebSocket 连接之前安装（插件 apply 后立即装，
 * 此时的窗口期内没有已登录浏览器连接，可忽略）。
 * @returns 恢复原方法的 disposer。
 */
export function wrapEventStreams(ctx: FrameFilterContext, events: EventsStreams): () => void {
  const originalMux = events.mux
  const originalHost = events.host

  const wrapStream = (
    original: EventsStreams['mux'],
    makeFilter: (principal: SessionPrincipal) => ConnectionFilter,
  ): EventsStreams['mux'] => {
    // async generator：调用方（downlink 的 pump 与本插件的 HTTP SSE 兜底）按
    // AsyncIterable 消费，形状不变。
    return async function* (request, signal) {
      const filter = connectionFilter.getStore()
      const upstream = original.call(events, request, signal)
      if (filter === undefined) {
        yield* upstream
        return
      }
      for await (const frame of upstream) {
        filter.beforeFilter?.(frame)
        if (filter.filterFrame(frame)) yield frame
      }
    }
  }

  events.mux = wrapStream(originalMux, principal => ({
    filterFrame: frame => muxPredicate(ctx, principal)(frame.payload),
  }))
  events.host = wrapStream(originalHost, principal => ({
    filterFrame: frame => hostPredicate(ctx, principal)(frame.payload),
    beforeFilter: frame => claimSubagentChild(ctx, frame),
  }))
  ctx.log('已包装事件流上游：WebSocket 实时帧将按登录态过滤')

  return () => {
    events.mux = originalMux
    events.host = originalHost
  }
}

/** 拒绝未登录的升级连接（裸 HTTP 响应，随后由调用方关闭 socket）。 */
function rejectUpgrade(socket: Duplex): void {
  try {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 12\r\n\r\nunauthorized')
  } catch {
    // 客户端已断开。
  }
}
