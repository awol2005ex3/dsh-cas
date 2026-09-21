/**
 * `/cas/*` 自控路由。走 `ctx.webServer.register` 的原生 HTTP 面。
 *
 * 路由清单：
 *   GET  /cas/login             → 302 到 CAS 登录页
 *   GET  /cas/callback          → CAS 回跳验证（ticket → 本地会话）
 *   POST /cas/logout            → 吊销 + 登出（可选跳 CAS 登出页）
 *   GET  /cas/me                → 当前登录态
 *   GET  /cas/connection        → 查看 CAS 配置（管理员）
 *   POST /cas/connection        → 保存配置并切换（管理员）
 *   POST /cas/connection/test   → 测试连接（管理员）
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { issueToken, readCookie, serializeCookie, verifyToken } from './auth.js'
import { buildLoginUrl, buildLogoutUrl, pickCasServer, validateTicket } from './cas.js'
import type { AuthLookup } from './session-lookup.js'
import type { ResolvedCasConfig } from './config.js'
import type { CasConfig, PluginConfig, ResolvedAuthConfig, SessionPrincipal } from './types.js'

/** 请求体上限：本插件的载荷都很小。 */
const MAX_BODY_BYTES = 64 * 1024

/** CAS 回调的 ticket 缓存 TTL（防止 CAS 服务器重复验证导致重放拒绝）。 */
const TICKET_CACHE_TTL_MS = 60_000

/** ticket → { username, timestamp } */
const ticketCache = new Map<string, { username: string; ts: number }>()

/* ── 路由依赖 ── */

export interface RouteContext {
  config: PluginConfig
  cas: ResolvedCasConfig
  auth: ResolvedAuthConfig
  secret: string
  getApiProxy?: () => { events?: EventsProxy } | undefined
  /** 当前 CAS 配置（页面保存的覆盖 profile 配置）。 */
  getCasConfig: () => CasConfig | undefined
  /** 保存 CAS 配置。 */
  setCasConfig: (cas: CasConfig) => void
  /** 登记一次签发，用于后续按用户批量吊销。 */
  track: (jti: string, userId: string, expiresAt: number) => void
  /** 票据是否已被吊销。 */
  isRevoked: (jti: string) => boolean
  /** 让某用户的所有登录态失效。 */
  revokeUser: (userId: string) => void
  log: (message: string) => void
}

/** 事件流窄化（供 /cas/connection/test 用）。 */
interface EventsProxy {
  mux: (request: { rpcId: string; payload: Record<string, unknown> }, signal: AbortSignal) => AsyncIterable<unknown>
  host: (request: { rpcId: string; payload: Record<string, unknown> }, signal: AbortSignal) => AsyncIterable<unknown>
}

/* ── 基础工具 ── */

/** 从 Host 请求头获取客户端实际 origin。 */
export function getRealOrigin(req: IncomingMessage): string {
  const host = req.headers.host
  if (host) return `http://${host}`
  return 'http://localhost'
}

/** 获取客户端真实 IP（经代理访问时优先取 X-Forwarded-For 的首个地址）。 */
function getClientIp(req: IncomingMessage): string {
  const forwardedRaw = req.headers['x-forwarded-for']
  const forwarded = Array.isArray(forwardedRaw) ? forwardedRaw[0] : forwardedRaw
  let ip = forwarded
    ? forwarded.split(',')[0]?.trim() ?? ''
    : (req.headers['x-real-ip'] as string | undefined) ?? ''
  if (ip === '' && req.socket?.remoteAddress !== undefined) {
    ip = req.socket.remoteAddress
  }
  // 去除 IPv4 映射的 IPv6 前缀（如 ::ffff:10.110.149.64）
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  return ip
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' })
  res.end()
}

/** 从请求解析登录主体；无效返回 undefined。 */
export function principalFromRequest(
  req: IncomingMessage,
  ctx: AuthLookup,
): SessionPrincipal | undefined {
  const token = readCookie(req.headers.cookie, ctx.auth.cookieName)
  if (token === undefined) return undefined
  return verifyToken(token, {
    auth: ctx.auth,
    secret: ctx.secret,
    revoked: ctx.isRevoked,
  })
}

/**
 * 从标准 `Request`（`connection.fetch` 路由）解析登录主体；无效返回 undefined。
 * fetch 路由拿不到原生 IncomingMessage，改从 `request.headers` 取 Cookie。
 */
