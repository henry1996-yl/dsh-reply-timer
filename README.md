# dsh-reply-timer · 会话回复计时器

在输入框下方（`conversation.composer.dock`）显示一条计时状态，解决「老是要等很久、
不知道是不是卡了、这一轮到底慢在哪」：

- **等待中**：`⏳ 14.2s · 正在生成 · 工具 2 次`，带一个会呼吸的圆点；
  副行显示 `模型仍在输出 · 最后活动 3s 前`。若超过 60 秒没有任何真实输出帧，
  改为 `⚠ 63s 没有新输出 · 可能停滞`（这是对「卡住」的诚实判断，而非浏览器自嗨）。
  等审批/提问时显示 `⏸ 等待你确认 · 计时已暂停` 并暂停累计。
- **结束后**：`✓ 本轮 31s`；点开可展开三段账本 `首字 / 工具耗时 / 生成耗时 / 工具次数`。
- **关闭 / 展开 / 减弱动效 / 多会话**：可点开关关闭计时器；展开明细；
  `prefers-reduced-motion` 下停止呼吸动画；`role="status" aria-live="polite"`。

## 架构（v2「自适应版」，双半场）

v1 是纯客户端：只读 `sessions.list` 的 `running` 位 + 本地定时器。它能显示「等了多久」，
但两个承诺没兑现——「心跳说明没卡住」是假的（本地脉冲只证明浏览器活着），
阶段/工具次数靠猜行字段（实际上一直是 0），而且没有「预计用时」。

v2 把计时搬到**宿主半场**，由真实事件驱动，客户端只做诚实的渲染：

| 半场 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 订阅 `session/event`（`turn/start`·`turn/end`·`tool/call`·`tool/result`·`approval/asked`·`user/message`）、`agent/assistant-stream`（首字帧时间戳）、`api-session/status`、`session/disposed`；测量三段耗时与工具并行区间；把 `lastDone` 与逐回合账本持久化到 `$DSH_HOME/storages/dsh-reply-timer/samples.json`；通过 `webServer.register({kind:'exact', path:'/__dsh-reply-timer/state'})` 暴露只读快照。 |
| Client | `client.js` | 以 `document.baseURI` 为基准轮询该路由（运行中 1s / 空闲 3s，同源相对 GET）；把宿主快照渲染进 composer dock；本地 250ms tick 仅用于平滑插值与圆点动画。 |

关键点：

- **真心跳**：`lastActivityAt` 来自真实 `AssistantStreamFrame` 与 session 事件，
  idle 超时才判停滞；工具正在跑（`openTools > 0`）时即便无输出也不误报。
- **三段账本**：首字 = `turn/start` → 首个输出帧（`text-delta`/`reasoning-delta` 等）；
  工具 = `tool/call`→`tool/result` 区间的并集（并行工具不重复计时，等待确认单独计）；
  生成 = 总时长扣掉工具与暂停。首字未观测到就写「未观测到」，不填 0。
- **持久化**：`node:fs/promises` 写到 `$DSH_HOME/storages/dsh-reply-timer/samples.json`
  （`DSH_HOME` 缺省 `~/.dsh`，与 dsh-cost-meter / dsh-ops / dsh-better-sidebar 一致；800ms 防抖），
  刷新页面 / 重启应用后账本仍在；不写入包目录，升级插件不会丢账本。不引入 `storageDomain`、不改会话数据、不加新事件类型。
- **只跟随本会话**：`conversation.composer.dock` 是 `scope: 'session'` 的 slot，注册时用
  `inject: (sessionId) => ({ t, sessionId })` 拿到归属会话 id，多标签页 / 多会话不会显示别人的计时。
- **安全**：路由用 `connection.requestRejection(req)` 做同源/回环校验（与 dsh-better-sidebar 一致），
  只接受 GET；客户端 `mode:'same-origin'`、`cache:'no-store'`，不带任何 token。
- 主题色 `var(--dsw-alias-*, fallback)`，纯 inline style，不注入 CSS、不用 iframe、
  不引用 Harness Client 包；所有资源在 `apply` 内用 `ctx.effect` 注册并可反注册（HMR 安全）。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半场（事件计时 + 持久化 + 只读路由），ESM |
| `client.js` | 客户端半场，懒加载 CJS 工厂，注册进 `conversation.composer.dock` |
| `samples.json` | 运行时生成的最近账本，落在 `$DSH_HOME/storages/dsh-reply-timer/`（首次回答后自动出现；不进仓库 / 发布包） |
| `cordis.patch.yml` | 插入一条 loader 记录 |
| `locale/{zh,en}.json` | 插件页展示用的 `meta.title` / `meta.description` / `meta.detail` |
| `icon.svg` | 插件图标 |
| `docs/DETAIL.md` + `docs/preview.svg` | DSH 插件详情页的特性图（`locale/*.json` 的 `meta.detail` 指向，只放一张自包含 SVG） |
| `screenshots.json` + `screenshots/*.png` | 市场门店卡片图（awesome-dsh-plugin 的 `probe-screenshots.mjs` 读仓库根这份 JSON；纯路径数组格式） |
| `SUBMISSION.md` | 向 awesome-dsh-plugin 投稿的中文操作指南 |
| `LICENSE` | MIT 许可证 |
| `.gitignore` | 排除运行时产物（`samples.json`、`*.tgz` 等） |
| `package.json` | `dsh.bundle.patch` + `dsh.client` 声明 |

