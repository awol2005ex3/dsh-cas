/**
 * `/api/<method>` 的鉴权与隔离层。
 *
 * 为什么影子化 HTTP 路由而不是用 `connection.rpc.handle`：
 * rpc.handle 回调只拿到 `(endpoint, payload, signal)`，读不到 Cookie，
 * 无法判断调用者是谁。而 `ctx.webServer` 的路由匹配是「exact 优先，其次最长
 * 前缀」，connection 插件把 `/api` 注册为 prefix，因此这里用 exact 注册
 * `/api/session.list` 之类的路径即可合法接管，同时拿到原生 req/res。
 *
 * 真实数据在同进程直接调用 `ctx.apiProxy` 的具名方法取得，不经 HTTP，
 * 因此不会自环回本插件的影子路由。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { principalFromRequest } from './http.js'
import type { AuthLookup } from './session-lookup.js'
import type { StateStore } from './store.js'
import type { PluginConfig, ResolvedAuthConfig, SessionPrincipal } from './types.js'

/** 影子化路由的固定前缀。 */
const API = '/api'

/** 请求体上限（提示类请求可带图片，放宽到 32MB）。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 单次方法访问规则。 */
interface MethodRule {
  /** payload 中承载会话 id 的字段名，用于校验归属。 */
  sessionIdField?: string
  /** 列举类：返回后按归属过滤会话条目。 */
  filter?: 'session-list'
  /** 工作区列举：按归属过滤 sessionIds。 */
  filterWorkspace?: boolean
  /** 建会话：成功后登记归属。 */
  claim?: boolean
  /** 仅管理员可调用。 */
  adminOnly?: true
}

/**
 * 方法规则表。刻意识别式列出：未列出的方法直接放行，
 * harness 新增方法不会因为插件没跟上而整体不可用。
 */
const METHOD_RULES: Record<string, MethodRule> = {
  'session.list': { filter: 'session-list' },
  'session.search': { filter: 'session-list' },
  'session.create': { claim: true },
  'session.history': { sessionIdField: 'sessionId' },
  'session.models': { sessionIdField: 'sessionId' },
  'session.selectModel': { sessionIdField: 'sessionId' },
  'session.rename': { sessionIdField: 'sessionId' },
  'session.fork': { sessionIdField: 'sessionId', claim: true },
  'session.prompt': { sessionIdField: 'sessionId' },
  'session.attachment': { sessionIdField: 'sessionId' },
  'session.updateQueue': { sessionIdField: 'sessionId' },
  'session.cancel': { sessionIdField: 'sessionId' },

  'subagent.list': { sessionIdField: 'parentSessionId' },
  'subagent.history': { sessionIdField: 'childSessionId' },
  'subagent.prompt': { sessionIdField: 'parentSessionId' },
  'subagent.interrupt': { sessionIdField: 'childSessionId' },

  'workspace.list': { filterWorkspace: true },
  'workspace.archiveSession': { sessionIdField: 'sessionId' },
  'workspace.insertSessionBefore': { sessionIdField: 'sessionId' },

  'settings.update': { adminOnly: true },
  'settings.replace': { adminOnly: true },
  'settings.mutate': { adminOnly: true },
  'settings.openDocument': { adminOnly: true },
  'credentials.set': { adminOnly: true },
  'credentials.unset': { adminOnly: true },
  'credentials.describe': { adminOnly: true },
  'host.openPath': { adminOnly: true },
  'host.createDirectory': { adminOnly: true },
  'agentPreset.remove': { adminOnly: true },
  'agentPreset.copy': { adminOnly: true },
  'agentPreset.openDocument': { adminOnly: true },
}

/**
 * 方法前缀 → `ctx.apiProxy` 上的域名。多数是复数，且 `agentPreset.*` 用的是驼峰
 * 前缀，无法从方法名推导，因此显式映射（写错即在此表暴露，而不是运行时报
 * "method unavailable"）。
 */
const DOMAIN_OF: Readonly<Record<string, string>> = {
  session: 'sessions',
  subagent: 'subagents',
  host: 'host',
  workspace: 'workspace',
  skill: 'skills',
  agentPreset: 'agentPresets',
  goal: 'goals',
  settings: 'settings',
  credentials: 'credentials',
  llm: 'llm',
}

