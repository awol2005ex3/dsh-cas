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

// @dsh-version 0.1.7-rc.2
import type { Context } from '@deepseek-ai/cordis'
import { RevocationList } from './auth.js'
import {
  BUILTIN_ADMIN_ONLY_METHODS,
  Config,
  ENV_SESSION_SECRET,
  readCasSettings,
  readSessionSecret,
  resolveAuth,
  resolveCas,
  resolveDshHome,
  validateConfig,
  type CasPluginConfig,
} from './config.js'
import { registerApiGate, type ConnectionFetchRoutes, type GatewayInvoke } from './gate.js'
import { hijackEventUpgrades, wrapEventStreams, type EventsStreams } from './events-ws.js'
import { registerCasRoutes, type RouteRegistrar } from './http.js'
import { StateStore } from './store.js'
import type { CasConfig, PluginConfig, ResolvedAuthConfig, ResolvedCasConfig } from './types.js'

/** 插件 id —— 在组合后的插件树中必须唯一。 */
export const name = 'dsh-cas'

/**
 * 声明依赖的宿主服务。webServer 是硬依赖（整套机制都建立在它的路由表上）；
 * apiProxy / connection / typertGateway 用 `ctx.get` + `ctx.inject` 取，避免它们
 * 未就绪时把本插件挡在加载之外。
 *
 * 注意：dsh ≥ 0.1.7 已**没有** `ctx.settings.register()`，插件配置由 profile 条目
 * `id: cas` 的 config 承载（见下方 apply 的说明），故此处不再声明 `settings`。
 */
export const inject = ['webServer']

export { Config }
export type { PluginConfig }

/** 吊销表清扫间隔。 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

/**
 * 插件入口（具名导出，禁止 export default —— 会丢失 inject 元数据）。
 *
 * 有效配置来源：**profile 条目 `id: cas` 上的 config**。dsh ≥ 0.1.7 起插件配置
 * 不再走 `ctx.settings.register()` 命名空间（harness 已把旧的 `~/.dsh/settings.yaml`
 * 的 `cas:` 段一次性并入该条目），`Config` 里标记 `.volatile()` 的字段解析后是稳定
 * 引用：设置页改写时 loader 原地更新引用里的值、**不重挂插件**，只在本插件的 ctx
 * 上广播 `loader/volatile-update`。
 *
 * 因此本入口把所有装配动作收进 `start()`，可整体撤销并重跑：首装、配置热改、
 * 宿主服务迟到就绪三条路径共用它。cookie 签名密钥、归属索引、吊销表刻意留在
 * `start()` 之外——配置热改不应让已登录用户的 cookie 失效。
 *
 * 无论字段是引用（新 dsh）还是普通值（旧 dsh / 测试替身），一律经
 * `readCasSettings()` 解包成普通值再用。
 */