export function principalFromFetch(
  request: Request,
  ctx: AuthLookup,
): SessionPrincipal | undefined {
  const token = readCookie(request.headers.get('cookie') ?? undefined, ctx.auth.cookieName)
  if (token === undefined) return undefined
  return verifyToken(token, {
    auth: ctx.auth,
    secret: ctx.secret,
    revoked: ctx.isRevoked,
  })
}

function setSessionCookie(res: ServerResponse, ctx: RouteContext, token: string, maxAge: number): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(ctx.auth.cookieName, token, { maxAge, sameSite: ctx.auth.cookieSameSite }),
  )
}

function clearSessionCookie(res: ServerResponse, ctx: RouteContext): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(ctx.auth.cookieName, '', { maxAge: 0, sameSite: ctx.auth.cookieSameSite }),
  )
}

function strField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

/* ── CAS 回调 ── */

function getTicketCacheKey(ticket: string): string {
  return `cas:${ticket}`
}

function extractUsernameFromCache(ticket: string): string | undefined {
  const key = getTicketCacheKey(ticket)
  const entry = ticketCache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.ts > TICKET_CACHE_TTL_MS) {
    ticketCache.delete(key)
    return undefined
  }
  return entry.username
}

function setTicketCache(ticket: string, username: string): void {
  ticketCache.set(getTicketCacheKey(ticket), { username, ts: Date.now() })
  // 清理过期缓存防止内存泄漏
  if (ticketCache.size > 1000) cleanupTicketCache()
}

function cleanupTicketCache(): void {
  const now = Date.now()
  for (const [key, entry] of ticketCache) {
    if (now - entry.ts > TICKET_CACHE_TTL_MS) ticketCache.delete(key)
  }
}

/* ── 路由注册 ── */

/** 精确路由注册函数（与 gate.ts 的 RouteRegistrar 同形）。 */
export type RouteRegistrar = (route: {
  kind: 'exact'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}) => () => void

/** 宿主路由表里 handler 的签名（与 gate.ts 的 unknown 版本同形）。 */
type HostHandler = (req: unknown, res: unknown) => void | Promise<void>

