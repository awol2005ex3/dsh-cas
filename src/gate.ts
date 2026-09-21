/**
 * `/api/session/*` 的鉴权与隔离层（适配 0.1.5+ typert / gateway 架构）。
 *
 * 传输事实（harness 源码已核）：
 *   - 浏览器每次单挑 RPC 都是独立 `fetch POST /api/session/<method>`，body 为
 *     `{type:'client-request', rpcId, method, payload:{args:{按形参名键控}}}`；
 *   - 响应信封 `{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}`；
 *   - webserver 把 `/api` 注册为 prefix，指向 connection 插件的「共享 fetch handler」，
 *     它先查 `fetchRoutes`（exact pathname，经 `connection.fetch.register` 登记），
 *     未命中再走 typert gateway 的 interceptor。因此用 exact 路径
 *     `/api/session/<method>` 即可合法接管，同时拿到请求 Cookie 识别调用者。
 *
 * 真数据经 `ctx.typertGateway.invoke({namespace, method, args, signal})` 获取，
 * 返回原始业务值；业务 RemoteError 会 throw，这里 catch 后回 generic 失败信封。
 * args 不参与信封解码——参数名一致性交给 harness 的 descriptor 校验。
 */

import { principalFromFetch } from './http.js'
import type { AuthLookup } from './session-lookup.js'
import type { StateStore } from './store.js'
import type { PluginConfig, ResolvedAuthConfig, SessionPrincipal } from './types.js'

/** 单次方法访问规则。 */
interface MethodRule {
  /** 在 args.request 上承载会话 id 的字段名（单会话方法）。 */
  sessionIdField?: string
  /** 从 args.request.address 读会话 id（page / follow 等地址化方法）。 */
  addressSession?: boolean
  /** 列举类：返回后按归属过滤 item.sessionId。 */
  filter?: 'session-list'
  /** 建会话：成功后登记归属。 */
  claim?: boolean
}

/**
 * 方法规则表。刻意识别式列出：路径为 `/api/<ns>/<method>`。未列出的方法
 * 放行给 typert gateway（不含宿主会话隔离）。当前只聚焦 session 命名空间
 * （侧边栏列表泄漏的直接来源）；follow / control 走 WebSocket mux（非 HTTP
 * fetch），不在本层拦截。
 */
const METHOD_RULES: Readonly<Record<string, MethodRule>> = {
  'session/list': { filter: 'session-list' },
  'session/search': { filter: 'session-list' },
  'session/create': { claim: true },
  'session/fork': { claim: true },
  'session/selectModel': { sessionIdField: 'sessionId' },
  'session/rename': { sessionIdField: 'sessionId' },
  'session/prompt': { sessionIdField: 'sessionId' },
  'session/attachment': { sessionIdField: 'sessionId' },
  'session/updateQueue': { sessionIdField: 'sessionId' },
  'session/cancel': { sessionIdField: 'sessionId' },
  'session/page': { addressSession: true },
}

/** typert gateway 的窄化视图（只依赖 invoke，不依赖 harness 内部 schema）。 */
export interface GatewayInvoke {
  invoke: (request: {
    namespace: string
    method: string
    args: Record<string, unknown>
    signal?: AbortSignal
  }) => Promise<unknown>
}

/** `connection.fetch.register` 的窄化视图。返回的 disposer 是 `() => Promise<void>`。 */
export interface ConnectionFetchRoutes {
  register: (route: {
    path: string
    methods: readonly string[]
    requestBody: 'buffered'
    fetch: (request: Request) => Promise<Response>
  }) => () => Promise<void>
}

/** 网关依赖。 */
export interface GateContext extends AuthLookup {
  config: PluginConfig
  store: StateStore
  gateway: GatewayInvoke
  log: (message: string) => void
}

/** 注册结果。 */
export interface GateHandle {
  /** 撤销全部已登记路由。 */
  dispose: () => void
  /** 实际接管的方法清单（日志 / 自检用）。 */
  methods: readonly string[]
}

/** 单个 `/api` 路径的前缀。 */
const API_PREFIX = '/api'

/**
 * 注册会话隔离的影子路由。
 * @param ctx - 网关依赖。
 * @param route - connection.fetch 的 register（`connection.fetch.register`）。
 */
