/**
 * CAS 登录插件 · 浏览器端 bundle 模块体。
 *
 * 构建契约（同 dsh-user-manager）：
 * 经 tsc 编译后，由 scripts/wrap-client.mjs 包上闭包工厂外壳。
 *
 * 功能：
 *   1. 登录遮罩 —— 未登录时盖住应用，点击"CAS 登录"跳转 CAS 服务器；
 *   2. 管理员设置页 section —— CAS 连接配置（服务器地址、管理员用户名列表等）。
 */

var PLUGIN_ID = 'dsh-cas'
var ENDPOINT_ME = '/cas/me'

/** 构建外壳注入的 CJS 语义。 */
declare var module: { exports: unknown }
declare function require(id: string): unknown

var win = window as unknown as {
  __dshCasMounted?: boolean
}
var doc = document

/* ── DOM 工具 ── */

interface ElProps { style?: string; [key: string]: unknown }

function el(tag: string, props?: ElProps, children?: (Node | string)[]): HTMLElement {
  var node = doc.createElement(tag)
  if (props) {
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue
      if (key === 'style') node.setAttribute('style', props[key] as string)
      else (node as unknown as Record<string, unknown>)[key] = props[key]
    }
  }
  if (children) {
    for (var i = 0; i < children.length; i++) {
      var child: Node | string = children[i] as Node | string
      node.append(typeof child === 'string' ? doc.createTextNode(child) : child)
    }
  }
  return node
}

interface FieldElement extends HTMLElement {
  value: string
  disabled: boolean
  checked?: boolean
  cssText?: string
}

function input(placeholder: string, type: string, value: string): FieldElement {
  return el('input', {
    type: type,
    value: value,
    placeholder: placeholder,
    style: INPUT_CSS,
  }) as unknown as FieldElement
}

function button(label: string, onClick: () => void, primary?: boolean): FieldElement {
  var btn = el('button', {
    type: 'button',
    textContent: label,
    style: BTN_CSS + (primary === true ? PRIMARY_CSS : ''),
  }) as unknown as FieldElement
  btn.addEventListener('click', function (e: Event) {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return btn
}

function field(labelText: string, node: HTMLElement): HTMLElement {
  return el('label', { style: 'display:block;margin-bottom:10px;font-size:12px;color:#9aa3b2;' }, [
    el('div', { textContent: labelText, style: 'margin-bottom:4px;' }),
    node,
  ])
}

function row(children: (Node | string)[], gap: string): HTMLElement {
  return el('div', { style: 'display:flex;gap:' + gap + ';align-items:center;flex-wrap:wrap;' }, children)
}

/* ── 样式 ── */

var OVERLAY_CSS = [
  'position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;',
  'justify-content:center;background:#16181d;color:#e6e6e6;',
  'font:14px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
].join('')

var CARD_CSS = 'width:340px;padding:28px;background:#1e2128;border:1px solid #2e323b;border-radius:12px;'

var INPUT_CSS = [
  'width:100%;box-sizing:border-box;padding:9px 11px;background:#14161b;',
  'border:1px solid #343944;border-radius:8px;color:#e6e6e6;font-size:14px;outline:none;',
].join('')

var BTN_CSS = [
  'padding:8px 14px;font-size:13px;cursor:pointer;border-radius:8px;',
  'border:1px solid #3a4252;background:#262b34;color:#e6e6e6;',
].join('')

var PRIMARY_CSS = 'background:#4d7cfe;border-color:#4d7cfe;color:#fff;'

var BADGE_CSS = [
  'position:fixed;top:16px;right:16px;z-index:2147483646;display:flex;',
  'align-items:center;gap:10px;padding:8px 12px;background:#1e2128;',
  'border:1px solid #2e323b;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.3);',
  'font:13px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
  'color:#e6e6e6;',
].join('')

var BADGE_NAME_CSS = 'font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
var BADGE_ROLE_CSS = 'font-size:11px;padding:1px 8px;border-radius:999px;'
var BADGE_ROLE_ADMIN_CSS = BADGE_ROLE_CSS + 'background:#4d7cfe33;color:#7ea2ff;border:1px solid #3f5fc9;'
var BADGE_ROLE_USER_CSS = BADGE_ROLE_CSS + 'background:#353a45;color:#8b919c;border:1px solid #3a4252;'

var SECTION_CSS = [
  'position:relative;box-sizing:border-box;width:100%;max-width:560px;',
  'overflow:auto;background:#1e2128;color:#e6e6e6;border:1px solid #2e323b;border-radius:12px;',
  'box-shadow:0 4px 16px rgba(0,0,0,.3);padding:14px;margin:8px 0;',
  'font:13px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
].join('')

var PAGE_TITLE_CSS = 'font-weight:600;font-size:14px;margin:0 0 10px;'

var FLOAT_BTN_CSS = [
  'position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:9px 14px;',
  'font-size:13px;background:#4d7cfe;color:#fff;border:none;border-radius:8px;',
  'box-shadow:0 2px 8px rgba(0,0,0,.3);margin:0;cursor:pointer;',
].join('')

/* ── 接口与请求 ── */

interface MeResponse {
  ok: boolean
  user?: { userId: string; username: string; displayName: string; role: string }
  enforce?: boolean
  error?: string
}

interface ConnectionResponse {
  ok: boolean
  cas?: Record<string, unknown>
  error?: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function post(endpoint: string, body: unknown): Promise<unknown> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) {
    return r.json().then(function (d: unknown) {
      var data = d as { ok?: boolean; error?: string }
      if (r.status !== 200 || data.ok !== true) {
        throw new Error(data.error || ('请求失败（' + r.status + '）'))
      }
      return d
    })
  })
}

