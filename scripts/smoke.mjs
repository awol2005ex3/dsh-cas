// 运行时烟测：CAS 工具、登录态票据、归属索引。
// node scripts/smoke.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ipMatchesPattern,
  parseValidateResponse,
  resolveEndpoints,
  buildLoginUrl,
  buildLogoutUrl,
  buildValidateUrl,
} from '../lib/cas.js'
import { issueToken, verifyToken, RevocationList, readCookie, serializeCookie } from '../lib/auth.js'
import { StateStore } from '../lib/store.js'
import { resolveAuth, DEFAULT_AUTH } from '../lib/config.js'

let failures = 0
function check(label, condition) {
  if (condition) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`) }
}

console.log('CAS URL 构建')
{
  const ep = resolveEndpoints({
    serverUrl: 'http://sso.example.cn',
    loginPath: '/login',
    validatePath: '/validate',
    logoutPath: '/logout',
  })
  check('login URL', buildLoginUrl(ep, 'http://localhost/cas/callback', 'dsh') ===
    'http://sso.example.cn/login?service=http%3A%2F%2Flocalhost%2Fcas%2Fcallback&srcsys=dsh')
  check('validate URL', buildValidateUrl(ep, 'http://localhost/cas/callback', 'ST-123') ===
    'http://sso.example.cn/validate?service=http%3A%2F%2Flocalhost%2Fcas%2Fcallback&ticket=ST-123&renew=false')
  check('logout URL', buildLogoutUrl(ep, 'http://localhost/') ===
    'http://sso.example.cn/logout?service=http%3A%2F%2Flocalhost%2F')
}

console.log('IP 模式匹配')
{
  check('通配 10.251.% 匹配 10.251.1.2', ipMatchesPattern('10.251.1.2', '10.251.%'))
  check('通配 10.251.% 不匹配 10.252.1.2', !ipMatchesPattern('10.252.1.2', '10.251.%'))
  check('精确匹配 127.0.0.1', ipMatchesPattern('127.0.0.1', '127.0.0.1'))
  check('% 全通配', ipMatchesPattern('10.0.0.1', '%'))
}

console.log('CAS ticket 验证解析')
{
  check('yes+username', parseValidateResponse('yes\nwuyijun') === 'wuyijun')
  check('trim 空格', parseValidateResponse(' yes \n wuyijun ') === 'wuyijun')
  check('no 返回 null', parseValidateResponse('no\n\n') === null)
  check('空响应返回 null', parseValidateResponse('') === null)
  check('单行返回 null', parseValidateResponse('yes') === null)
}

console.log('登录态票据')
{
  const auth = resolveAuth(undefined)
  const secret = 'test-secret'
  const revocations = new RevocationList()
  const { token, principal, jti } = issueToken(
    { userId: 'alice', username: 'alice', displayName: 'Alice', role: 'admin', source: 'cas' },
    auth,
    secret,
  )
  check('票据三段结构', token.split('.').length === 2)
  check('验签通过', verifyToken(token, { auth, secret, revoked: j => revocations.has(j) })?.userId === 'alice')
  check('错密钥拒绝', verifyToken(token, { auth, secret: 'other', revoked: () => false }) === undefined)
  check('篡改拒绝', verifyToken(`${token}x`, { auth, secret, revoked: () => false }) === undefined)
  check('source 是 cas', verifyToken(token, { auth, secret, revoked: () => false })?.source === 'cas')

  revocations.track(jti, 'alice', principal.expiresAt)
  check('吊销前有效', verifyToken(token, { auth, secret, revoked: j => revocations.has(j) }) !== undefined)
  revocations.addUser('alice', Date.now() + 60000)
  check('按用户吊销后失效', verifyToken(token, { auth, secret, revoked: j => revocations.has(j) }) === undefined)

  const cookie = serializeCookie(auth.cookieName, token, { maxAge: 60, sameSite: 'lax' })
  check('cookie 往返', readCookie(`a=1; ${cookie}; b=2`, auth.cookieName) === token)
}

console.log('会话归属索引')
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-cas-'))
  try {
    const statePath = join(home, 'cas.yaml')
    const store = new StateStore(statePath)
    store.load()
    store.claim('s1', 'alice')
    store.claim('s2', 'alice')
    store.claim('s3', 'bob')
    store.save()
    const reloaded = new StateStore(statePath)
    reloaded.load()
    check('落盘后归属保留', reloaded.ownerOfSession('s1') === 'alice')
    check('owner 判定', reloaded.verdict('s1', 'alice') === 'owner')
    check('other 判定', reloaded.verdict('s3', 'alice') === 'other')
    check('unowned 判定', reloaded.verdict('s9', 'alice') === 'unowned')
    check('按用户列举', reloaded.sessionsOfUser('alice').length === 2)
    reloaded.release('s1')
    check('解除归属', reloaded.ownerOfSession('s1') === undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)