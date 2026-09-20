/**
 * 共享类型与插件配置接口。宿主半与插件内部共用；浏览器半不引入本文件
 * （client.ts 刻意无 import，所需类型在其内部重复声明）。
 */

/** 用户角色。CAS 不返回角色，由管理员用户名列表映射。 */
export type UserRole = 'admin' | 'user'

/**
 * 用户来源：仅 CAS 单点登录。
 * 会话归属以 CAS 用户名为键，与 dsh-user-manager 的 userId 等价。
 */
export type UserSource = 'cas'

/** CAS 登录页 / 验证 / 登出的地址组。 */
export interface CasEndpoints {
  /** 登录页地址，如 http://sso.example.com/login 。 */
  loginUrl?: string
  /** ticket 验证地址，如 http://sso.example.com/validate 。 */
  validateUrl?: string
  /** 登出页地址，如 http://sso.example.com/logout 。 */
  logoutUrl?: string
}

/** 一条多端点匹配规则（参考 data-ai-openai-server 的 SSO_LOGIN_CLIENT_IP/SSO_LOGIN_URL）。 */
export interface CasEndpointRow {
  ipPattern: string
  serverUrl: string
  /** 覆盖默认 loginPath。 */
  loginPath?: string
  /** 覆盖默认 validatePath。 */
  validatePath?: string
  /** 覆盖默认 logoutPath。 */
  logoutPath?: string
  /** 直接指定完整登录 URL（优先级高于 serverUrl+loginPath）。 */
  loginUrl?: string
  /** 直接指定完整验证 URL（优先级高于 serverUrl+validatePath）。 */
  validateUrl?: string
  /** 直接指定完整登出 URL（优先级高于 serverUrl+logoutPath）。 */
  logoutUrl?: string
}

/** CAS 连接与映射配置。支持两种写法：
  *   - 单端点：填 `serverUrl`，插件按 loginPath / validatePath / logoutPath 拼接；
  *   - 多端点（按客户端 IP 匹配，参考 data-ai-openai-server）：
  *     填 `endpoints` 表与 `clientIpPatterns`（`|` 分隔，支持 % 通配），首个匹配生效。
  */
export interface CasConfig extends CasEndpoints {
  /** CAS 服务器根地址，如 http://sso.example.com 。 */
  serverUrl?: string
  /** 登录路径（相对 serverUrl，默认 /login）。 */
  loginPath?: string
  /** 验证路径（相对 serverUrl，默认 /validate）。 */
  validatePath?: string
  /** 登出路径（相对 serverUrl，默认 /logout）。 */
  logoutPath?: string
  /** 本服务回调路径（CAS 登录后回跳的 service，默认 /cas/callback）。 */
  servicePath?: string
  /** 登录时附带的 srcsys 参数，可空。 */
  srcsys?: string
  /** 按客户端 IP 匹配的多端点表；ipPattern 支持 % 通配，首个匹配生效。 */
  endpoints?: CasEndpointRow[]
  /** 是否校验 CAS 服务器证书；自签内网 CAS 可关闭。 */
  tlsRejectUnauthorized?: boolean
  /** ticket 验证响应的最大字节数。 */
  maxResponseBytes?: number
  /** 映射为管理员（admin）的用户名列表（精确匹配）。 */
  adminUsernames?: string[]
  /** 登录态有效期（秒）。 */
  sessionTtlSeconds?: number
}

/** 鉴权与会话策略（与 dsh-user-manager 对齐）。 */
export interface AuthConfig {
  /** 登录态有效期（秒）。 */
  sessionTtlSeconds: number
  /** 登录态 cookie 名。 */
  cookieName: string
  /** cookie 的 SameSite 策略。 */
  cookieSameSite: 'lax' | 'strict'
  /** 未被任何用户认领的历史会话如何处置。 */
  unownedSessions: 'admin' | 'everyone' | 'none'
  /** 额外禁止普通用户调用的 /api 方法（管理员不受限）。 */
  adminOnlyMethods: string[]
}

/** 插件配置（经 schemastery 校验）。 */
export interface PluginConfig {
  cas?: CasConfig
  auth?: Partial<AuthConfig>
  /** 是否启用 /api 方法鉴权与会话隔离；关闭后仅提供 CAS 登录。 */
  enforce: boolean
}

/** 解析后的完整鉴权设置（默认值已填充）。 */
export type ResolvedAuthConfig = Required<AuthConfig>

/** 登录成功后写入的会话主体。 */
export interface SessionPrincipal {
  /** 用户 id（CAS 用户名）。 */
  userId: string
  username: string
  displayName: string
  role: UserRole
  source: UserSource
  /** 过期时间（epoch 毫秒）。 */
  expiresAt: number
}

/** CAS 服务器端点解析结果。 */
export interface CasServer {
  loginUrl: string
  validateUrl: string
  logoutUrl?: string
}
/** 解析后的完整 CAS 配置（默认值已填充）。 */
export interface ResolvedCasConfig {
  serverUrl?: string
  loginPath: string
  validatePath: string
  logoutPath: string
  servicePath: string
  srcsys?: string
  endpoints?: CasEndpointRow[]
  tlsRejectUnauthorized: boolean
  maxResponseBytes: number
  /** ticket 验证超时（毫秒）。 */
  validateTimeoutMs: number
  adminUsernames: string[]
  sessionTtlSeconds: number
}