function get(endpoint: string): Promise<unknown> {
  return fetch(endpoint, { headers: { accept: 'application/json' } }).then(function (r) {
    return r.json()
  })
}

/* ── 当前用户徽标 ── */

function showUserBadge(user: { userId: string; username: string; displayName: string; role: string }): void {
  if (doc.getElementById('dsh-cas-badge') !== null) return

  var display = user.displayName || user.username
  var nameEl = el('span', { textContent: display, style: BADGE_NAME_CSS })
  var roleText = user.role === 'admin' ? '管理员' : '用户'
  var roleEl = el('span', {
    textContent: roleText,
    style: user.role === 'admin' ? BADGE_ROLE_ADMIN_CSS : BADGE_ROLE_USER_CSS,
  })

  var logoutBtn = button('登出', function () {
    doLogout(logoutBtn)
  })

  var badge = el('div', { id: 'dsh-cas-badge', style: BADGE_CSS }, [
    nameEl,
    roleEl,
    logoutBtn,
  ])
  doc.body.append(badge)
}

function doLogout(btn: FieldElement): void {
  btn.disabled = true
  var badge = doc.getElementById('dsh-cas-badge')
  if (badge !== null && badge.parentNode) badge.parentNode.removeChild(badge)

  var redirectTarget = '/cas/login?redirect=' + encodeURIComponent(location.pathname + location.search)
  // 先调用 /cas/logout 清掉本地 cookie（服务端 revokeUser + clearSessionCookie），
  // 否则 /cas/login 见已有登录态会直接放行旧用户，无法切换账号。
  post('/cas/logout', {})
    .then(function (d: unknown) {
      var data = d as { logoutUrl?: string }
      // 有 CAS 登出页则先跳去清 CAS SSO 会话（否则 CAS 仍记得旧账号，点登录会静默回到旧用户）；
      // 无法访问 CAS 登出页时回落到登录入口。
      location.href = typeof data.logoutUrl === 'string' && data.logoutUrl !== '' ? data.logoutUrl : redirectTarget
    })
    .catch(function () {
      location.href = redirectTarget
    })
}

/* ── 登录遮罩 ── */

function showLoginOverlay(): void {
  if (doc.getElementById('dsh-cas-overlay') !== null) return

  var casBtn = button('使用 CAS 账号登录', function () {
    location.href = '/cas/login'
  }, true)

  var card = el('div', { style: CARD_CSS }, [
    el('h1', { textContent: 'DeepSeek Harness', style: 'margin:0 0 4px;font-size:17px;font-weight:600;' }),
    el('p', { textContent: '请通过统一身份认证（CAS）登录', style: 'margin:0 0 20px;font-size:12px;color:#8b919c;' }),
    casBtn,
  ])

  var overlay = el('div', { id: 'dsh-cas-overlay', style: OVERLAY_CSS }, [card])
  doc.body.append(overlay)
}