export function apply(ctx: Context, config: CasPluginConfig): void {
  const log = (message: string): void => { ctx.logger.warn(`dsh-cas: ${message}`) }

  // 长期存活的进程级状态。
  const store = new StateStore(`${resolveDshHome()}/cas.yaml`)
  store.load()

  const secret = readSessionSecret()
  const revocations = new RevocationList()

  if (process.env[ENV_SESSION_SECRET] === undefined) {
    log(`未设置 ${ENV_SESSION_SECRET}，已使用随机密钥：重启后需要重新登录`)
  }

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

  /* ── 可重装配的运行期服务 ── */

  /** 迟到就绪的宿主服务，缓存起来供每一轮装配复用。 */
  const deps: { connFetch?: ConnectionFetchRoutes; gateway?: GatewayInvoke } = {}
  /** 当前这一轮装配的撤销函数；undefined 表示尚未装配。 */
  let teardown: (() => void) | undefined

  const register: RouteRegistrar = route => webServer.register(route)

  /**
   * 按当前配置装配全部路由与包装器，替换上一轮。
   *
   * 幂等且可重入：首装、`loader/volatile-update`、宿主服务迟到就绪三条路径共用它。
   * 所有注册（HTTP 路由、fetch 影子路由、upgrade 劫持、事件流包装）都登记进本轮
   * disposer，重装 / fiber 卸载时整体回滚，不会出现「旧闭包残留 + 新闭包叠加」。
   */
  function start(): void {
    teardown?.()
    const disposers: (() => void)[] = []
    teardown = () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch (err) { log(`撤销注册失败：${String(err)}`) }
      }
    }

    const effectiveConfig = readCasSettings(config)

    const validation = validateConfig(effectiveConfig)
    if (!validation.valid) {
      log(`配置不完整（${validation.reason}），以仅路由模式加载（可在设置页中补全）`)
    }

    // 合并管理员专属方法与配置追加项。
    const auth = resolveAuth({
      ...effectiveConfig.auth,
      adminOnlyMethods: [...BUILTIN_ADMIN_ONLY_METHODS, ...(effectiveConfig.auth?.adminOnlyMethods ?? [])],
    })

    /* ── CAS 配置（页面保存优先于 profile 配置） ── */

    const savedCas = store.getCas()
    const currentCas: { value: ResolvedCasConfig } = {
      value: resolveCas(savedCas ?? effectiveConfig.cas, auth),
    }

    const getCasConfig = (): CasConfig | undefined => store.getCas()
    const setCasConfig = (newCas: CasConfig): void => {
      store.setCas(newCas)
      currentCas.value = resolveCas(newCas, auth)
      log('CAS 配置已更新')
    }

    /* ── /cas/* 路由 ── */

    disposers.push(registerCasRoutes({
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
    }, register))

    // 独立 CAS 登录跳转页（整页登录场景）。http.ts 已挂 /cas/login.html，
    // 这里再兜一份整页遮罩（webServer 路由表被抢占时仍可用）。
    try {
      disposers.push(register({
        kind: 'exact',
        path: '/cas/login.html',
        handler: (_req, res) => {
          const response = res as { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          response.end(renderLoginPage())
        },
      }))
    } catch (err) {
      log(`注册登录页失败：${String(err)}`)
    }

    if (!effectiveConfig.enforce || !validation.valid) {
      if (effectiveConfig.enforce) log('CAS 配置不完整，仅提供登录路由（会话隔离未启用）')
      else log('enforce=false，仅提供登录路由')
      return
    }

    /* ── /api/session/* 影子路由（会话隔离） ── */
    // 旧架构的 `apiProxy` 已废弃（ctx.get('apiProxy') 恒为 undefined），改走
    // `connection.fetch.register` + `ctx.typertGateway.invoke`。
    if (deps.connFetch === undefined || deps.gateway === undefined) {
      log('connection.fetch / typertGateway 尚未就绪，会话隔离待其就绪后启用')
    } else {
      mountApiGate(disposers, effectiveConfig, auth, deps.connFetch, deps.gateway)
    }

    /* ── 实时事件流（WebSocket）隔离 ── */
    // 侧边栏由 events.mux / events.host 实时驱动，harness 全量广播，必须逐帧按
    // owner 过滤，否则切换 CAS 用户后仍能实时看到他人会话。
    mountEventIsolation(disposers, auth)
  }

  /** 接管 `/api/session/*`：登录态校验 + 归属过滤/认领。 */
  function mountApiGate(
    disposers: (() => void)[],
    effectiveConfig: PluginConfig,
    auth: ResolvedAuthConfig,
    connFetch: ConnectionFetchRoutes,
    gateway: GatewayInvoke,
  ): void {
    const gate = registerApiGate({
      config: effectiveConfig,
      auth,
      store,
      gateway,
      isRevoked: jti => revocations.has(jti),
      secret,
      log,
    }, connFetch)
    disposers.push(gate.dispose)
    log(`已接管 ${gate.methods.length} 个 /api/session/* 方法`)
  }

  /** 拦截 WebSocket 升级并包装事件流上游，按登录态与归属逐帧过滤。 */
  function mountEventIsolation(disposers: (() => void)[], auth: ResolvedAuthConfig): void {
    const filterCtx = { store, auth, log }
    const authView = { auth, secret, isRevoked: (jti: string) => revocations.has(jti) }

    // 升级拦截：webServer.server 未就绪时 hijackEventUpgrades 内部判空并跳过（打日志）。
    disposers.push(hijackEventUpgrades(
      { ...filterCtx, authView },
      webServer as unknown as { server?: import('node:http').Server },
    ))

    // 包装 apiProxy.events.*：必须在浏览器建连前安装（apply 时窗口期内无已登录连接）。
    const setupEvents = (events: EventsStreams): void => {
      disposers.push(wrapEventStreams(filterCtx, events))
    }
    const apiProxyNow = ctx.get('apiProxy') as { events?: EventsStreams } | undefined
    if (apiProxyNow?.events !== undefined) {
      setupEvents(apiProxyNow.events)
    } else {
      // 取 apiProxy 必须用 inject 兜底：本插件只 inject webServer，apply 时 apiProxy
      // 常未构造、ctx.get 返回 undefined（表现为「时好时坏」）。
      ctx.inject(['apiProxy'], (apiCtx) => {
        const ap = (apiCtx as unknown as { apiProxy?: { events?: EventsStreams } }).apiProxy
        if (ap?.events === undefined) {
          log('apiProxy.events 不可用，实时事件流隔离未启用（列表层仍过滤）')
          return
        }
        setupEvents(ap.events)
      })
    }
  }

  /* ── 首装 ── */
  start()

  /*
   * 配置热更新（dsh ≥ 0.1.7）。
   *
   * volatile-only 的配置改动**不重挂插件**：loader 把新值提交进运行中的 volatile
   * 引用后，在本插件的 ctx 上广播 `loader/volatile-update`（见 cordis-plugin-loader
   * 的 `Entry._commitVolatile`）。这里据此重读配置并整体重装路由——cookie 签名密钥
   * 与归属索引不受影响，已登录用户不必重新登录。
   *
   * 事件名由 @deepseek-ai/cordis-plugin-loader 增补到 cordis 的 Events，本插件不
   * 依赖该包，故用宽松调用避免类型耦合（运行时 `ctx.on` 接受任意事件名）；ctx.on 的
   * 监听随 fiber 卸载自动反注册。改写若被 loader 判定为「普通配置变更」，插件会整体
   * 重挂 —— 那时 apply 重新执行，同样会拿到新配置，两条路径都覆盖。
   */
  const onEvent = (ctx as unknown as {
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  }).on
  onEvent?.call(ctx, 'loader/volatile-update', () => {
    log('配置已更新，正在重新装配路由')
    start()
  })

  // connection.fetch / typertGateway 迟到就绪时补装一次会话隔离。
  ctx.inject(['connection', 'typertGateway'], (injectedCtx) => {
    const injected = injectedCtx as unknown as {
      connection?: { fetch?: ConnectionFetchRoutes }
      typertGateway?: GatewayInvoke
    }
    // harness 里 `ctx.connection` 是 HostConnectionHandle，含 `.rpc`/`.fetch`
    // 两个 getter；exact 路由注册在 `ctx.connection.fetch.register`。
    deps.connFetch = injected.connection?.fetch
    deps.gateway = injected.typertGateway
    if (deps.connFetch === undefined || deps.gateway === undefined) {
      log('connection.fetch / typertGateway 不可用，会话隔离未启用（CAS 登录仍可用）')
      return
    }
    start()
  })

  // 登录遮罩：注入在 <body> 起始处，应用脚本之前。与配置无关，整轮装配只挂一次。
  const disposeTap = webServer.tapIndex(html => injectGate(html))
  ctx.effect(() => disposeTap, 'dsh-cas: index tap')

  // 整轮装配的兜底撤销：正常路径由 start() 自己接管上一轮，这里兜住 fiber 卸载。
  ctx.effect(() => () => { teardown?.(); teardown = undefined }, 'dsh-cas: assembly')

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