/** 窄化的 RPC 请求 / 响应（与 harness 的 RpcRequest / RpcResponse 同形）。 */
interface RpcRequestLike {
  rpcId: string
  payload: Record<string, unknown>
}
interface RpcResponseLike {
  rpcId: string
  result: unknown
}

/** 需要转发信号的方法（签名里带 AbortSignal 的那些）。 */
const SIGNAL_METHODS: ReadonlySet<string> = new Set([
  'session.search',
  'subagent.list',
  'subagent.history',
  'subagent.prompt',
  'host.pickDirectory',
  'host.listDirectory',
  'host.openPath',
  'agentPreset.openDocument',
  'settings.openDocument',
  'llm.discoverModels',
])

/**
 * `ctx.apiProxy` 的窄化视图。宿主官方实现（ApiProxyService）逐域暴露具名
 * 方法，这里只依赖方法存在，不依赖其内部的 schema 模块。
 */
export interface ApiProxyLike {
  sessions?: Record<string, UnknownMethod>
  subagents?: Record<string, UnknownMethod>
  host?: Record<string, UnknownMethod>
  workspace?: Record<string, UnknownMethod>
  skills?: Record<string, UnknownMethod>
  agentPresets?: Record<string, UnknownMethod>
  goals?: Record<string, UnknownMethod>
  settings?: Record<string, UnknownMethod>
  credentials?: Record<string, UnknownMethod>
  llm?: Record<string, UnknownMethod>
  /** 事件流（SSE）。mux 是会话级全量广播，host 是主机级（含 session-added）。 */
  events?: {
    mux: (request: { rpcId: string; payload: Record<string, unknown> }, signal: AbortSignal) => AsyncIterable<StreamFrame>
    host: (request: { rpcId: string; payload: Record<string, unknown> }, signal: AbortSignal) => AsyncIterable<StreamFrame>
  }
}

type UnknownMethod = (...args: never[]) => Promise<unknown>

/** 上游 SSE 流产出的帧（与 harness 的 `RpcRequest<MuxFrame|HostFrame>` 同形）。 */
export interface StreamFrame {
  type: string
  rpcId: string
  method: string
  payload: Record<string, unknown>
}

/** 网关依赖。 */
export interface GateContext extends AuthLookup {
  config: PluginConfig
  store: StateStore
  /** 宿主 API 网关（`ctx.apiProxy`）。 */
  api: ApiProxyLike
  log: (message: string) => void
}

/** 注册结果。 */
export interface GateHandle {
  dispose: () => void
  /** 实际接管的方法清单（日志 / 自检用）。 */
  methods: readonly string[]
}

/** 精确路由注册函数（`ctx.webServer.register` 的形状）。 */
export type RouteRegistrar = (route: {
  kind: 'exact'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}) => () => void



/**
 * 注册全部影子路由。
 * @param ctx - 网关依赖。
 * @param register - 路由注册函数。
 */