/* ── CAS 配置页面（管理员） ── */

function buildCasConfigPage(onSaved: () => void) {
  var status = el('div', { style: 'margin:6px 0;min-height:18px;color:#8b919c;font-size:12px;' })

  var serverUrl = input('http://sso.example.com', 'text', '')
  var loginPath = input('/login', 'text', '')
  var validatePath = input('/validate', 'text', '')
  var logoutPath = input('/logout', 'text', '')
  var servicePath = input('/cas/callback', 'text', '')
  var srcsys = input('系统标识（可选）', 'text', '')
  var adminUsers = input('admin,user1,user2', 'text', '')
  var tlsToggle = el('input', { type: 'checkbox' }) as unknown as FieldElement

  function fillConnection(res: ConnectionResponse): void {
    var cas = res.cas || {}
    serverUrl.value = String(cas.serverUrl || '')
    loginPath.value = String(cas.loginPath || '/login')
    validatePath.value = String(cas.validatePath || '/validate')
    logoutPath.value = String(cas.logoutPath || '/logout')
    servicePath.value = String(cas.servicePath || '/cas/callback')
    srcsys.value = String(cas.srcsys || '')
    var admins = cas.adminUsernames
    adminUsers.value = Array.isArray(admins) ? admins.join(',') : ''
    tlsToggle.checked = (cas as Record<string, unknown>).tlsRejectUnauthorized !== false
  }

  function collectBody(): unknown {
    return {
      serverUrl: serverUrl.value.trim() || undefined,
      loginPath: loginPath.value.trim() || '/login',
      validatePath: validatePath.value.trim() || '/validate',
      logoutPath: logoutPath.value.trim() || '/logout',
      servicePath: servicePath.value.trim() || '/cas/callback',
      srcsys: srcsys.value.trim() || undefined,
      adminUsernames: adminUsers.value.split(',').map(function (s) { return s.trim() }).filter(function (s) { return s !== '' }),
      tlsRejectUnauthorized: tlsToggle.checked,
    }
  }

  var testBtn = button('测试连接', function () {
    status.textContent = '测试中…'
    post('/cas/connection/test', collectBody())
      .then(function () { status.textContent = '连接成功' })
      .catch(function (err) { status.textContent = '错误：' + messageOf(err) })
  })

  var saveBtn = button('保存配置', function () {
    status.textContent = '保存中…'
    post('/cas/connection', collectBody())
      .then(function () { return refresh() })
      .then(function () { status.textContent = '已保存' })
      .catch(function (err) { status.textContent = '错误：' + messageOf(err) })
  }, true)

  var root = el('div', {}, [
    el('div', { textContent: '配置 CAS 单点登录服务器，保存后即时生效。', style: 'font-size:12px;color:#8b919c;margin-bottom:10px;' }),
    field('CAS 服务器地址', serverUrl),
    field('登录路径', loginPath),
    field('验证路径', validatePath),
    field('登出路径', logoutPath),
    field('回调路径', servicePath),
    field('srcsys 参数', srcsys),
    field('管理员用户名（逗号分隔）', adminUsers),
    row([tlsToggle, el('span', { textContent: '校验证书', style: 'font-size:12px;' })], '6px'),
    row([testBtn, saveBtn], '8px'),
    status,
  ])

  function refresh(): Promise<void> {
    return get('/cas/connection').then(function (d: unknown) {
      var res = d as ConnectionResponse
      if (res.ok !== true) throw new Error(res.error || '读取配置失败')
      fillConnection(res)
    }).catch(function (err) {
      status.textContent = '错误：' + messageOf(err)
    })
  }

  return { el: root, refresh: refresh }
}

/* ── 管理员设置页 section ── */

interface SectionHandle {
  root: HTMLElement
  refresh: () => void
}