export function registerApiGate(ctx: GateContext, route: ConnectionFetchRoutes): GateHandle {
  const disposers: (() => void)[] = []
  const succeeded: string[] = []
  const failed: string[] = []

  for (const [method, rule] of Object.entries(METHOD_RULES)) {
    const sep = method.indexOf('/')
    const namespace = method.slice(0, sep)
    const name = method.slice(sep + 1)
    const path = `${API_PREFIX}/${method}`
    try {
      const dispose = route.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handleMethod(ctx, namespace, name, rule, request),
      })
      disposers.push(() => { void Promise.resolve(dispose()).catch(() => undefined) })
      succeeded.push(method)
    } catch (err) {
      // exact 路径已被抢占（例如其他插件注册了同一路径）不应拖垮整个插件，
      // 但必须显式记录——冲突意味着该方法的隔离形同虚设。
      failed.push(method)
      ctx.log(`影子化 ${method} 失败（exact Fetch 路由可能被抢占）：${String(err)}`)
    }
  }

  if (succeeded.length < Object.keys(METHOD_RULES).length) {
    ctx.log(`[严重] 会话隔离只接管了 ${succeeded.length}/${Object.keys(METHOD_RULES).length} 个方法，未接管：${failed.join(', ')}`)
  } else {
    ctx.log(`会话隔离已接管 ${succeeded.length} 个 /api/session/* 方法`)
  }

  return {
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
    methods: succeeded,
  }
}

/* ── 请求处理 ── */

/**
 * 处理一个被接管的 RPC 请求。取回原始业务值后按规则改写响应信封：
 *   filter  → 过滤 value.items
 *   claim   → 从 value.sessionId 登记归属
 *   sessionIdField / addressSession → 单会话方法先校验归属，拒绝回 error 信封
 */
async function handleMethod(
  ctx: GateContext,
  namespace: string,
  name: string,
  rule: MethodRule,
  request: Request,
): Promise<Response> {
  const principal = principalFromFetch(request, ctx)
  if (principal === undefined) {
    return new Response('unauthorized', { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('invalid client-request message')
  }

  const envelope = parseEnvelope(body)
  if (envelope === undefined || envelope.method !== `${namespace}/${name}`) {
    return errorResponse('invalid client-request message')
  }

  // 单会话方法：先按归属校验请求是否会话。
  const sessionId = sessionIdOf(rule, envelope.payload)
  if (sessionId !== undefined && !allowed(ctx, principal, sessionId)) {
    return errorResponse('无权访问该会话')
  }

  let value: unknown
  try {
    value = await ctx.gateway.invoke({
      namespace,
      method: name,
      args: envelope.payload.args ?? {},
      signal: request.signal,
    })
  } catch (err) {
    ctx.log(`${namespace}/${name} 调用失败：${String(err)}`)
    return errorResponse(`handler failure: ${String(err)}`)
  }

  // 改写响应信封。
  if (rule.filter === 'session-list') value = filterSessionList(ctx, principal, value)
  else if (rule.claim === true) value = claimCreated(ctx, principal, value)

  return fullResponse(envelope.rpcId, { ok: true, value })
}

/** 从规则与请求里取出待校验的会话 id；取不到（无会话语义）则不校验。 */
function sessionIdOf(rule: MethodRule, payload: { args?: Record<string, unknown> }): string | undefined {
  const requestObj = asRecord(payload.args?.request)
  if (rule.addressSession) {
    const address = asRecord(requestObj?.address)
    if (address === undefined) return undefined
    const sessionId = strOf(address, 'sessionId')
    if (sessionId !== undefined) return sessionId
    const parent = strOf(address, 'parentSessionId')
    const child = strOf(address, 'childSessionId')
    return child ?? parent
  }
  if (rule.sessionIdField !== undefined) {
    return strOf(requestObj ?? {}, rule.sessionIdField)
  }
  return undefined
}

/** 校验单个会话 id 是否可访问（列表 / 访问层：allowed，含历史无主策略）。 */
function allowed(ctx: { store: StateStore; auth: ResolvedAuthConfig }, principal: SessionPrincipal, sessionId: string): boolean {
  const verdict = ctx.store.verdict(sessionId, principal.userId)
  if (verdict === 'owner') return true
  if (verdict === 'other') return false
  // 本插件启用前就存在的历史无主会话：按配置策略对管理员可见。
  return ctx.auth.unownedSessions === 'everyone'
    || (ctx.auth.unownedSessions === 'admin' && principal.role === 'admin')
}

/* ── 实时事件流（WebSocket）隔离所需谓词 ──
 * 供 events-ws.ts 逐帧过滤使用。与列表层的 allowed 不同，实时流一律按「严格
 * owner」过滤：新建会话在 harness 广播 session-added 时尚处「无主」窗口，若按
 * allowed（无主对管理员可见）过滤，管理员会实时看到他人刚建的会话。因此实时流
 * 用 owned：无主会话不进任何人的实时流；历史无主会话的可见性由列表层 allowed 保留。
 */

/** 上游事件流产出的帧（与 harness 的 MuxFrame / HostFrame 同形）。 */
export interface StreamFrame {
  type: string
  rpcId: string
  method: string
  payload: Record<string, unknown>
}

/** owner 维度判定：仅当会话确属该用户。用于实时事件流过滤。 */
function owned(ctx: { store: StateStore }, principal: SessionPrincipal, sessionId: string): boolean {
  return ctx.store.verdict(sessionId, principal.userId) === 'owner'
}

/** mux 帧：带 sessionId 的按 owner 过滤；无 sessionId 的透传（如 stream/error）。 */
export function muxPredicate(
  ctx: { store: StateStore },
  principal: SessionPrincipal,
): (payload: Record<string, unknown>) => boolean {
  return (payload) => {
    const sid = payload.sessionId
    if (typeof sid !== 'string') return true
    return owned(ctx, principal, sid)
  }
}

/** host 帧：session-* 按 owner 过滤；archived / workspace 内的会话 id 列表就地裁剪。 */
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

/** 子代理会话认领：借父会话归属把子会话认领给同一用户，使实时流按 owner 过滤时子代理也能正确归属。 */
export function claimSubagentChild(ctx: { store: StateStore }, frame: StreamFrame): void {
  const p = frame.payload
  if (p?.type !== 'host/session-added') return
  const child = typeof p.sessionId === 'string' ? p.sessionId : undefined
  const parent = typeof p.parentSessionId === 'string' ? p.parentSessionId : undefined
  if (child === undefined || parent === undefined) return
  const owner = ctx.store.ownerOfSession(parent)
  if (owner === undefined) return
  ctx.store.claim(child, owner)
  ctx.store.save()
}

/* ── 响应改写 ── */

/** 过滤 session/list / session/search 的 items。 */
function filterSessionList(ctx: GateContext, principal: SessionPrincipal, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.items)) return value
  row.items = row.items.filter(item => {
    const sessionId = strOf(asRecord(item) ?? {}, 'sessionId')
    return sessionId === undefined || allowed(ctx, principal, sessionId)
  })
  return value
}

