# AGENTS.md — dsh-cas 开发规范

本文件约束 AI 代理（及人工）在 dsh-cas 仓库内的开发与修改行为。详细插件 API 契约见 `.agents/skills/dsh-plugin-dev/SKILL.md`，修改代码前先读它。

## 项目事实（不可臆造）

- 宿主半入口 `src/index.ts`：插件 id `dsh-cas`，`inject = ['webServer', 'settings']`；`apiProxy` 用 `ctx.get` 延迟获取，未就绪时不阻止加载。
- 插件配置来自 `ctx.settings` 命名空间 `cas`（`~/.dsh/settings.yaml` 的 `cas:` 段，经 schemastery Config 校验），外挂 patch config 作为 `base` 叠加；`validateConfig` 失败时**降级仅路由模式**，不抛异常（可用页面配置面板补全后重启）。
- 浏览器半 `src/client.ts`：构建产物 `lib/client.js` 由 `scripts/wrap-client.mjs` 包上闭包工厂外壳（banner/intro/footer 与 harness `packages/client/tsdown.client.ts` 契约一致）。**client.ts 刻意无 import、无 ESM 语法**，所需类型在文件内重复声明。
- 插件 API 契约来自 harness/cordis：`ctx.webServer.register`、`ctx.webServer.tapIndex`、`ctx.apiProxy`、`ctx.effect`、`ctx.inject`。**禁止臆造任何未在 SKILL.md 中出现的宿主 API**。
- 0.1.5 起 `connection.rpc.handle` 对 out-of-tree 插件回归失效；新增 RPC 端点用 `connection.fetch.register()`，本插件当前未使用，如需要再评估。

## 架构决策（改动前必须理解）

1. **影子化 HTTP 路由而非 RPC 拦截**：`rpc.handle` 拿不到 Cookie，无法识别调用者；`webServer` 匹配规则是 exact 优先、其次最长前缀，connection 插件把 `/api` 注册为 prefix，故用 exact 注册 `/api/<method>` 即可合法接管（`src/gate.ts`）。真实数据在同进程直接调用 `ctx.apiProxy` 具名方法，不经 HTTP，不会自环。
2. **归属索引**：会话本身无 owner 字段；归属记在 `~/.dsh/cas.yaml`（`$DSH_HOME/cas.yaml`）：`session.create` 成功时认领（`claimCreated`），`host/session-added` 带 `parentSessionId` 的子代理会话借父会话归属认领（`claimSubagentChild`）。
3. **两种归属判定**（`src/gate.ts` 的 `allowed` / `owned`，勿混用）：
   - `allowed`（owner / unowned 按策略）：用于**列表与访问层**（session.list、session.history 等），保留「启用插件前的历史无主会话」对管理员的可见性；
   - `owned`（严格 owner）：用于**实时事件流（SSE/WebSocket）**——新建会话在 harness 广播 `session-added` 时尚未认领（无主窗口），用 `allowed` 会让管理员实时看到他人刚建的会话。
4. **WS 事件流隔离**（`src/events-ws.ts`）：浏览器的 `events.mux`/`events.host` 是 WebSocket 升级（GET + `Upgrade: websocket`），HTTP 路由不参与升级分发。用 `hijackEventUpgrades` 摘掉 http server 的 upgrade 监听器换成包装（登录态校验 + AsyncLocalStorage 帧过滤器），再 `wrapEventStreams` 包装 `apiProxy.events.mux/host` 逐帧过滤。**不与 connection 插件抢 `registerUpgrade`**（同路径重复注册抛错）。
5. **错误信封**：`RpcError` 是闭合判别联合，没有 `unauthorized`/`forbidden`；业务拒绝一律 HTTP 200 + `{ ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }`，不要用 `internal`（部分客户端会重试）。
6. **域映射查表**：方法前缀 → `apiProxy` 域名的映射不规则（`session→sessions`、`agentPreset→agentPresets`、`goal→goals`），见 `src/gate.ts` 的 `DOMAIN_OF`；切分用 `method.lastIndexOf('.')`。
7. **配置经 `ctx.settings` 命名空间读取**：harness 不会把 `~/.dsh/settings.yaml` 的段自动折进 `apply(ctx, config)` 的 config 参数——必须 `inject = ['settings']` 并 `ctx.settings.register('cas', Config, { applies: 'restart', base: config })` + `scope.get()` 读（dsh-wecom 同款）。`register` 抛错（命名空间已注册等）时回退 patch config。`applies: 'restart'` 表明配置改动需重启生效，不要臆造 `live`。

## 代码规范