function buildAdminSection(): SectionHandle {
  var configPage = buildCasConfigPage(function () { /* nothing extra */ })
  var root = el('div', { id: 'dsh-cas-admin-section', style: SECTION_CSS }, [
    el('div', { textContent: '🔐 CAS 配置', style: PAGE_TITLE_CSS }),
    configPage.el,
  ])
  function refresh(): void { if (configPage.refresh) configPage.refresh() }
  return { root: root, refresh: refresh }
}

/* ── 设置页挂载 ── */

function findSettingsHost(): HTMLElement | null {
  var selectors = [
    '[data-slot="settings.plugin.item"]',
    '[data-slot="settings.plugins.tab"]',
    '[data-slot="settings.section"]',
    '[data-slot="settings.content"]',
  ]
  for (var i = 0; i < selectors.length; i++) {
    var node = doc.querySelector(selectors[i]!)
    if (node instanceof HTMLElement) return node
  }
  return null
}

function mountSectionInSettings(handle: SectionHandle): void {
  var host = findSettingsHost()
  if (!host) {
    if (handle.root.parentElement) handle.root.remove()
    return
  }
  if (handle.root.parentElement !== host) {
    host.append(handle.root)
    handle.refresh()
  }
}

function tryRegisterSettingsSlot(ctx: any, handle: SectionHandle): boolean {
  function register(slots: any): boolean {
    var React: any
    try { React = require('react') } catch { return false }
    if (!React || typeof React.createElement !== 'function') return false

    function CasSettings(): any {
      var ref = React.useRef(null)
      React.useEffect(function () {
        var node = ref.current as HTMLElement | null
        if (!node) return
        node.appendChild(handle.root)
        handle.refresh()
      }, [])
      return React.createElement('div', { ref: ref, 'data-dsh-cas-settings': 'true' })
    }

    function NavIcon(props: any): any {
      return React.createElement(
        'svg',
        Object.assign({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true }, props),
        React.createElement('rect', { x: 3, y: 11, width: 18, height: 11, rx: 2, ry: 2 }),
        React.createElement('path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }),
      )
    }

    var sectionOpts = { id: PLUGIN_ID, label: 'CAS 登录', title: 'CAS 登录', icon: NavIcon }

    function tryOne(slotName: string, opts: any): boolean {
      try {
        if (typeof slots.inject === 'function') {
          slots.inject(slotName, function () {
            return slots.register(Object.assign({ name: slotName }, opts), CasSettings)
          })
          return true
        }
        slots.register(Object.assign({ name: slotName }, opts), CasSettings)
        return true
      } catch {
        return false
      }
    }

    if (tryOne('settings.section', sectionOpts)) return true
    if (tryOne('settings.plugin.item', { key: PLUGIN_ID, label: 'CAS 登录' })) return true
    if (tryOne('settings.plugins.tab', { id: PLUGIN_ID, label: 'CAS 登录' })) return true
    return false
  }

  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['slots'], function (scope: any) { register(scope.slots) })
      return true
    }
    var slots = ctx?.get?.('slots') ?? ctx?.slots
    if (slots) return register(slots)
  } catch { /* fall back to DOM mount */ }
  return false
}

/* ── 插件契约 ── */

function apply(ctx: unknown): void {
  if (win.__dshCasMounted === true) return
  win.__dshCasMounted = true

  function boot(): void {
    fetch(ENDPOINT_ME, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json() as Promise<MeResponse> })
      .then(function (me) {
        if (me.ok !== true || !me.user) {
          showLoginOverlay()
          return
        }
        var user = me.user
        showUserBadge(user)
        if (user.role === 'admin') {
          var handle = buildAdminSection()
          var slotted = tryRegisterSettingsSlot(ctx, handle)
          var observer = new MutationObserver(function () {
            if (!slotted) mountSectionInSettings(handle)
          })
          observer.observe(doc.documentElement, { childList: true, subtree: true })
          if (!slotted) mountSectionInSettings(handle)
        }
      })
      .catch(function () {
        showLoginOverlay()
      })
  }

  if (doc.body) boot()
  else doc.addEventListener('DOMContentLoaded', boot)
}

module.exports = { name: PLUGIN_ID, inject: ['connection'], apply: apply }