/** 注册 `/cas/*`。精确路径，不与 /api 前缀冲突。 */
export function registerCasRoutes(ctx: RouteContext, register: RouteRegistrar): () => void {
  const disposers: (() => void)[] = []
  const mount = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): void => {
    disposers.push(register({
      kind: 'exact',
      path,
      handler: handler as unknown as HostHandler,
    }))
  }

  /* ── CAS 登录跳转 ── */

  mount('/cas/login', async (req, res) => {
    if (req.method !== 'GET') return sendText(res, 405, 'method not allowed')

    // 已登录直接放行
    const principal = principalFromRequest(req, ctx)
    if (principal !== undefined) {
      const redirectTarget = new URL(req.url ?? '/', 'http://x').searchParams.get('redirect') || '/'
      return redirect(res, redirectTarget)
    }

    const origin = getRealOrigin(req)
    const service = `${origin}${ctx.cas.servicePath}`

    // 记住 redirect
    const queryRedirect = new URL(req.url ?? '/', 'http://x').searchParams.get('redirect')
    if (queryRedirect !== null && queryRedirect !== '') {
      res.setHeader('Set-Cookie', serializeCookie('dsh_cas_rd', queryRedirect, {
        maxAge: 300, sameSite: 'lax', path: '/cas/callback',
      }))
    }

    if (ctx.cas.serverUrl === undefined || ctx.cas.serverUrl.trim() === '') {
      return sendText(res, 503, 'CAS 服务器尚未配置，请在设置页面中完成配置')
    }

    const clientIp = getClientIp(req)
    const endpoints = pickCasServer(ctx.cas, clientIp)
    const casLoginUrl = buildLoginUrl(endpoints, service, ctx.cas.srcsys)
    return redirect(res, casLoginUrl)
  })

  /* ── CAS 回调 ── */

  mount('/cas/callback', async (req, res) => {
    if (req.method !== 'GET') return sendText(res, 405, 'method not allowed')

    const parsedUrl = new URL(req.url ?? '/', 'http://x')
    const ticket = parsedUrl.searchParams.get('ticket')
    const origin = getRealOrigin(req)
    const service = `${origin}${ctx.cas.servicePath}`

    if (!ticket) {
      // 无 ticket 跳转首页，让遮罩重新触发登录
      return redirect(res, '/')
    }

    if (ctx.cas.serverUrl === undefined || ctx.cas.serverUrl.trim() === '') {
      ctx.log('CAS 服务器未配置，无法验证 ticket')
      return redirect(res, '/')
    }

    // 检查缓存
    let username = extractUsernameFromCache(ticket)

    // 缓存未命中则远程验证
    if (username === undefined) {
      const clientIp = getClientIp(req)
      const endpoints = pickCasServer(ctx.cas, clientIp)
      try {
        const result = await validateTicket(endpoints, service, ticket, ctx.cas)
        username = result ?? undefined
      } catch (err) {
        ctx.log(`CAS ticket 验证异常：${String(err)}`)
      }
    }

    if (username === undefined || username === '') {
      // 验证失败，踢回 CAS 登录页
      ctx.log(`CAS ticket 验证失败：ticket=${ticket.slice(0, 20)}...`)
      const clientIp = getClientIp(req)
      const endpoints = pickCasServer(ctx.cas, clientIp)
      const casLoginUrl = buildLoginUrl(endpoints, service, ctx.cas.srcsys)
      return redirect(res, casLoginUrl)
    }

    // 验证成功，缓存结果
    setTicketCache(ticket, username)

    // 判断角色
    const adminUsernames = ctx.cas.adminUsernames
    const isAdmin = Array.isArray(adminUsernames) && adminUsernames.some(
      u => u.toLowerCase() === username.toLowerCase(),
    )

    // 签发本地会话
    const { token, principal, jti } = issueToken(
      {
        userId: username,
        username,
        displayName: username,
        role: isAdmin ? 'admin' : 'user',
        source: 'cas',
      },
      ctx.auth,
      ctx.secret,
    )
    ctx.track(jti, username, principal.expiresAt)
    setSessionCookie(res, ctx, token, ctx.auth.sessionTtlSeconds)

    // 读取之前保存的 redirect
    const rdCookie = readCookie(req.headers.cookie, 'dsh_cas_rd')
    const redirectPath = rdCookie || '/'
    // 清除 redirect cookie
    const clearCookie = serializeCookie('dsh_cas_rd', '', { maxAge: 0, sameSite: 'lax', path: '/cas/callback' })
    const existing = res.getHeader('Set-Cookie')
    if (typeof existing === 'string') {
      res.setHeader('Set-Cookie', [existing, clearCookie])
    } else if (Array.isArray(existing)) {
      res.setHeader('Set-Cookie', [...existing, clearCookie])
    }

    return redirect(res, redirectPath)
  })

  /* ── 登出 ── */

  mount('/cas/logout', async (req, res) => {
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')

    const principal = principalFromRequest(req, ctx)
    if (principal !== undefined) ctx.revokeUser(principal.userId)
    clearSessionCookie(res, ctx)

    // 可选跳转 CAS 登出
    const url = new URL(req.url ?? '/', 'http://x')
    const skipCas = url.searchParams.get('skipCas') === 'true'
    if (!skipCas && (ctx.cas.logoutPath ?? '/logout') !== '') {
      try {
        const clientIp = getClientIp(req)
        const endpoints = pickCasServer(ctx.cas, clientIp)
        const origin = getRealOrigin(req)
        const service = `${origin}${ctx.cas.servicePath}`
        const logoutUrl = buildLogoutUrl(endpoints, service)
        if (logoutUrl !== undefined) {
          // 同时设置 redirect cookie 给外部登出页
          return sendJson(res, 200, { ok: true, logoutUrl })
        }
      } catch { /* skip CAS server logout */ }
    }

    return sendJson(res, 200, { ok: true })
  })

  /* ── 当前用户 ── */

  mount('/cas/me', async (req, res) => {
    if (req.method !== 'GET') return sendText(res, 405, 'method not allowed')
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })
    return sendJson(res, 200, {
      ok: true,
      user: principal,
      enforce: ctx.config.enforce,
    })
  })

  /* ── CAS 连接配置（管理员） ── */

  mount('/cas/connection', async (req, res) => {
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })

    if (req.method === 'GET') {
      const config = ctx.getCasConfig() ?? {
        serverUrl: ctx.cas.serverUrl,
        loginPath: ctx.cas.loginPath,
        validatePath: ctx.cas.validatePath,
        logoutPath: ctx.cas.logoutPath,
        servicePath: ctx.cas.servicePath,
        srcsys: ctx.cas.srcsys,
        adminUsernames: ctx.cas.adminUsernames,
        tlsRejectUnauthorized: ctx.cas.tlsRejectUnauthorized,
      }
      return sendJson(res, 200, { ok: true, cas: config })
    }

    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    if (principal.role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })

    const body = await readJsonBody(req)
    if (body === undefined) return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })

    const casConfig: CasConfig = {
      serverUrl: strField(body, 'serverUrl'),
      loginPath: strField(body, 'loginPath') || '/login',
      validatePath: strField(body, 'validatePath') || '/validate',
      logoutPath: strField(body, 'logoutPath') || '/logout',
      servicePath: strField(body, 'servicePath') || '/cas/callback',
      srcsys: strField(body, 'srcsys'),
      adminUsernames: Array.isArray(body.adminUsernames) ? body.adminUsernames.filter(
        (u: unknown) => typeof u === 'string',
      ) as string[] : undefined,
      tlsRejectUnauthorized: body.tlsRejectUnauthorized !== false,
    }
    ctx.setCasConfig(casConfig)

    return sendJson(res, 200, { ok: true })
  })

  /* ── 测试连接 ── */

  mount('/cas/connection/test', async (req, res) => {
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })
    if (principal.role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })

    const body = await readJsonBody(req)
    if (body === undefined) return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })

    const testCas: ResolvedCasConfig = {
      ...ctx.cas,
      serverUrl: strField(body, 'serverUrl') || ctx.cas.serverUrl,
      loginPath: strField(body, 'loginPath') || ctx.cas.loginPath,
      validatePath: strField(body, 'validatePath') || ctx.cas.validatePath,
      logoutPath: strField(body, 'logoutPath') || ctx.cas.logoutPath,
      servicePath: strField(body, 'servicePath') || ctx.cas.servicePath,
      srcsys: strField(body, 'srcsys') || ctx.cas.srcsys,
      adminUsernames: Array.isArray(body.adminUsernames) ? body.adminUsernames.filter(
        (u: unknown) => typeof u === 'string',
      ) as string[] : ctx.cas.adminUsernames,
      tlsRejectUnauthorized: body.tlsRejectUnauthorized !== false ? true : (ctx.cas.tlsRejectUnauthorized),
      maxResponseBytes: ctx.cas.maxResponseBytes,
      validateTimeoutMs: ctx.cas.validateTimeoutMs,
      sessionTtlSeconds: ctx.cas.sessionTtlSeconds,
    }

    // 测试：用已知 service 和假 ticket 测试连接。CAS 服务器应返回 no。
    try {
      const endpoints = pickCasServer(testCas)
      const service = `http://test-connection${testCas.servicePath}`
      const result = await validateTicket(endpoints, service, '__test__', testCas)
      // 预期返回 null（错误 ticket），但只要能连上就算成功
      return sendJson(res, 200, { ok: true, message: '连接成功' })
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: `连接 CAS 服务器失败：${String(err)}` })
    }
  })

  /* ── 独立登录页 ── */

  mount('/cas/login.html', async (_req, res) => {
    const response = res as {
      writeHead: (status: number, headers: Record<string, string>) => void
      end: (body: string) => void
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(renderCasLoginPage())
  })

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ── 独立 CAS 登录中转页 ── */

function renderCasLoginPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CAS 登录 · dsh-cas</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#16181d; color:#e6e6e6;
    font:14px/1.6 -apple-system,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif; }
  .card { width:380px; padding:28px; background:#1e2128; border:1px solid #2e323b; border-radius:12px; text-align:center; }
  h1 { margin:0 0 12px; font-size:17px; font-weight:600; }
  p { margin:0 0 20px; font-size:12px; color:#8b919c; }
  button { width:100%; padding:10px; font-size:14px; cursor:pointer;
    background:#4d7cfe; color:#fff; border:none; border-radius:8px; }
  button:hover { background:#5c88ff; }
</style>
</head>
<body>
<div class="card">
  <h1>DeepSeek Harness</h1>
  <p>正在跳转至统一身份认证（CAS）…</p>
  <button id="btn" onclick="location.href='/cas/login'">前往 CAS 登录</button>
</div>
<script>location.href='/cas/login';</script>
</body>
</html>
`
}