export function registerApiGate(ctx: GateContext, register: RouteRegistrar): GateHandle {
  const methods = [...Object.keys(METHOD_RULES), ...ctx.auth.adminOnlyMethods.filter(
    (method): method is string => typeof method === 'string' && method.length > 0,
  )]
  const unique = [...new Set(methods)]
  const disposers: (() => void)[] = []
  const succeeded: string[] = []
  const failed: string[] = []

  for (const method of unique) {
    const rule: MethodRule = METHOD_RULES[method] ?? { adminOnly: true }
    try {
      disposers.push(register({
        kind: 'exact',
        path: `${API}/${method}`,
        handler: (req, res) => handleMethod(
          ctx,
          method,
          rule,
          req as IncomingMessage,
          res as ServerResponse,
        ),
      }))
      succeeded.push(method)
      
    } catch (err) {
      // 注册冲突（例如 harness 自己已注册了同一 exact 路径）不应拖垮整个插件，
      // 但必须显式记录——冲突意味着本方法没有被接管，隔离在该方法上形同虚设。
      failed.push(method)
      ctx.log(`影子化 ${method} 失败（路由可能被 harness 抢占）：${String(err)}`)
    }
  }

  // session.export 是 GET + query 参数，不走 JSON 信封，单独处理。
  try {
    disposers.push(register({
      kind: 'exact',
      path: `${API}/session.export`,
      handler: (req, res) => handleExport(ctx, req as IncomingMessage, res as ServerResponse),
    }))
  } catch (err) {
    failed.push('session.export')
    ctx.log(`影子化 session.export 失败（路由可能被 harness 抢占）：${String(err)}`)
  }

  // 事件流 HTTP 层兜底（浏览器实际走 WebSocket 升级，由 events-ws.ts 隔离；
  // 这里接管 plain GET，供非浏览器调用方与手工验证）。harness 的 mux/host 是
  // 全量广播，逐帧按「归属」过滤后再转发。
  const events = ctx.api.events
  if (events?.mux !== undefined && events?.host !== undefined) {
    try {
      disposers.push(register({
        kind: 'exact',
        path: `${API}/events.mux`,
        handler: (req, res) => proxyStream(
          ctx,
          req as IncomingMessage,
          res as ServerResponse,
          signal => events.mux({ rpcId: 'mux-' + randomUUID(), payload: {} }, signal),
          principal => muxPredicate(ctx, principal),
        ),
      }))
    } catch (err) {
      failed.push('events.mux')
      ctx.log(`影子化 events.mux 失败（路由可能被 harness 抢占）：${String(err)}`)
    }
    try {
      disposers.push(register({
        kind: 'exact',
        path: `${API}/events.host`,
        handler: (req, res) => proxyStream(
          ctx,
          req as IncomingMessage,
          res as ServerResponse,
          signal => events.host({ rpcId: 'host-' + randomUUID(), payload: {} }, signal),
          principal => hostPredicate(ctx, principal),
          frame => claimSubagentChild(ctx, frame),
        ),
      }))
    } catch (err) {
      failed.push('events.host')
      ctx.log(`影子化 events.host 失败（路由可能被 harness 抢占）：${String(err)}`)
    }
  } else {
    ctx.log('未找到 events 流服务，会话隔离在事件流层面不生效（列表层仍过滤）')
  }

  // 启动自检：明确报告「接管了多少 / 漏掉了多少」。若 succeeded 远小于 attempted，
  // 说明 exact 路由被 harness 自己的路由抢占，隔离在该方法上完全没生效——
  // 这正是「管理员仍能看到他人会话」的最可能根因。
  const total = unique.length
  if (succeeded.length < total) {
    ctx.log(`[严重] API 网关只接管了 ${succeeded.length}/${total} 个方法，未接管：${failed.join(', ')}；这些方法的会话隔离已失效`)
  } else {
    ctx.log(`API 网关已接管全部 ${total} 个 /api 方法`)
  }

  return {
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
    methods: succeeded,
  }
}

/* ── 请求处理 ── */

async function handleMethod(
  ctx: GateContext,
  method: string,
  rule: MethodRule,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return text(res, 404, 'not found')

  const principal = principalFromRequest(req, ctx)
  if (principal === undefined) {
    return rpcError(res, '登录状态已失效，请重新登录')
  }
  if (rule.adminOnly === true && principal.role !== 'admin') {
    return rpcError(res, `${method} 需要管理员权限`)
  }

  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') return text(res, 415, 'content type must be application/json')

  const raw = await readBody(req)
  if (raw === undefined) return text(res, 413, 'request body too large')

  const envelope = parseEnvelope(raw)
  if (envelope === undefined || envelope.method !== method) {
    return text(res, 400, 'invalid client-request message')
  }

  if (rule.sessionIdField !== undefined) {
    const sessionId = strOf(envelope.payload, rule.sessionIdField)
    if (sessionId !== undefined && !allowed(ctx, principal, sessionId)) {
      return rpcError(res, '无权访问该会话')
    }
  }

  let result: unknown
  try {
    result = await invoke(ctx, method, { rpcId: envelope.rpcId, payload: envelope.payload }, req, res)
  } catch (err) {
    ctx.log(`${method} 调用失败：${String(err)}`)
    return text(res, 500, `handler failure: ${String(err)}`)
  }

  let body = JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result })
  if (rule.filter === 'session-list') body = filterSessionList(ctx, principal, body)
  else if (rule.filterWorkspace === true) body = filterWorkspaceList(ctx, principal, body)
  else if (rule.claim === true) body = claimCreated(ctx, principal, body)

  return json(res, body)
}

async function handleExport(ctx: GateContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 404, 'not found')
  const principal = principalFromRequest(req, ctx)
  if (principal === undefined) return text(res, 401, 'unauthenticated')
  const sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId')
  if (sessionId !== null && sessionId !== '' && !allowed(ctx, principal, sessionId)) {
    return text(res, 403, 'forbidden')
  }
  ctx.log(`session.export 未接管转发（${sessionId ?? '未知会话'}），交由官方路由处理`)
  return text(res, 501, 'session export is not proxied by user-manager')
}