用到的扩展点，均来自已安装可用插件 / 官方源码实测：

- `ctx.on("session/event" | "agent/assistant-stream" | "api-session/status" | "session/disposed", ...)`
- `ctx.webServer.register({ kind, path, handler(req, res) })` — Node 风格 `(req,res)`，`kind:'exact'`
- `ctx.connection.requestRejection(req)` — 请求来源校验
- `ctx.slots.inject(SLOT, () => ctx.slots.register({ name, id, order, inject }, Component))`
- `ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind(NS)`，包在 `ctx.effect` 里便于 HMR 反注册
- `require('react')`（shell 注入，含 `useSyncExternalStore`），不引用任何 Harness Client 包

## 验证状态

- 代码：`index.js` / `client.js` 经 Node `--check` 语法检查通过；
  所有 JSON / 清单有效；用 mock ctx 驱动真实事件序列做过端到端断言（10 项全过，
  三段账本 `总耗时 = 首字 + 工具 + 生成` 精确自洽）。
- 安装：`plugin_manager install_bundle` 返回 `application: applied`；`list_plugins` 显示
  `fiberPhase: active`；路由 `/__dsh-reply-timer/state` 已注册（无登录 cookie 的命令行请求
  被 `connection.requestRejection` 拦为 403，属预期）；宿主半区真实落盘
  `$DSH_HOME/storages/dsh-reply-timer/samples.json`。
- 浏览器：v2.0.0 完整重启 App 后 widget 已在输入框下方渲染；字体加深与「点空白 / Esc 收起明细」
  的交互修复均经用户实测确认。v2.1.0 另修了 slot 会话绑定（改用 `inject` 取 sessionId）、
  路由加 `__dsh-` 唯一前缀、持久化迁出包目录、轮询降频，并补了详情页 `docs/DETAIL.md`。
- v2.2.0 修了两个真实会话日志暴露的记账 bug：①开回合的 `user/message` 在 `turn/start`
  之后约 35ms 才落盘，旧代码据此把每个回合判成 36ms 的 `interrupted`，账本永远失真——现在
  权威回合只认 `turn/end`，该分支仅服务没观测到 `turn/start` 的回退路径；
  ②实例日志里存在 120s 的 `tool/call`→`tool/result` 空档，旧的 120s 空闲看门狗会把健康的
  长时间工具回合误杀——现在有未闭合工具时改用 30 分钟上限。另加 `tests/_replay-session.mjs`，
  拿真实会话日志（1610 事件 / 13 万帧）回放校验：四个已完成回合的时长、三段账本、工具计数
  全部与原日志一致。
- v2.3.0 修了子代理污染：`agent/assistant-stream` 与 `api-session/status` 只带 session id，
  拿不到 `origin`，子代理开流时会先建一条 `startedMidTurn` 的临时行，回合结束时照样写进
  `lastDone`，把账本挤满子代理的耗时。
  现在一旦 `session/event` 认出子代理，就把该 id 记进拒绝表并删掉临时行，两条只带 id 的
  通路也随之拒收。`tests/_test-host.mjs` 增加了一条子代理回归用例。
- v2.4.0 按真实日志重新标定了两个阈值（此前两者都会静默吃掉最该被记录的场景）：
  ①`MAX_TURN_MS` 从 30 分钟放宽到 6 小时——本工作区 122 个真实回合的时长分布是
  p50 56s / p90 562s / p99 3496s / 最长 4493s（75 分钟），旧的 30 分钟上限让 3.3% 的回合
  既不写账本也不留记录，而它们正是「这一轮到底慢在哪」最需要答案的那种回合；
  ②`STALL_MS` 从 20 秒放宽到 60 秒——实测每个 step 的「模型首字等待」p99 达 78 秒、
  6.1% 的 step 超过 20 秒，旧值会让界面在正常思考时反复闪「疑似停滞」。新增
  `tests/_test-longturn.mjs`，用假时钟跑一个 4493 秒的回合，断言它仍然写账本。
- v2.4.1 补回市场门店图：`screenshots.json` 恢复为**纯路径数组**（原包写的是
  `{"src","alt"}` 对象数组，awesome-dsh-plugin 的 `scripts/probe-screenshots.mjs`
  只认字符串数组 / `{"screenshots": [...]}` / 单键 URL 映射三种形态，对象元素的写法会
  被判为「every entry must be a non-empty string」而整份失效）。它与 `docs/DETAIL.md`
  是两个不同的消费方，各自都需要：前者供市场卡片，后者供 DSH 插件详情页。
- v2.5.0 去掉了「参考区间 / 参考中位」：按工具次数分桶的历史中位数在真实使用里既不准
  （同一桶内耗时跨度极大）也没人看，反而占着明细面板一行。现在明细只保留本轮实测的三段账本，
  不再持久化历史样本（`samples.json` 只剩 `lastDone` 与 `turnLedgers`）。
- 本包以 `link:` 软链安装时，改 `client.js` 无需重装；完整重启后改 `index.js` 需再次重启。
