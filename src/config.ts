/**
 * 部署配置。浏览器半不引入本文件，所需结构在 client.ts 内联。
 */

import Schema from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { AuthConfig, CasConfig, PluginConfig, ResolvedAuthConfig, ResolvedCasConfig } from './types.js'

/** 与 harness `packages/util/home-paths` 一致的单根数据目录环境变量。 */
export const DSH_HOME_ENV = 'DSH_HOME'
export const DSH_HOME_DIR_NAME = '.dsh'

/** 登录态签名密钥；缺省时进程启动时随机生成（重启后需重新登录）。 */
export const ENV_SESSION_SECRET = 'DSH_SESSION_SECRET'

/** 解析 harness 单根数据目录：显式配置 > `$DSH_HOME` > `~/.dsh`。 */
export function resolveDshHome(configured?: string): string {
  const fromEnv = process.env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : joinDefaultHome())
  return resolve(expandHome(selected))
}

function joinDefaultHome(): string {
  return `${homedir()}/${DSH_HOME_DIR_NAME}`
}

/** 展开 `~` / `~/` 前缀。 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return `${homedir()}/${path.slice(2)}`
  return path
}

/** CAS 端点子对象。 */
const CasEndpointSchema = Schema.object({
  serverUrl: Schema.string().description('CAS 服务器根地址，如 http://sso.example.com。'),
  loginPath: Schema.string().default('/login').description('登录路径，相对 serverUrl。'),
  validatePath: Schema.string().default('/validate').description('ticket 验证路径，相对 serverUrl。'),
  logoutPath: Schema.string().default('/logout').description('登出路径，相对 serverUrl。'),
})

/**
 * CAS 配置。做成一个对象：schemastery 支持对象嵌套，页面可整体配置并落盘。
 * 单端点（serverUrl）与多端点（endpoints 按 IP 匹配）两种写法。
 */
export const Config = Schema.object({
  cas: Schema.object({
    serverUrl: Schema.string().description('CAS 服务器根地址，如 http://sso.example.com。留空则必须配置 endpoints。'),
    loginPath: Schema.string().default('/login').description('登录路径，相对 serverUrl。'),
    validatePath: Schema.string().default('/validate').description('ticket 验证路径，相对 serverUrl。'),
    logoutPath: Schema.string().default('/logout').description('登出路径，相对 serverUrl。'),
    servicePath: Schema.string().default('/cas/callback').description('本服务回调路径（CAS 登录后回跳的 service）。'),
    srcsys: Schema.string().description('登录时附带的 srcsys 参数（可空）。'),
    endpoints: Schema.array(Schema.object({
      ipPattern: Schema.string().description('客户端 IP 匹配模式，支持 % 通配（如 10.251.%、192.168.%）。'),
      serverUrl: Schema.string().description('CAS 服务器根地址，如 http://sso.example.com。'),
      loginPath: Schema.string().default('/login').description('登录路径，相对 serverUrl。'),
      validatePath: Schema.string().default('/validate').description('ticket 验证路径，相对 serverUrl。'),
      logoutPath: Schema.string().default('/logout').description('登出路径，相对 serverUrl。'),
    })).description('按客户端 IP 匹配的多端点表，首个匹配生效。'),
    tlsRejectUnauthorized: Schema.boolean().default(true).description('校验 CAS 服务器证书；自签内网 CAS 可关闭。'),
    maxResponseBytes: Schema.number().default(64 * 1024).description('ticket 验证响应的最大字节数。'),
    adminUsernames: Schema.array(Schema.string()).description('映射为管理员（admin）的 CAS 用户名列表。'),
    sessionTtlSeconds: Schema.number().description('CAS 登录态有效期（秒）；缺省用 auth.sessionTtlSeconds。'),
  }).description('CAS 单点登录配置，页面可配置并落盘。'),
  auth: Schema.object({
    sessionTtlSeconds: Schema.number().default(60 * 60 * 12).description('登录态有效期（秒）。'),
    cookieName: Schema.string().default('dsh_cas_user').description('登录态 cookie 名。'),
    cookieSameSite: Schema.union(['lax', 'strict'] as const).default('lax').description('cookie 的 SameSite 策略。'),
    unownedSessions: Schema.union(['admin', 'everyone', 'none'] as const).default('admin').description(
      '未被认领的历史会话如何处置：admin 仅管理员可见，everyone 所有人可见，none 任何人都看不到。',
    ),
    adminOnlyMethods: Schema.array(Schema.string()).description('额外限定管理员才能调用的 /api 方法。'),
  }).description('登录态与会话策略。'),
  enforce: Schema.boolean().default(true).description('启用 /api 方法鉴权与会话隔离；关闭后仅提供 CAS 登录。'),
})

