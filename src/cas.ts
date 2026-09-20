/**
 * CAS 客户端：构造登录 / 登出 URL、按客户端 IP 匹配端点、验证 ticket。
 *
 * 协议采用 CAS 2.0 的 `validate` 端点（与 data-ai-openai-server 前端一致）：
 *   GET /validate?service=<service>&ticket=<ticket>&renew=false
 *   → "yes\n<username>\n" 表示验证通过，否则 "no\n\n"。
 */

import https from 'node:https'
import type { CasConfig, CasServer, ResolvedCasConfig } from './types.js'

/** 登录 URL 需要的必填参数。 */
export interface LoginUrlOptions {
  /** 客户单 IP（多端点匹配用；单端点可省略）。 */
  clientIp?: string
  /** CAS 登录后回跳的 service 地址。 */
  service: string
}

/** 解析出的 CAS 服务器端点。 */
export interface ResolvedEndpoints {
  loginUrl: string
  validateUrl: string
  logoutUrl?: string
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** 拼接端点：serverUrl + path。 */
function endpointOf(serverUrl: string, path: string): string {
  return `${trimSlash(serverUrl)}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 把 IP 与 `|` 分隔的匹配模式做检查：模式支持 % 通配（如 "10.251.%"），
 * 按顺序首个匹配生效。
 */
export function ipMatchesPattern(ip: string, pattern: string): boolean {
  const regexStr =
    '^' +
    pattern
      .split('%')
      .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*') +
    '$'
  return new RegExp(regexStr).test(ip)
}

/**
 * 解析单条端点（serverUrl 写法），对缺省的 loginPath 等用默认值。
 */
export function resolveEndpoints(cas: CasConfig | ResolvedCasConfig): ResolvedEndpoints {
  const serverUrl = cas.serverUrl
  if (serverUrl === undefined || serverUrl.trim() === '') {
    throw new Error('缺少 cas.serverUrl（或按客户端 IP 的 endpoints 表）')
  }
  const loginPath = cas.loginPath ?? '/login'
  const validatePath = cas.validatePath ?? '/validate'
  const logoutPath = cas.logoutPath ?? '/logout'
  return {
    loginUrl: endpointOf(serverUrl, loginPath),
    validateUrl: endpointOf(serverUrl, validatePath),
    logoutUrl: endpointOf(serverUrl, logoutPath),
  }
}

/** 从请求 IP 匹配 endpoints 表（参考 data-ai-openai-server 的 SSO_LOGIN_CLIENT_IP / SSO_LOGIN_URL）。 */
export function resolveEndpointsByClientIp(cas: CasConfig | ResolvedCasConfig, clientIp: string): ResolvedEndpoints | undefined {
  const table = cas.endpoints
  if (table === undefined || table.length === 0) return undefined
  for (const row of table) {
    if (row.ipPattern === undefined || row.serverUrl === undefined) continue
    if (!ipMatchesPattern(clientIp, row.ipPattern)) continue
    return {
      loginUrl: row.loginUrl ?? endpointOf(row.serverUrl, row.loginPath ?? '/login'),
      validateUrl: row.validateUrl ?? endpointOf(row.serverUrl, row.validatePath ?? '/validate'),
      logoutUrl: row.logoutUrl ?? endpointOf(row.serverUrl, row.logoutPath ?? '/logout'),
    }
  }
  return undefined
}

/** 取当前请求应使用的 CAS 服务器端点。 */
export function pickCasServer(cas: ResolvedCasConfig, clientIp?: string): ResolvedEndpoints {
  if (clientIp !== undefined && clientIp !== '') {
    const matched = resolveEndpointsByClientIp(cas, clientIp)
    if (matched !== undefined) return matched
  }
  return resolveEndpoints(cas)
}

/** 构造 CAS 登录 URL：`{loginUrl}?srcsys=<srcsys>&service=<service>`。 */
export function buildLoginUrl(endpoints: ResolvedEndpoints, service: string, srcsys?: string): string {
  const sep = endpoints.loginUrl.includes('?') ? '&' : '?'
  const params = [`service=${encodeURIComponent(service)}`]
  if (srcsys !== undefined && srcsys !== '') params.push(`srcsys=${encodeURIComponent(srcsys)}`)
  return `${endpoints.loginUrl}${sep}${params.join('&')}`
}

/** 构造 CAS 登出 URL：`{logoutUrl}?service=<service>`。 */
export function buildLogoutUrl(endpoints: ResolvedEndpoints, service?: string): string | undefined {
  const base = endpoints.logoutUrl
  if (base === undefined || base === '') return undefined
  if (service === undefined || service === '') return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}service=${encodeURIComponent(service)}`
}

/** 构造 ticket 验证 URL（CAS 2.0 validate）。 */
export function buildValidateUrl(endpoints: ResolvedEndpoints, service: string, ticket: string): string {
  const sep = endpoints.validateUrl.includes('?') ? '&' : '?'
  return `${endpoints.validateUrl}${sep}service=${encodeURIComponent(service)}&ticket=${encodeURIComponent(ticket)}&renew=false`
}

/**
 * 验证 CAS ticket。
 * @returns 验证通过返回用户名，失败返回 null。
 */
export async function validateTicket(
  endpoints: ResolvedEndpoints,
  service: string,
  ticket: string,
  cas: ResolvedCasConfig,
): Promise<string | null> {
  const url = buildValidateUrl(endpoints, service, ticket)
  const maxBytes = cas.maxResponseBytes ?? 64 * 1024

  let agent: https.Agent | undefined
  if (cas.tlsRejectUnauthorized === false) {
    agent = new https.Agent({ rejectUnauthorized: false })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cas.validateTimeoutMs ?? 10_000)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/plain' },
      signal: controller.signal,
      ...(agent === undefined ? {} : { dispatcher: undefined }),
      // undici 暂不支持直接传 node https.Agent；这里用 Agent 代替 dispatcher。
    } as RequestInit & { agent?: https.Agent })
    if (agent !== undefined) {
      // 走 node:https 的 get（支持 rejectUnauthorized）—— fetch 的 dispatcher 无法传 https.Agent。
      return await fetchViaHttps(url, agent, maxBytes)
    }
  } finally {
    clearTimeout(timer)
  }

  if (!response!.ok) return null
  const text = await (response as Response).text()
  return parseValidateResponse(text)
}

/** 走 node:https 验证（支持忽略自签证书）。 */
function fetchViaHttps(url: string, agent: https.Agent, maxBytes: number): Promise<string | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.get(url, { agent }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', chunk => {
        const buffer = chunk as Buffer
        size += buffer.length
        if (size > maxBytes) {
          request.destroy()
          resolvePromise(null)
          return
        }
        chunks.push(buffer)
      })
      res.on('end', () => {
        resolvePromise(parseValidateResponse(Buffer.concat(chunks).toString('utf8')))
      })
    })
    request.on('error', err => rejectPromise(err))
  })
}

/** 解析 CAS 2.0 validate 文本响应：首行 yes 且第二行为用户名。 */
export function parseValidateResponse(text: string): string | null {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return null
  if (lines[0]?.trim() !== 'yes') return null
  const username = lines[1]?.trim()
  return username !== undefined && username !== '' ? username : null
}