/* ── 事件流（SSE）隔离 ── */

/**
 * harness 的 `events.mux` / `events.host` 是「全量广播」SSE 流：每个连接的浏览器
 * 都会收到所有会话的实时帧（包含他人会话内容），且 web 客户端会把这些推送帧直接
 * 并入侧边栏列表（见 harness `sessions/manager.ts`）。若不接管，纯插件方案下的
 * 会话隔离就是空谈。这里用 exact GET 路由压过 `/api` 前缀，逐帧按「归属」过滤后再
 * 转发给浏览器 —— 服务端进程内即可实现真正的流隔离。
 *
 * 过滤维度是 owner 而非 allowed（关键）：harness 在 `session.create` 执行期间就
 * 广播 `host/session-added` / `host/workspace-changed`，而本插件认领归属是在
 * create 返回之后才写入。于是新建会话在广播瞬间处于「无主」窗口，若按 allowed 过滤
 * （无主会话对管理员可见）管理员会实时收到他人刚建的会话、并在侧边栏永久渲染。
 * 因此实时流一律按 owner 维度：无主会话不进任何人的实时流；「列表基线」仍用 allowed，
 * 保留「启用插件前的历史无主会话」对管理员的可见性（只读、无实时更新）。
 */
async function proxyStream(
  ctx: GateContext,
  req: IncomingMessage,
  res: ServerResponse,
  opener: (signal: AbortSignal) => AsyncIterable<StreamFrame>,
  makePredicate: (principal: SessionPrincipal) => (payload: Record<string, unknown>) => boolean,
  beforeFilter?: (frame: StreamFrame) => void,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 404, 'not found')
  const principal = principalFromRequest(req, ctx)
  if (principal === undefined) return text(res, 401, 'unauthenticated')

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')

  const predicate = makePredicate(principal)
  const controller = new AbortController()
  const onClose = (): void => { controller.abort() }
  req.on('close', onClose)
  try {
    for await (const frame of opener(controller.signal)) {
      beforeFilter?.(frame)
      if (!predicate(frame.payload)) continue
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
    }
  } catch (err) {
    ctx.log(`事件流代理中断：${String(err)}`)
    try {
      res.write(`data: ${JSON.stringify({
        type: 'server-request',
        rpcId: 'mux-error',
        method: 'stream/error',
        payload: { type: 'stream/error', error: { code: 'internal', message: String(err), details: {} } },
      })}\n\n`)
    } catch {
      // 连接已断开，无需处理。
    }
  } finally {
    req.off('close', onClose)
    try { res.end() } catch {
      // 已结束。
    }
  }
}

/** mux 帧：带 sessionId 的按「归属（owner）」过滤；stream/error 等无主帧透传。
 *  用 owner 维度而非 allowed：新建会话广播时尚未认领（无主），allowed 对管理员
 *  返回 true 会把他人刚建的会话漏进管理员的实时流。 */
export function muxPredicate(ctx: { store: StateStore }, principal: SessionPrincipal): (payload: Record<string, unknown>) => boolean {
  return (payload) => {
    const sid = payload.sessionId
    if (typeof sid !== 'string') return true
    return owned(ctx, principal, sid)
  }
}

/** host 帧：session-* 按归属过滤；archived/workspace 内的会话 id 列表就地裁剪；
 *  workspace 级的增删/排序/remote-event/stream/error 透传（会话内容已由 mux 与 list 过滤）。 */
export function hostPredicate(
  ctx: { store: StateStore; auth: ResolvedAuthConfig },
  principal: SessionPrincipal,
): (payload: Record<string, unknown>) => boolean {
  return (payload) => {
    const type = payload.type
    if (type === 'host/archived-sessions-changed' && Array.isArray(payload.archivedSessionIds)) {
      payload.archivedSessionIds = (payload.archivedSessionIds as unknown[])
        .filter(id => typeof id === 'string' && allowed(ctx, principal, id))
      return true
    }
    if (type === 'host/workspace-changed' && payload.workspace !== undefined && typeof payload.workspace === 'object') {
      const ws = payload.workspace as Record<string, unknown>
      if (Array.isArray(ws.sessionIds)) {
        ws.sessionIds = (ws.sessionIds as unknown[])
          .filter(id => typeof id === 'string' && owned(ctx, principal, id))
      }
      return true
    }
    const sid = payload.sessionId
    if (typeof sid === 'string') return owned(ctx, principal, sid)
    return true
  }
}

