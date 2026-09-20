/**
 * dsh-cas · 宿主半插件入口。
 *
 * 三块：
 *   1. `/cas/*` 自控路由（登录/CAS回跳/登出/me/连接配置）；
 *   2. `/api/<method>` 影子路由（登录态校验 + 会话归属过滤）；
 *   3. index.html 注入登录遮罩脚本。
 *
 * 为什么必须影子化 HTTP 路由：`ctx.connection.rpc.handle` 的回调签名是
 * `(endpoint, payload, signal)`，拿不到 Cookie，无法识别调用者身份。而
 * `ctx.webServer` 的匹配规则是「exact 优先，其次最长前缀」，connection 插件
 * 把 `/api` 注册为 prefix，因此这里用 exact 注册具体方法即可接管。
 */

import type { Context } from '@deepseek-ai/cordis'
import { RevocationList } from './auth.js'
import {
  BUILTIN_ADMIN_ONLY_METHODS,
  Config,
  ENV_SESSION_SECRET,
  readSessionSecret,
  resolveAuth,
  resolveCas,
  resolveDshHome,
  validateConfig,
} from './config.js'
import { registerApiGate, type ApiProxyLike, type RouteRegistrar } from './gate.js'
import { hijackEventUpgrades, wrapEventStreams, type EventsStreams } from './events-ws.js'
import { registerCasRoutes } from './http.js'
import { StateStore } from './store.js'
import type { CasConfig, PluginConfig, ResolvedCasConfig } from './types.js'

/** 插件 id —— 在组合后的插件树中必须唯一。 */
export const name = 'dsh-cas'

/**
 * 声明依赖的宿主服务。webServer 是硬依赖（整套机制都建立在它的路由表上）；
 * apiProxy 用 `ctx.get` 取，避免它未就绪时把本插件挡在加载之外。
 */
export const inject = ['webServer', 'settings']

export { Config }
export type { PluginConfig }

/** 吊销表清扫间隔。 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

/** `ctx.settings` 的窄化视图（只用到 register + scope.get）。 */
interface SettingsLike {
  register: (
    ns: string,
    schema: unknown,
    options?: { applies?: 'live' | 'restart'; base?: object },
  ) => { get: () => object }
}

