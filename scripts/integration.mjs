// 端到端装配测试：用假 CAS 服务器 + 最小 cordis 上下文驱动真实插件。
// 验证 CAS 登录 → ticket 验证 → 登录态 → API 隔离。
// node scripts/integration.mjs

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

let failures = 0
function check(label, condition) {
  if (condition) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`) }
}

/* ── 假 CAS 服务器 ── */

let mockCasServer
let mockCasPort

function startMockCas() {
  return new Promise(resolve => {
    mockCasServer = createServer((req, res) => {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/validate') {
        const ticket = url.searchParams.get('ticket') || ''
        if (ticket === 'valid-ticket' || ticket.startsWith('ST-')) {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('yes\ncasuser\n')
        } else if (ticket === 'admin-ticket') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('yes\nadminuser\n')
        } else if (ticket === 'bob-ticket') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('yes\nbobuser\n')
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('no\n\n')
        }
      } else {
        res.writeHead(404)
        res.end('not found')
      }
    })
    mockCasServer.listen(0, '127.0.0.1', () => {
      mockCasPort = mockCasServer.address().port
      console.log(`假 CAS 服务器已启动，端口：${mockCasPort}`)
      resolve()
    })
  })
}

function stopMockCas() {
  return new Promise(resolve => {
    if (mockCasServer) mockCasServer.close(() => resolve())
    else resolve()
  })
}

/* ── 最小 cordis 上下文 ── */
function makeContext() {
  const effects = []
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    get: name => ctx.services[name],
    services: {},
    effect: fn => { effects.push(fn) },
    runDispose: async () => {
      for (const fn of effects.reverse()) {
        const d = fn()
        if (typeof d === 'function') await d()
        else if (d && typeof d.then === 'function') await d
      }
    },
  }
  return ctx
}

/* ── 假 settings 服务（模拟 harness 的 ctx.settings） ── */
function makeSettings({ owner, doc = {} } = {}) {
  const sections = structuredClone(doc)
  const registrations = new Map()
  const service = {
    register(ns, schema, options = {}) {
      if (registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
      const registration = { ns, options, schema }
      registrations.set(ns, registration)
      const resolve = () => mergeDeep(structuredClone(options.base ?? {}), structuredClone(sections[ns] ?? {}))
      const scope = {
        get: () => resolve(),
        watch: () => () => {},
        update: async patch => {
          sections[ns] = mergeDeep(structuredClone(sections[ns] ?? {}), patch)
        },
        replace: async () => {},
      }
      owner.effect(() => () => { registrations.delete(ns) })
      registration.scope = scope
      return scope
    },
  }
  return service
}

/** 深度合并（后者覆盖前者）。 */
function mergeDeep(base, layer) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return layer === undefined ? base : layer
  }
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) return layer
  const out = { ...base }
  for (const [key, value] of Object.entries(layer)) {
    out[key] = key in out ? mergeDeep(out[key], value) : structuredClone(value)
  }
  return out
}

/* ── 假请求 / 响应 ── */

class MockRequest extends Readable {
  constructor(method, url, headers, body) {
    super({ read() { this.push(this.pending.length === 0 ? null : this.pending.shift()) } })
    this.method = method
    this.url = url
    this.headers = headers
    this.pending = body === '' ? [] : [Buffer.from(body)]
    this.socket = { remoteAddress: '127.0.0.1' }
  }
}

class MockResponse {
  constructor() {
    this.status = 200
    this.headers = {}
    this.chunks = []
    this._cookies = []
  }
  writeHead(code, headers) {
    this.status = code
    Object.assign(this.headers, headers ?? {})
    return this
  }
  getHeader(name) { return this.headers[name] }
  setHeader(name, value) {
    if (name === 'Set-Cookie') {
      if (Array.isArray(value)) this._cookies = this._cookies.concat(value)
      else this._cookies.push(value)
    }
    this.headers[name] = value
  }
  write(text) { this.chunks.push(String(text)); return true }
  end(text) { if (text !== undefined) this.chunks.push(String(text)) }
  on() { return this }
  off() { return this }
  get body() { return this.chunks.join('') }
  get cookieHeader() { return this._cookies.join('; ') }
}

/* ── 最小 HTTP 面 ── */
function makeWebServer() {
  const routes = new Map()
  return {
    register(route) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
    tapIndex(transform) {
      this.taps.push(transform)
      return () => { this.taps = this.taps.filter(t => t !== transform) }
    },
    taps: [],
    async request({ method, path, headers = {}, body = '' }) {
      // 去掉 query 参数，webserver 路由按 pathname 精确匹配
      const pathname = path.indexOf('?') >= 0 ? path.slice(0, path.indexOf('?')) : path
      // 也处理带 query 参数但路由只有 path 的情况
      const route = routes.get(path) || routes.get(pathname)
      if (route === undefined) return { status: 404, headers: {}, body: 'not found' }
      const req = new MockRequest(method, path, headers, body)
      const res = new MockResponse()
      await route.handler(req, res)
      return { status: res.status, headers: res.headers, body: res.body, cookies: res._cookies }
    },
    has(path) { return routes.has(path) },
  }
}

/* ── 假 apiProxy ── */
function makeApiProxy() {
  const sessions = {
    s_alice: { sessionId: 's_alice', updatedAt: 2, running: false, blank: false },
    s_bob: { sessionId: 's_bob', updatedAt: 1, running: false, blank: false },
  }
  return {
    sessions: {
      async list(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { items: Object.values(sessions) } } }
      },
      async create(request) {
        const id = (request.payload && request.payload.sessionId) || 's_new'
        return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: id } } }
      },
      async history(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { events: [], hasMore: false } } }
      },
    },
    events: {
      async *mux(request, signal) {
        yield { type: 'server-request', rpcId: 'f1', method: 'session/subscribed', payload: { sessionId: 's_new', type: 'session/subscribed', lastSeq: 0 } }
        yield { type: 'server-request', rpcId: 'f2', method: 'session/projection', payload: { sessionId: 's_alice', type: 'session/projection', key: 'title', value: 'Alice', seq: 1 } }
        yield { type: 'server-request', rpcId: 'f3', method: 'stream/error', payload: { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } }
      },
      async *host(request, signal) {
        yield { type: 'server-request', rpcId: 'h1', method: 'host/session-added', payload: { type: 'host/session-added', sessionId: 's_new', blank: true } }
        yield { type: 'server-request', rpcId: 'h2', method: 'host/session-added', payload: { type: 'host/session-added', sessionId: 's_alice', blank: true } }
      },
    },
  }
}

/* ── CAS 票据验证辅助 ── */

/** 从 SSE 响应体里解析出 data 帧。 */
function parseSse(body) {
  const frames = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    frames.push(JSON.parse(line.slice(6)))
  }
  return frames
}

/* ── 主测试流程 ── */

const home = mkdtempSync(join(tmpdir(), 'dsh-cas-it-'))
process.env.DSH_HOME = home
process.env.DSH_SESSION_SECRET = 'it-secret'

try {
  await startMockCas()

  const { apply, name, inject } = await import('../lib/index.js')

  check('插件名', name === 'dsh-cas')
  check('inject 含 webServer', inject.includes('webServer'))

  const ctx = makeContext()
  const webServer = makeWebServer()
  ctx.services.webServer = webServer
  ctx.services.apiProxy = makeApiProxy()
  // 模拟真实宿主：settings.yaml 的 `cas:` 段经 ctx.settings 提供配置。
  // 外挂 config 保持为空（patch 条目只声明 `- id: cas, name: dsh-cas`，不带 config）。
  ctx.services.settings = makeSettings({
    owner: ctx,
    doc: {
      cas: {
        cas: {
          serverUrl: `http://127.0.0.1:${mockCasPort}`,
          adminUsernames: ['adminuser'],
        },
        enforce: true,
      },
    },
  })

  const config = {}
  apply(ctx, config)

  console.log('路由注册')
  check('CAS 登录端点', webServer.has('/cas/login'))
  check('CAS 回调端点', webServer.has('/cas/callback'))
  check('me 端点', webServer.has('/cas/me'))
  check('连接配置端点', webServer.has('/cas/connection'))
  check('影子化 session.list', webServer.has('/api/session.list'))
  check('影子化 session.history', webServer.has('/api/session.history'))
  check('影子化 session.create', webServer.has('/api/session.create'))
  check('接管事件流 events.mux', webServer.has('/api/events.mux'))
  check('接管事件流 events.host', webServer.has('/api/events.host'))

  console.log('index 注入')
  const html = webServer.taps.reduce((acc, tap) => tap(acc), '<html><body><script src="/app.js"></script></body></html>')
  check('注入了遮罩脚本', html.includes('dsh-cas-gate'))
  check('注入位置在 body 之后', html.indexOf('dsh-cas-gate') > html.indexOf('<body>'))

  console.log('未登录访问')
  const anon = await webServer.request({
    method: 'POST',
    path: '/api/session.list',
    headers: {
      'content-type': 'application/json',
      'host': '127.0.0.1:9999',
    },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }),
  })
  const anonBody = JSON.parse(anon.body)
  check('未登录被拒', anon.status === 200 && anonBody.result.ok === false)
  check('拒绝信息可读', anonBody.result.error.message.includes('登录'))

  console.log('CAS 登录跳转')
  const loginResp = await webServer.request({
    method: 'GET',
    path: '/cas/login',
    headers: { host: '127.0.0.1:9999' },
  })
  check('登录跳转 302', loginResp.status === 302)
  check('跳转到 CAS 服务器', loginResp.headers.location.includes(`http://127.0.0.1:${mockCasPort}`))

  console.log('CAS 回调（有效 ticket）')
  const callbackResp = await webServer.request({
    method: 'GET',
    path: `/cas/callback?ticket=valid-ticket`,
    headers: { host: '127.0.0.1:9999' },
  })
  check('回调 302', callbackResp.status === 302)
  check('回跳首页', callbackResp.headers.location === '/')
  const cookieMatch = callbackResp.cookies.join('; ').match(/dsh_cas_user=([^;]+)/)
  check('下发登录 cookie', cookieMatch !== null)
  const casToken = cookieMatch ? cookieMatch[1] : ''

  console.log('登录后访问')
  const envelope = (method, payload) => JSON.stringify({
    type: 'client-request', rpcId: 'r2', method, payload,
  })

  const meResp = await webServer.request({
    method: 'GET',
    path: '/cas/me',
    headers: { cookie: `dsh_cas_user=${casToken}` },
  })
  const meBody = JSON.parse(meResp.body)
  check('me 返回用户', meBody.ok === true && meBody.user.username === 'casuser')

  const listed = await webServer.request({
    method: 'POST',
    path: '/api/session.list',
    headers: { 'content-type': 'application/json', cookie: `dsh_cas_user=${casToken}` },
    body: envelope('session.list', {}),
  })
  const listedBody = JSON.parse(listed.body)
  check('session.list 成功', listedBody.result.ok === true)

  const created = await webServer.request({
    method: 'POST',
    path: '/api/session.create',
    headers: { 'content-type': 'application/json', cookie: `dsh_cas_user=${casToken}` },
    body: envelope('session.create', {}),
  })
  check('session.create 透传', JSON.parse(created.body).result.value.sessionId === 's_new')

  console.log('管理员 CAS 登录')
  const adminCallback = await webServer.request({
    method: 'GET',
    path: '/cas/callback?ticket=admin-ticket',
    headers: { host: '127.0.0.1:9999' },
  })
  const adminCookieMatch = adminCallback.cookies.join('; ').match(/dsh_cas_user=([^;]+)/)
  check('管理员登录下发 cookie', adminCookieMatch !== null)
  const adminToken = adminCookieMatch ? adminCookieMatch[1] : ''

  const adminMe = await webServer.request({
    method: 'GET',
    path: '/cas/me',
    headers: { cookie: `dsh_cas_user=${adminToken}` },
  })
  const adminMeBody = JSON.parse(adminMe.body)
  check('管理员角色', adminMeBody.user.role === 'admin')
  check('管理员用户名', adminMeBody.user.username === 'adminuser')

  console.log('会话隔离（不同用户）')
  const bobCallback = await webServer.request({
    method: 'GET',
    path: '/cas/callback?ticket=bob-ticket',
    headers: { host: '127.0.0.1:9999' },
  })
  const bobToken = (bobCallback.cookies.join('; ').match(/dsh_cas_user=([^;]+)/) || [])[1] || ''

  // bobuser 之前的 session.list 中 s_new 已被 casuser 认领，bobuser 应看不到任何会话
  const bobList = await webServer.request({
    method: 'POST',
    path: '/api/session.list',
    headers: { 'content-type': 'application/json', cookie: `dsh_cas_user=${bobToken}` },
    body: envelope('session.list', {}),
  })
  const bobListBody = JSON.parse(bobList.body)
  // s_new 被 casuser 认领，其他无主会话按 unownedSessions=admin 对 user 不可见
  check('普通用户看不到他人会话', bobListBody.result.value.items.length === 0)

  const bobHistory = await webServer.request({
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json', cookie: `dsh_cas_user=${bobToken}` },
    body: envelope('session.history', { sessionId: 's_new' }),
  })
  check('越权读历史被拒', JSON.parse(bobHistory.body).result.ok === false)

  console.log('事件流隔离')
  const mux = await webServer.request({
    method: 'GET', path: '/api/events.mux',
    headers: { cookie: `dsh_cas_user=${casToken}` }, body: '',
  })
  const muxFrames = parseSse(mux.body)
  const muxSids = muxFrames.map(f => f.payload && f.payload.sessionId).filter(Boolean)
  check('mux 流是 SSE', (mux.headers['content-type'] || '').includes('text/event-stream'))
  check('mux 透传已认领会话', muxSids.includes('s_new'))
  check('mux 透传 stream/error', muxFrames.some(f => f.payload && f.payload.type === 'stream/error'))

  const host = await webServer.request({
    method: 'GET', path: '/api/events.host',
    headers: { cookie: `dsh_cas_user=${casToken}` }, body: '',
  })
  const hostFrames = parseSse(host.body)
  const hostSids = hostFrames.map(f => f.payload && f.payload.sessionId).filter(Boolean)
  check('host 透传已认领会话', hostSids.includes('s_new'))

  console.log('登出')
  const logout = await webServer.request({
    method: 'POST',
    path: '/cas/logout',
    headers: { 'content-type': 'application/json', cookie: `dsh_cas_user=${casToken}` },
    body: '{}',
  })
  check('登出成功', logout.status === 200)

  const afterLogout = await webServer.request({
    method: 'POST',
    path: '/api/session.list',
    headers: { 'content-type': 'application/json', cookie: `dsh_cas_user=${casToken}` },
    body: envelope('session.list', {}),
  })
  check('登出后票据失效', JSON.parse(afterLogout.body).result.ok === false)

  console.log('CAS 配置管理（管理员）')
  const getConfig = await webServer.request({
    method: 'GET',
    path: '/cas/connection',
    headers: { cookie: `dsh_cas_user=${adminToken}` },
  })
  check('管理员可读配置', JSON.parse(getConfig.body).ok === true)

  const saveConfig = await webServer.request({
    method: 'POST',
    path: '/cas/connection',
    headers: { 'content-type': 'application/json', cookie: `dsh_cas_user=${adminToken}` },
    body: JSON.stringify({ serverUrl: `http://127.0.0.1:${mockCasPort}`, adminUsernames: ['adminuser'] }),
  })
  check('管理员可保存配置', JSON.parse(saveConfig.body).ok === true)

  const nonAdminConfig = await webServer.request({
    method: 'POST',
    path: '/cas/connection',
    headers: { 'content-type': 'application/json', cookie: `dsh_cas_user=${bobToken}` },
    body: JSON.stringify({ serverUrl: 'http://evil.com' }),
  })
  check('非管理员保存配置被拒', nonAdminConfig.status === 403)

  await ctx.runDispose()
  check('卸载未抛错', true)
} catch (err) {
  failures++
  console.log(`  FAIL 未捕获异常：${err && err.stack ? err.stack : String(err)}`)
} finally {
  await stopMockCas()
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (err) {
    failures++
    console.log(`  FAIL 临时目录清理失败（${err.code ?? '未知'}）`)
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)