/**
 * 子代理会话认领：harness 的 `host/session-added` 对子代理会话带 `parentSessionId`，
 * 但 `subagent.prompt` 的结果只回 `messageId`（拿不到子会话 id），无法在 API 层认领。
 * 这里在事件流里借父会话归属把子会话认领给同一用户，使实时流按 owner 过滤时
 * 子代理会话也能正确归属，管理员不会在实时流里看到他人的子代理会话。
 */
export function claimSubagentChild(ctx: { store: StateStore }, frame: StreamFrame): void {  const p = frame.payload
  if (p?.type !== 'host/session-added') return
  const child = typeof p.sessionId === 'string' ? p.sessionId : undefined
  const parent = typeof p.parentSessionId === 'string' ? p.parentSessionId : undefined
  if (child === undefined || parent === undefined) return
  const owner = ctx.store.ownerOfSession(parent)
  if (owner === undefined) return
  ctx.store.claim(child, owner)
  ctx.store.save()
}

/**
 * 调用宿主 API 的具名方法。
 * `@deepseek-ai/dsh-host-apiproxy` 不是本插件的依赖，因此不复用它的
 * toFetchHandler，而是按 `域.方法` 直接取方法调用 —— 只依赖方法名稳定。
 */
async function invoke(
  ctx: GateContext,
  method: string,
  request: RpcRequestLike,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown> {
  const dot = method.lastIndexOf('.')
  if (dot <= 0) throw new Error(`unsupported method ${method}`)
  const prefix = method.slice(0, dot)
  const action = method.slice(dot + 1)
  const domain = DOMAIN_OF[prefix]
  if (domain === undefined) throw new Error(`unknown api domain for ${method}`)
  const table = (ctx.api as unknown as Record<string, Record<string, UnknownMethod> | undefined>)[domain]
  const fn = table?.[action]
  if (typeof fn !== 'function') throw new Error(`api method ${method} unavailable`)

  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  req.on('aborted', abort)
  res.on('close', abort)
  try {
    const call = fn as unknown as (
      request: RpcRequestLike,
      signal?: AbortSignal,
    ) => Promise<RpcResponseLike>
    const response = SIGNAL_METHODS.has(method)
      ? await call(request, controller.signal)
      : await call(request)
    return response.result
  } finally {
    req.off('aborted', abort)
    res.off('close', abort)
  }
}

/** 归属判定：拥有者可访问；无主会话按配置的 unownedSessions 策略。
 *  用于「列表 / 访问」层（session.list、session.history 等）——无主会话按策略
 *  对管理员可见，是「启用插件前的历史会话仍可管理」的基线。 */
function allowed(
  ctx: { store: StateStore; auth: ResolvedAuthConfig },
  principal: SessionPrincipal,
  sessionId: string,
): boolean {
  const verdict = ctx.store.verdict(sessionId, principal.userId)
  if (verdict === 'owner') return true
  if (verdict === 'other') return false
  // 无主会话：本插件启用前就存在的历史会话，或子代理会话尚未登记。
  return ctx.auth.unownedSessions === 'everyone'
    || (ctx.auth.unownedSessions === 'admin' && principal.role === 'admin')
}

/** owner 维度判定：仅当会话确属该用户。用于「实时事件流（SSE）」隔离。
 *  关键区别：新建会话在 harness 广播 session-added 时尚处「无主」窗口，
 *  若用 allowed 会让管理员在实时流里看到他人刚建的会话（这就是此前隔离失效的根因）。
 *  因此事件流一律按 owner 过滤，无主会话不进任何人的实时流；列表基线仍用 allowed
 *  保留历史无主会话的可见性。 */
function owned(ctx: { store: StateStore }, principal: SessionPrincipal, sessionId: string): boolean {
  return ctx.store.verdict(sessionId, principal.userId) === 'owner'
}

/* ── 响应改写 ── */

/** 过滤 session.list / session.search 的结果。 */
function filterSessionList(ctx: GateContext, principal: SessionPrincipal, body: string): string {
  const parsed = parseJson(body)
  if (parsed === undefined) return body
  const result = asRecord(parsed.result)
  if (result === undefined || result.ok !== true) return body
  const value = asRecord(result.value)
  if (value === undefined || !Array.isArray(value.items)) return body
  value.items = value.items.filter(item => {
    const sessionId = strOf(asRecord(item) ?? {}, 'sessionId')
    return sessionId === undefined || allowed(ctx, principal, sessionId)
  })
  return JSON.stringify(parsed)
}

/** 过滤 workspace.list 的 sessionIds，并隐藏没有可见会话的工作区。 */
function filterWorkspaceList(ctx: GateContext, principal: SessionPrincipal, body: string): string {
  const parsed = parseJson(body)
  if (parsed === undefined) return body
  const result = asRecord(parsed.result)
  if (result === undefined || result.ok !== true) return body
  const value = asRecord(result.value)
  if (value === undefined || !Array.isArray(value.items)) return body
  const items: Record<string, unknown>[] = []
  for (const item of value.items) {
    const row = asRecord(item)
    if (row === undefined) continue
    const ids = Array.isArray(row.sessionIds) ? row.sessionIds : []
    const visible = ids.filter(id => typeof id !== 'string' || allowed(ctx, principal, id))
    if (visible.length === 0) continue
    row.sessionIds = visible
    items.push(row)
  }
  value.items = items
  if (Array.isArray(value.archivedSessionIds)) {
    value.archivedSessionIds = value.archivedSessionIds.filter(
      id => typeof id !== 'string' || allowed(ctx, principal, id),
    )
  }
  return JSON.stringify(parsed)
}

/** session.create 成功后登记归属。 */
function claimCreated(ctx: GateContext, principal: SessionPrincipal, body: string): string {
  const parsed = parseJson(body)
  if (parsed === undefined) return body
  const result = asRecord(parsed.result)
  if (result === undefined || result.ok !== true) return body
  const value = asRecord(result.value)
  // harness 不同版本返回的会话 id 字段名可能不同，多候选兜底：
  // 常见为 value.sessionId（客户端 create() 也读这个），也可能是 value.id
  // 或 value.session.{id,sessionId}。取不到则不认领 —— 会让该会话变「无主」，
  // 而 allowed() 对管理员返回 true，管理员就能在列表/内容里看到它（这正是
  // 「只漏新增会话」的典型表现），所以这里必须尽量兜住。
  const sessionId = value === undefined ? undefined : firstString(value, [
    'sessionId',
    'id',
    'session.id',
    'session.sessionId',
  ])
  if (sessionId === undefined) {
    ctx.log(`claimCreated 未从 session.create 响应中提取到会话 id，归属未登记（响应结构可能变化）`)
    return body
  }
  ctx.store.claim(sessionId, principal.userId)
  ctx.store.save()
  return body
}

/* ── 工具 ── */

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析客户端信封；只做形状校验，业务 payload 由宿主实现自行处理。 */
function parseEnvelope(raw: string): { rpcId: string; method: string; payload: Record<string, unknown> } | undefined {
  const parsed = parseJson(raw)
  if (parsed === undefined) return undefined
  if (parsed.type !== 'client-request') return undefined
  if (typeof parsed.rpcId !== 'string' || parsed.rpcId === '') return undefined
  if (typeof parsed.method !== 'string') return undefined
  const payload = parsed.payload
  if (payload !== null && typeof payload !== 'object') return undefined
  return {
    rpcId: parsed.rpcId,
    method: parsed.method,
    payload: (payload ?? {}) as Record<string, unknown>,
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function strOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** 按多个点路径依次尝试读取第一个字符串值（兜底不同版本的字段命名）。 */
function firstString(record: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    const segments = path.split('.')
    let current: unknown = record
    let ok = true
    for (const seg of segments) {
      if (current === null || typeof current !== 'object') { ok = false; break }
      current = (current as Record<string, unknown>)[seg]
    }
    if (ok && typeof current === 'string') return current
  }
  return undefined
}

/**
 * 业务层拒绝。沿用官方约定：HTTP 状态只表达载体层，业务错误一律 200 +
 * ServerResponse 的错误分支。错误码取 bad-request —— 码表是闭合枚举，
 * 没有 unauthorized，而 internal 在部分客户端会触发重试。
 */
function rpcError(res: ServerResponse, message: string): void {
  json(res, JSON.stringify({
    type: 'server-response',
    rpcId: 'invalid-request',
    result: { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } },
  }))
}

function json(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body)
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}