/**
 * 插件入口（具名导出，禁止 export default —— 会丢失 inject 元数据）。
 *
 * 有效配置来源：`ctx.settings` 命名空间 `cas`（settings.yaml 中的 `cas:` 段，
 * 由 schemastery Config 校验并合并默认值）> 外挂 patch/CLI 传入的 config。
 * harness 不会把 settings.yaml 段自动折进 apply 的 config 参数，必须显式
 * 注册命名空间读取（此即 dsh-wecom 等第三方插件的标准做法）。
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const log = (message: string): void => { ctx.logger.warn(`dsh-cas: ${message}`) }

  const settings = ctx.get('settings') as SettingsLike | undefined
  let effectiveConfig = config
  if (settings?.register !== undefined) {
    try {
      // base 用外挂 config，settings.yaml 的 `cas:` 段作为用户层叠加其上；
      // applies: 'restart' 表明 namespace 变更需重启生效（登录态 cookie 也会随密钥变化重建）。
      const scope = settings.register('cas', Config, { applies: 'restart', base: config })
      effectiveConfig = scope.get() as unknown as PluginConfig
    } catch (err) {
      log(`settings 命名空间注册失败，回退 patch config：${String(err)}`)
    }
  }

  const validation = validateConfig(effectiveConfig)
  if (!validation.valid) {
    log(`配置不完整（${validation.reason}），以仅路由模式加载（可在设置页中补全）`)
  }
  const configValid = validation.valid

  // 合并管理员专属方法与配置追加项。
  const auth = resolveAuth({
    ...effectiveConfig.auth,
    adminOnlyMethods: [...BUILTIN_ADMIN_ONLY_METHODS, ...(effectiveConfig.auth?.adminOnlyMethods ?? [])],
  })
  const cas = resolveCas(effectiveConfig.cas, auth)

  const webServer = ctx.get('webServer') as {
    register: (route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: unknown, res: unknown) => void | Promise<void>
    }) => () => void
    registerUpgrade: (route: {
      path: string
      handler: (req: unknown, socket: unknown, head: unknown) => void | Promise<void>
    }) => () => void
    tapIndex: (transform: (html: string) => string) => () => void
  } | undefined
  if (webServer === undefined) {
    log('未找到 webServer 服务，插件未启用')
    return
  }

  const store = new StateStore(`${resolveDshHome()}/cas.yaml`)
  store.load()

  const secret = readSessionSecret()
  const revocations = new RevocationList()

  if (process.env[ENV_SESSION_SECRET] === undefined) {
    log(`未设置 ${ENV_SESSION_SECRET}，已使用随机密钥：重启后需要重新登录`)
  }

  /* ── CAS 配置（页面保存优先于 profile 配置） ── */

  const savedCas = store.getCas()
  const currentCas: { value: ResolvedCasConfig } = {
    value: savedCas === undefined ? cas : resolveCas(savedCas, auth),
  }

  const getCasConfig = (): CasConfig | undefined => store.getCas()
  const setCasConfig = (newCas: CasConfig): void => {
    store.setCas(newCas)
    currentCas.value = resolveCas(newCas, auth)
    log('CAS 配置已更新')
  }

  /* ── 路由注册 ── */

  const register: RouteRegistrar = route => webServer.register(route)

  const disposeCasRoutes = registerCasRoutes({
    config: effectiveConfig,
    cas: currentCas.value,
    auth,
    secret,
    getCasConfig,
    setCasConfig,
    track: (jti, userId, expiresAt) => revocations.track(jti, userId, expiresAt),
    isRevoked: jti => revocations.has(jti),
    revokeUser: userId => {
      revocations.addUser(userId, Date.now() + auth.sessionTtlSeconds * 1000)
    },
    log,
  }, register)

  ctx.effect(() => disposeCasRoutes, 'dsh-cas: routes')

  // 独立 CAS 登录跳转页（整页登录场景）。
  try {
    const disposeLoginPage = register({
      kind: 'exact',
      path: '/cas/login.html',
      handler: (_req, res) => {
        const response = res as { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(renderLoginPage())
      },
    })
    ctx.effect(() => disposeLoginPage, 'dsh-cas: login page')
  } catch (err) {
    log(`注册登录页失败：${String(err)}`)
  }

  if (effectiveConfig.enforce && configValid) {
    const filterCtx = { store, auth, log }
    const authView = { auth, secret, isRevoked: (jti: string) => revocations.has(jti) }

    const setupGate = (apiProxy: ApiProxyLike): void => {
      const gate = registerApiGate({
        config: effectiveConfig,
        auth,
        store,
        api: apiProxy,
        isRevoked: jti => revocations.has(jti),
        secret,
        log,
      }, register)
      ctx.effect(() => gate.dispose, 'dsh-cas: api gate')
      log(`已接管 ${gate.methods.length} 个 /api 方法`)

      if (apiProxy.events !== undefined) {
        ctx.effect(() => wrapEventStreams(filterCtx, apiProxy.events as EventsStreams), 'dsh-cas: event streams')
      }
    }

    const existing = ctx.get('apiProxy') as ApiProxyLike | undefined
    if (existing !== undefined) {
      setupGate(existing)
    } else {
      ctx.inject(['apiProxy'], apiCtx => {
        const api = (apiCtx as unknown as { apiProxy?: ApiProxyLike }).apiProxy
        if (api === undefined) {
          log('apiProxy 注入回调中仍不可用，会话隔离未启用（CAS 登录仍可用）')
          return
        }
        setupGate(api)
      })
    }

    const disposeHijack = hijackEventUpgrades(
      { ...filterCtx, authView },
      webServer as unknown as { server?: import('node:http').Server },
    )
    ctx.effect(() => disposeHijack, 'dsh-cas: websocket upgrades')
  }

  // 登录遮罩：注入在 <body> 起始处，应用脚本之前。
  const disposeTap = webServer.tapIndex(html => injectGate(html))
  ctx.effect(() => disposeTap, 'dsh-cas: index tap')

  // 定期清理过期的吊销登记。
  const timer = setInterval(() => { revocations.sweep() }, SWEEP_INTERVAL_MS)
  timer.unref?.()
  ctx.effect(() => () => { clearInterval(timer) }, 'dsh-cas: sweep')
}

/**
 * 把登录遮罩脚本插到 <body> 之后。webserver 注入顺序与 dsh-user-manager 一致。
 */
function injectGate(html: string): string {
  const script = '<script>(function(){try{' + GATE_SCRIPT + '}catch(e){}})();</script>'
  const open = /<body(?:\s[^>]*)?>/i.exec(html)
  if (open === null) return `${script}${html}`
  const at = open.index + open[0].length
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}

/** 独立登录页。 */
function renderLoginPage(): string {
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
  <p>使用统一身份认证（CAS）登录</p>
  <button id="btn" onclick="location.href='/cas/login'">CAS 登录</button>
</div>
<script>location.href='/cas/login';</script>
</body>
</html>
`
}

/**
 * 遮罩在 DOM 就绪前先插一个占位层挡住首屏，等 /cas/me 返回后再决定
 * 是否显示登录面板。
 */
const GATE_SCRIPT = `
var id='dsh-cas-gate';
function hide(){var n=document.getElementById(id);if(n&&n.parentNode)n.parentNode.removeChild(n);}
function show(){
  if(document.getElementById(id))return;
  var d=document.createElement('div');
  d.id=id;
  d.setAttribute('style','position:fixed;inset:0;z-index:2147483644;background:#16181d;');
  (document.body||document.documentElement).appendChild(d);
}
show();
fetch('/cas/me',{headers:{accept:'application/json'}})
  .then(function(r){return r.json();})
  .then(function(d){if(d&&d.ok===true){hide();}else{window.__dshCasNeedLogin=true;}})
  .catch(function(){window.__dshCasNeedLogin=true;});
`