# dsh-cas

DeepSeek Harness (dsh) 插件：实现 CAS SSO 单点登录，并按登录用户隔离会话归属。

宿主半（Node）注册 `/cas/*` 自控路由，影子接管 `/api/<method>` 做登录态校验与会话过滤，并向 `index.html` 注入登录遮罩；浏览器半（Web）提供登录遮罩与管理员 CAS 配置面板。

## 功能

- **CAS 单点登录**：CAS 2.0 协议（`/login`、`/validate`、`/logout`），支持单端点 `serverUrl` 与按客户端 IP 匹配的多端点 `endpoints` 表（`%` 通配）。
- **登录态管理**：HMAC-SHA256 无状态票据存于 HttpOnly Cookie，服务端维护吊销表，支持按用户批量登出；票据带 `jti`，登出即失效。
- **会话隔离**（`enforce: true` 时）：
  - 影子化 `/api/session.*`、`subagent.*`、`workspace.*` 等 28 个方法，未登录拒绝、越权访问拒绝；
  - `session.create` 成功后登记会话归属（会话本身无 owner 字段，归属记在 `~/.dsh/cas.yaml`）；
  - `session.list` / `session.search` / `workspace.list` 结果按归属过滤；
  - 实时事件流（`/api/events.mux`、`/api/events.host`，SSE + WebSocket 升级）逐帧按归属过滤，防止他人新建会话出现在侧边栏；子代理会话借父会话归属自动认领；
  - `settings.*`、`credentials.*`、`host.*`、`agentPreset.*` 等内置管理员专属方法，普通用户不可调用。
- **管理员配置**：登录后可在设置页保存/测试 CAS 连接配置（服务器地址、路径、`srcsys`、管理员用户名、证书校验开关），页面配置优先于 profile 配置。

## 安装

本插件是独立 dsh 插件包（非 harness 内置）。将本目录作为 `link:` 依赖安装到 web profile：

```sh
npx @deepseek-ai/dsh plugin --profile web add <本插件目录>
# 重启宿主后生效（插件集在启动时扫描）
```

## 配置

在宿主 profile 的 `~/.dsh/settings.yaml` 中，以插件 id `cas` 为键声明配置：

```yaml
cas:
  cas:
    serverUrl: "http://sso.example.com"
    loginPath: "/login"
    validatePath: "/validate"
    logoutPath: "/logout"
    servicePath: "/cas/callback"
    srcsys: "dsh"
    tlsRejectUnauthorized: true
    adminUsernames: ["admin1", "admin2"]
    endpoints:            # 可选：按客户端 IP 匹配多端点，首个匹配生效
      - ipPattern: "10.251.%"
        serverUrl: "http://sso-internal.example.com"
  auth:
    sessionTtlSeconds: 43200
    cookieName: "dsh_cas_user"
    cookieSameSite: "lax"
    unownedSessions: "admin"   # admin | everyone | none
    adminOnlyMethods: []       # 额外限定管理员的 /api 方法
  enforce: true
```

`settings.yaml` 中的 `cas:` 段经 `ctx.settings` 命名空间注册读取（`src/index.ts` 的 `settings.register('cas', Config)`），合并 schemastery 默认值与外挂 patch 的 config 后作为插件配置；**改动后需重启宿主生效**。管理员在页面 CAS 配置面板保存的设置会落盘到 `$DSH_HOME/cas.yaml`（`store.ts`），页面配置优先于 `settings.yaml`。

必填项：`cas.serverUrl` 或 `cas.endpoints` 至少其一。管理员角色由 `cas.adminUsernames` 中的 CAS 用户名（不区分大小写）映射得到。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `DSH_HOME` | 数据根目录（缺省 `~/.dsh`），状态文件位于 `$DSH_HOME/cas.yaml` |
| `DSH_SESSION_SECRET` | 登录态签名密钥；不设置时进程启动随机生成（重启后需重新登录） |

## 路由

### 自控路由（`/cas/*`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cas/login` | 302 到 CAS 登录页（支持 `?redirect=` 回跳记忆） |
| GET | `/cas/callback` | CAS 回跳：验证 ticket → 签发本地会话 cookie |
| POST | `/cas/logout` | 吊销当前票据并登出；`?skipCas=true` 可跳过 CAS 服务器登出 |
| GET | `/cas/me` | 当前登录态（未登录 401） |
| GET/POST | `/cas/connection` | 查看/保存 CAS 配置（保存需管理员） |
| POST | `/cas/connection/test` | 测试 CAS 连接（需管理员） |
| GET | `/cas/login.html` | 独立登录中转页 |

### 影子路由（`/api/*`，`enforce: true` 时）

以 exact 方式接管 `session.*`、`subagent.*`、`workspace.*`、`settings.*`、`credentials.*`、`host.*`、`agentPreset.*`、`events.mux`、`events.host` 等方法（清单见 `src/gate.ts` 的 `METHOD_RULES`）。未列出的方法直接放行，harness 新增方法不会因插件没跟上而整体不可用。

## 开发

```sh
npm install
npm run build      # tsc 编译 → lib/，并给 lib/client.js 包上浏览器 bundle 外壳
npm run typecheck  # tsc --noEmit
npm test           # node scripts/smoke.mjs && node scripts/integration.mjs
```

- `scripts/smoke.mjs`：CAS URL 构建、IP 模式匹配、ticket 解析、登录态票据、归属索引的运行时烟测。
- `scripts/integration.mjs`：假 CAS 服务器 + 最小 cordis 上下文驱动真实插件的端到端测试（登录 → 回调 → 隔离 → 登出 → 配置管理）。

## 目录结构

```
src/
  index.ts         宿主半入口：路由注册、遮罩注入、吊销表清扫
  cas.ts           CAS 客户端：登录/登出 URL、IP 端点匹配、ticket 验证（CAS 2.0）
  auth.ts          登录态票据（HMAC-SHA256）、吊销表、Cookie 工具
  config.ts        配置 Schema（schemastery）、默认值、校验、DSH_HOME 解析
  gate.ts          /api 影子路由：鉴权 + 会话归属过滤 + 响应改写 + SSE 代理
  events-ws.ts     WebSocket 升级拦截与事件流包装（实时帧逐帧过滤）
  http.ts          /cas/* 自控路由
  session-lookup.ts 登录态查询最小依赖（gate / http 共用）
  store.ts         状态落盘：页面保存的 CAS 配置 + 会话归属索引
  types.ts         共享类型
  client.ts        浏览器半：登录遮罩 + 管理员 CAS 配置面板
lib/               构建产物（勿手改）
scripts/
  wrap-client.mjs  给 lib/client.js 包上闭包工厂外壳
  smoke.mjs        运行时烟测
  integration.mjs  端到端装配测试
cordis.patch.yml   profile 层 patch：把插件注册进配置树
```

## 许可

Apache-2.0