/** 鉴权设置的默认值（config 里 auth 为 Partial）。 */
export const DEFAULT_AUTH: ResolvedAuthConfig = {
  sessionTtlSeconds: 60 * 60 * 12,
  cookieName: 'dsh_cas_user',
  cookieSameSite: 'lax',
  unownedSessions: 'admin',
  adminOnlyMethods: [],
}

/** 合并出完整鉴权设置。 */
export function resolveAuth(auth: Partial<AuthConfig> | undefined): ResolvedAuthConfig {
  return {
    sessionTtlSeconds: auth?.sessionTtlSeconds ?? DEFAULT_AUTH.sessionTtlSeconds,
    cookieName: auth?.cookieName ?? DEFAULT_AUTH.cookieName,
    cookieSameSite: auth?.cookieSameSite ?? DEFAULT_AUTH.cookieSameSite,
    unownedSessions: auth?.unownedSessions ?? DEFAULT_AUTH.unownedSessions,
    adminOnlyMethods: auth?.adminOnlyMethods ?? DEFAULT_AUTH.adminOnlyMethods,
  }
}

/** 合并出完整的 CAS 设置（默认值已填充）。 */
export function resolveCas(cas: CasConfig | undefined, auth: ResolvedAuthConfig): ResolvedCasConfig {
  return {
    ...(cas === undefined ? {} : cas),
    loginPath: cas?.loginPath ?? '/login',
    validatePath: cas?.validatePath ?? '/validate',
    logoutPath: cas?.logoutPath ?? '/logout',
    servicePath: cas?.servicePath ?? '/cas/callback',
    tlsRejectUnauthorized: cas?.tlsRejectUnauthorized ?? true,
    maxResponseBytes: cas?.maxResponseBytes ?? 64 * 1024,
    validateTimeoutMs: 10_000,
    adminUsernames: cas?.adminUsernames ?? [],
    sessionTtlSeconds: cas?.sessionTtlSeconds ?? auth.sessionTtlSeconds,
  }
}

/** 解析后的完整 CAS 连接面（ResolvedCasConfig 的工具型别名）。 */
export type ResolvedCas = ResolvedCasConfig

/** 导出 ResolvedCasConfig 供 http.ts 等模块 import。 */
export type { ResolvedCasConfig } from './types.js'

/**
 * 内置的管理员专属方法（叠加在配置之上）：涉及宿主全局配置与本机副作用，
 * 普通用户不应触达。
 */
export const BUILTIN_ADMIN_ONLY_METHODS: readonly string[] = [
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'settings.openDocument',
  'credentials.set',
  'credentials.unset',
  'credentials.describe',
  'host.openPath',
  'host.createDirectory',
  'agentPreset.remove',
  'agentPreset.copy',
  'agentPreset.openDocument',
]

/**
 * 校验配置是否可用。返回校验结果而非直接抛异常——缺少配置时插件仍可加载，
 * 仅降级不启用 enforce（用户可在页面配置面板中补全）。
 */
export function validateConfig(config: PluginConfig): { valid: boolean; reason?: string } {
  const cas = config.cas
  if (cas === undefined) {
    return { valid: false, reason: '缺少 cas 配置' }
  }
  const hasServer = cas.serverUrl !== undefined && cas.serverUrl.trim() !== ''
  const hasEndpoints = Array.isArray(cas.endpoints) && cas.endpoints.length > 0
  if (!hasServer && !hasEndpoints) {
    return { valid: false, reason: '需要配置 cas.serverUrl 或 cas.endpoints' }
  }
  if (cas.servicePath !== undefined && (cas.servicePath.trim() === '' || !cas.servicePath.startsWith('/'))) {
    return { valid: false, reason: 'cas.servicePath 必须是 / 开头的路径' }
  }
  return { valid: true }
}

/** 登录态签名密钥；缺省随机生成（重启后已发 cookie 失效，需重新登录）。 */
export function readSessionSecret(): string {
  const fromEnv = process.env[ENV_SESSION_SECRET]
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : randomSecret()
}

function randomSecret(): string {
  return randomBytes(32).toString('hex')
}