- 插件入口必须**具名导出** `apply`，禁止 `export default`（丢失 `inject` 元数据）。
- 所有注册（路由、tap、定时器、包装器）必须可撤销：经 `ctx.effect(disposer, tag)` 登记，HMR/卸载自动清理。裸 `setInterval` 禁止。
- 日志用 `ctx.logger`（本插件内 `log()` 走 `ctx.logger.warn`），禁止 `console.log`。
- `src/*.ts` 是 ESM + NodeNext，import 带 `.js` 扩展名；`src/client.ts` 例外（编译后包 CJS 外壳，内部用 `var`/`module.exports` 语义，不用 TS 特有语法如 `enum`/`satisfies`）。
- 窄化宿主服务类型时声明本地 interface（如 `ApiProxyLike`、`UpgradeServer`），不依赖 harness 内部 schema 模块。
- 新增影子方法：在 `src/gate.ts` 的 `METHOD_RULES` 表加一行（`sessionIdField` / `filter` / `filterWorkspace` / `claim` / `adminOnly` 之一或组合）；需要 AbortSignal 的方法同时加进 `SIGNAL_METHODS`。未列出的方法保持放行，不要改成黑名单全接管。

## 数据与密钥

- 状态文件路径：`$DSH_HOME/cas.yaml`（缺省 `~/.dsh/cas.yaml`），含 CAS 配置与 `ownership` 索引。
- `DSH_SESSION_SECRET` 未设置时进程内随机生成——重启后已发 cookie 全部失效，这是预期行为（启动时有日志提示）。
- 不要把密钥、内部 CAS 地址写进 patch 或默认配置。

## 构建与测试

```sh
npm run build       # tsc -p tsconfig.json && node scripts/wrap-client.mjs
npm run typecheck   # tsc --noEmit
npm test            # node scripts/smoke.mjs && node scripts/integration.mjs
```

- 改 `src/` 后先 `npm run build`，测试跑的是 `lib/` 产物。
- `lib/` 是构建产物，**不要手改**；改 `src/` 再 build。
- `smoke.mjs` 覆盖：CAS URL 构建、IP 模式匹配、ticket 解析、票据签发/验签/吊销、归属索引落盘重载。改对应逻辑时必须同步扩展。
- `integration.mjs` 是端到端装配测试：假 CAS 服务器 + 最小 cordis 上下文（`ctx.get`/`ctx.effect`/`ctx.inject`）+ 假 `webServer`（Map 路由表 + `request()`）+ 假 `apiProxy`（只实现被影子化的方法）+ 假 `settings`（`makeSettings` 模拟 settings.yaml 的 `cas:` 段，外挂 config 为空）。新增影子方法时，在假 `apiProxy` 里补对应方法并在用例中加断言。
- 测试中假 `req` 必须 `class extends Readable`（`Object.assign(Readable.from(...))` 会破坏迭代）；假 `res` 必须补 `on`/`off`（`invoke` 会挂 `close` 监听）。

## 验证手段（无宿主环境）

- 优先跑 `npm test`；行为验证以 `scripts/integration.mjs` 的假上下文模式为准。
- 真实宿主验证流程：`npx @deepseek-ai/dsh plugin --profile web add <本目录>` → 重启宿主 → `npx @deepseek-ai/dsh --profile web --dump-config` 确认插件行出现 → `npx @deepseek-ai/dsh --profile web "test"` 跑任务。

## 参考（只读）

- 插件骨架与 API 契约：`.agents/skills/dsh-plugin-dev/SKILL.md`（同目录镜像：`.opencode/`、`.soloncode/`、`.workbuddy/`、`.codeartsdoer/`，以 `.agents` 为准）。
- harness 源码（只读，勿改）：`D:\workspace_node\deepseek-harness`；会话隔离参考实现：`D:\workspace_node\dsh-user-manager`；CAS SSO 参考实现：`D:\workspace_py\data-ai-openai-server\web\proxy.ts`。

## 禁止事项

- 禁止臆造宿主 API、事件名、`apiProxy` 方法名——一切以 SKILL.md 与 harness 源码为准。
- 禁止把实时事件流过滤从 `owned` 改回 `allowed`（会重新引入「管理员实时看到他人会话」缺陷）。
- 禁止把 `session.export` 改成直接代理（GET + query 不走 JSON 信封，自环风险），维持 501 显式不接管。
- 禁止在 client.ts 引入 import / ESM / TS 特有语法。
- 禁止提交 `node_modules/`、`lib/` 以外的构建副产物；`lib/` 是否入库以 `.gitignore` 为准，改动前先查。
