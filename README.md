# dsh-reply-timer · 会话回复计时器

在输入框下方（`conversation.composer.dock`）显示一条计时状态，解决「老是要等很久、
不知道是不是卡了、这一轮到底慢在哪」：

- **等待中**：`⏳ 14.2s · 正在生成 · 工具 2 次`，带一个会呼吸的圆点；
  副行显示 `模型仍在输出 · 最后活动 3s 前`。若超过 20 秒没有任何真实输出帧，
  改为 `⚠ 23s 没有新输出 · 可能停滞`（这是对「卡住」的诚实判断，而非浏览器自嗨）。
  等审批/提问时显示 `⏸ 等待你确认 · 计时已暂停` 并暂停累计。
- **结束后**：`✓ 本轮 31s`；点开可展开三段账本 `首字 / 工具耗时 / 生成耗时 / 工具次数`，
  以及按「工具次数分桶」的历史参考区间 `参考 18–40s · 中位 26s`。
  样本不足时只写 `再观测 N 轮后给出参考区间`，**绝不编倒计时**。
- **关闭 / 展开 / 减弱动效 / 多会话**：可点开关关闭计时器；展开明细；
  `prefers-reduced-motion` 下停止呼吸动画；`role="status" aria-live="polite"`。

## 架构（v2「自适应版」，双半场）

v1 是纯客户端：只读 `sessions.list` 的 `running` 位 + 本地定时器。它能显示「等了多久」，
但两个承诺没兑现——「心跳说明没卡住」是假的（本地脉冲只证明浏览器活着），
阶段/工具次数靠猜行字段（实际上一直是 0），而且没有「预计用时」。

v2 把计时搬到**宿主半场**，由真实事件驱动，客户端只做诚实的渲染：

| 半场 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 订阅 `session/event`（`turn/start`·`turn/end`·`tool/call`·`tool/result`·`approval/asked`·`user/message`）、`agent/assistant-stream`（首字帧时间戳）、`api-session/status`、`session/disposed`；测量三段耗时与工具并行区间；把 `lastDone` 与历史样本持久化到 `samples.json`；通过 `webServer.register({kind:'exact', path:'/reply-timer/state'})` 暴露只读快照。 |
| Client | `client.js` | 以 `document.baseURI` 为基准轮询该路由（运行中 400ms / 空闲 1500ms，同源相对 GET）；把宿主快照渲染进 composer dock；本地 200ms tick 仅用于平滑插值与圆点动画。 |

关键点：

- **真心跳**：`lastActivityAt` 来自真实 `AssistantStreamFrame` 与 session 事件，
  idle 超时才判停滞；工具正在跑（`openTools > 0`）时即便无输出也不误报。
- **三段账本**：首字 = `turn/start` → 首个输出帧（`text-delta`/`reasoning-delta` 等）；
  工具 = `tool/call`→`tool/result` 区间的并集（并行工具不重复计时，等待确认单独计）；
  生成 = 总时长扣掉工具与暂停。首字未观测到就写「未观测到」，不填 0。
- **参考区间**：按 `toolCount` 分 `plain / few / many` 三桶，各保留最近 20 个样本，
  `n ≥ 5` 才用 0.2 / 0.5 / 0.8 分位给出区间；不足就明说还差几轮。
- **持久化**：`node:fs/promises` 写到包内 `samples.json`（800ms 防抖），
  刷新页面 / 重启应用后账本与历史仍在；不引入 `storageDomain`、不改会话数据、不加新事件类型。
- **安全**：路由用 `connection.requestRejection(req)` 做同源/回环校验（与 dsh-better-sidebar 一致），
  只接受 GET；客户端 `mode:'same-origin'`、`cache:'no-store'`，不带任何 token。
- 主题色 `var(--dsw-alias-*, fallback)`，纯 inline style，不注入 CSS、不用 iframe、
  不引用 Harness Client 包；所有资源在 `apply` 内用 `ctx.effect` 注册并可反注册（HMR 安全）。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半场（事件计时 + 持久化 + 只读路由），ESM |
| `client.js` | 客户端半场，懒加载 CJS 工厂，注册进 `conversation.composer.dock` |
| `samples.json` | 运行时生成的历史样本 / 最近账本（首次回答后自动出现；已被 `.gitignore` 排除，不进仓库 / 发布包） |
| `cordis.patch.yml` | 插入一条 loader 记录 |
| `locale/{zh,en}.json` | 插件页展示用的 `meta.title` / `meta.description` |
| `icon.svg` | 插件图标 |
| `screenshots.json` + `screenshots/` | 插件市场用的界面示意图（1–8 张，相对路径） |
| `SUBMISSION.md` | 向 awesome-dsh-plugin 投稿的中文操作指南 |
| `LICENSE` | MIT 许可证 |
| `.gitignore` | 排除运行时产物（`samples.json`、`*.tgz` 等） |
| `package.json` | `dsh.bundle.patch` + `dsh.client` 声明 |

用到的扩展点，均来自已安装可用插件 / 官方源码实测：

- `ctx.on("session/event" | "agent/assistant-stream" | "api-session/status" | "session/disposed", ...)`
- `ctx.webServer.register({ kind, path, handler(req, res) })` — Node 风格 `(req,res)`，`kind:'exact'`
- `ctx.connection.requestRejection(req)` — 请求来源校验
- `ctx.slots.inject(SLOT, () => ctx.slots.register({ name, id, order }, Component))`
- `ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind(NS)`，包在 `ctx.effect` 里便于 HMR 反注册
- `require('react')`（shell 注入，含 `useSyncExternalStore`），不引用任何 Harness Client 包

## 验证状态

- 代码：`index.js` / `client.js` 经 Electron (`ELECTRON_RUN_AS_NODE=1`) `--check` 语法检查通过；
  所有 JSON / 清单有效；用 mock ctx 驱动真实事件序列做过端到端断言（10 项全过，
  三段账本 `总耗时 = 首字 + 工具 + 生成` 精确自洽）。
- 安装：`plugin_manager install_bundle` 返回 `application: applied`；`list_plugins` 显示
  `fiberPhase: active`；路由 `/reply-timer/state` 已注册（无登录 cookie 的命令行请求
  被 `connection.requestRejection` 拦为 403，属预期）；宿主半区真实落盘 `samples.json`。
- 浏览器：完整重启 App 后，widget 已在输入框下方渲染；字体加深与「点空白 / Esc 收起明细」
  的交互修复均经用户实测确认。
- 参考区间需要攒够 5 轮同类回复才出现，这是刻意设计——样本不足时绝不编造倒计时。
- 本包以 `link:` 软链安装时，改 `client.js` 无需重装；完整重启后改 `index.js` 需再次重启。
