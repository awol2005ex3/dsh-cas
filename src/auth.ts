/**
 * 登录态票据。CAS 负责认证，本插件只负责签发/校验登录态：
 * HMAC-SHA256 签名的无状态票据存于 HttpOnly Cookie，同时保留一份内存副本
 * 以便吊销（登出、删除用户等价场景）。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ResolvedAuthConfig, SessionPrincipal, UserRole, UserSource } from './types.js'

/** 票据明文部分（签名前）。 */
interface TokenPayload extends SessionPrincipal {
  /** 票据 id，用于服务端吊销。 */
  jti: string
}

/** 登录态票据：<base64url(payload)>.<base64url(hmac)>。 */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/** 签发一张登录态票据。 */
export function issueToken(
  input: { userId: string; username: string; displayName: string; role: UserRole; source: UserSource },
  auth: ResolvedAuthConfig,
  secret: string,
): { token: string; principal: SessionPrincipal; jti: string } {
  const now = Date.now()
  const jti = randomBytes(16).toString('base64url')
  const payload: TokenPayload = {
    userId: input.userId,
    username: input.username,
    displayName: input.displayName,
    role: input.role,
    source: input.source,
    expiresAt: now + auth.sessionTtlSeconds * 1000,
    jti,
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return {
    token: `${body}.${sign(body, secret)}`,
    principal: {
      userId: payload.userId,
      username: payload.username,
      displayName: payload.displayName,
      role: payload.role,
      source: payload.source,
      expiresAt: payload.expiresAt,
    },
    jti,
  }
}

/** 校验票据签名、有效期与吊销状态；任一不满足返回 undefined。 */
export function verifyToken(
  token: string,
  opts: { auth: ResolvedAuthConfig; secret: string; revoked: (jti: string) => boolean },
): SessionPrincipal | undefined {
  const dot = token.indexOf('.')
  if (dot <= 0) return undefined
  const body = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  const expected = sign(body, opts.secret)
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signature, 'utf8')
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return undefined
  }
  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload
  } catch {
    return undefined
  }
  if (typeof payload?.jti !== 'string' || typeof payload.userId !== 'string') return undefined
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) return undefined
  if (opts.revoked(payload.jti)) return undefined
  return {
    userId: payload.userId,
    username: payload.username,
    displayName: payload.displayName,
    role: payload.role === 'admin' ? 'admin' : 'user',
    source: 'cas',
    expiresAt: payload.expiresAt,
  }
}

/**
 * 已吊销票据登记表。除了逐张登记，还维护"用户 → 已签发票据"索引，
 * 以便登出 / 删除用户时把这个人的所有登录态一次性踢下线。
 */
export class RevocationList {
  private readonly revoked = new Map<string, number>()
  private readonly byUser = new Map<string, Set<string>>()

  /** 登记一次签发（用于后续按用户批量吊销）。 */
  track(jti: string, userId: string, expiresAt: number): void {
    const set = this.byUser.get(userId)
    if (set === undefined) this.byUser.set(userId, new Set([jti]))
    else set.add(jti)
    // 顺带记住过期时间，sweep 时统一清理。
    this.revoked.set(`ttl:${jti}`, expiresAt)
  }

  /** 吊销单张票据（登出）。 */
  add(jti: string, expiresAt: number): void {
    this.revoked.set(jti, expiresAt)
  }

  /** 吊销某用户的全部票据。 */
  addUser(userId: string, expiresAt: number): void {
    const set = this.byUser.get(userId)
    if (set === undefined) return
    for (const jti of set) this.revoked.set(jti, expiresAt)
    set.clear()
    this.byUser.delete(userId)
  }

  /** 某票据是否已被吊销。 */
  has(jti: string): boolean {
    return this.revoked.has(jti)
  }

  /** 清掉已过期的登记项，避免无界增长。 */
  sweep(): void {
    const now = Date.now()
    for (const [key, expiresAt] of this.revoked) {
      if (expiresAt <= now) this.revoked.delete(key)
    }
  }
}

/** 从 Cookie 头取出指定项。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header === '') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

/** 生成 Set-Cookie 头值（不含 Set-Cookie 前缀）。 */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; sameSite: 'lax' | 'strict'; path?: string },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`]
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`)
  parts.push(`SameSite=${opts.sameSite === 'strict' ? 'Strict' : 'Lax'}`, 'HttpOnly')
  return parts.join('; ')
}