/** session.create / session.fork 成功后登记归属。 */
function claimCreated(ctx: GateContext, principal: SessionPrincipal, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const sessionId = strOf(value as Record<string, unknown>, 'sessionId')
  if (sessionId === undefined) {
    ctx.log(`未从会话创建/派生响应中提取到 sessionId，归属未登记（响应结构可能变化）`)
    return value
  }
  ctx.store.claim(sessionId, principal.userId)
  ctx.store.save()
  return value
}

/* ── 信封 ── */

/** 解析客户端请求信封（形状校验，业务 payload 交由 harness descriptor 校验）。 */
function parseEnvelope(body: unknown): { rpcId: string; method: string; payload: { args?: Record<string, unknown> } } | undefined {
  const record = asRecord(body)
  if (record === undefined || record.type !== 'client-request') return undefined
  if (typeof record.rpcId !== 'string' || record.rpcId === '') return undefined
  if (typeof record.method !== 'string') return undefined
  const payload = record.payload
  if (payload !== null && typeof payload !== 'object') return undefined
  const pl = asRecord(payload)
  const args = pl === undefined ? undefined : asRecord(pl['args'])
  return { rpcId: record.rpcId, method: record.method, payload: { args } }
}

/** 业务拒绝 / 转发失败信封。 */
function errorResponse(message: string): Response {
  return fullResponse(null, {
    ok: false,
    error: { code: 'bad-request', message, details: { issues: [] } },
  })
}

/** 完整 server-response 信封。rpcId 为 null 时（无法解析）回 invalid-request。 */
function fullResponse(rpcId: string | null, result: unknown): Response {
  return Response.json({
    type: 'server-response',
    rpcId: rpcId === null ? 'invalid-request' : rpcId,
    result,
  })
}

/* ── 工具 ── */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function strOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}