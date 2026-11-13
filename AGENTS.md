# AGENTS.md

本仓库的 agent 工作约定。先读这里，再动代码。

## 项目是什么

`magpie-antigravity-cloak`：magpie 的**网关中间件**（middleware）。Antigravity 上游会把带特定
指纹字符串的系统提示词拦掉，伪装成 `429 Resource has been exhausted`；本中间件在命中词里
每段连续 3 个以上的字母或数字的第 1、第 2 个字符后各插一个零宽空格（U+200B），让上游的
关键字匹配失效。只插零宽空格，去掉即完全还原。

说清楚边界，别再搞混：

- **是中间件，不是供应商插件。** 不登录、不存 token、不发请求、不管额度；不会让 magpie
  多出一个供应商。它只在请求路过网关、且这次要发给 antigravity 账号时改提示词。
- **跑在 magpie 网关进程的 moejs 引擎里**，不在 Bun 插件宿主里。没有定时器、没有 `fetch`、
  没有 Node API；只能相对路径 import；只有 `console.log`（每分钟最多 60 行）。
- **依赖已存在的 antigravity 账号**。本机当前状态（2026-11-13）：
  `magpie provider antigravity` 显示 `ring0am76@gmail.com` / Google AI Ultra / 14 个模型放 4 个 /
  `used by Claude Code`。没有这个账号，中间件永远不会被调用。
- 上游：`hexiaolv/magpie-antigravity-cloak`（独立仓库，非 fork），本仓库是 `hi-unc1e` 的 fork。
- 已本地安装进 magpie：`magpie plugin add /Users/dpdu/Desktop/opt/magpie-antigravity-cloak`
  （按完整路径操作；**不要**按名字装，会装成社区自动更新包）。

## 事实库（改代码前先看，别凭印象）

每条都注明出处。要复核就去看源码或本地二进制，不要猜。

| 事实 | 出处 |
|---|---|
| `onProvider` 返回 `undefined` → magpie 保留**原始字节**；返回对象 → 整包 JSON 重新序列化写回（大 body 上这是钩子成本的大头） | `internal/middleware/run.go`：`Run.Tried` 的 `case out != nil: body = out`；`apply` 注释「a call's time is all it costs the request: the JSON read into the runtime and written back out, which is most of it on a large body」 |
| 中间件只编译一次，每个请求从 `sync.Pool` 取一个运行时；`put()` 只 `ReleaseCallData()` 不重新 `Load`，所以**模块顶层状态在同一池实例里跨请求保留** | `internal/middleware/middleware.go`：`mw.pool`、`newInst`、`get`、`put` |
| 每个中间件有自己的 `ctx.state`，同一请求的各钩子共享；`ctx.state` 里放的对象在同一次请求内可复用 | `internal/middleware/run.go`：`Run` 注释、`acquire` 里的 `,"state":{}` |
| `onProvider` 每换一个供应商尝试就调用一次，每次拿到的都是 `onRequest` 处理后的请求体 | magpie 文档「网关中间件 → 钩子」 |
| `ctx.provider` 有 `id` / `name` / `account` / `model`；API 密钥供应商没有 `account` | 同上 |
| magpie **内置**在路由之后、发往 Antigravity 之前打断 5 行，默认开，`magpie provider set antigravity prompt=as-written` 关 | `internal/gateway/codeassist.go`：`agTurnedAway`、`antigravityCloak`、`codeAssistBody`（`p.PromptAsWritten`） |
| 内置那 5 行：`x-anthropic-billing-header:`、`built on anthropic's claude agent sdk`、`You are Codex, an agent based on GPT-5`、`You are Codex, a coding agent based on GPT-5`、`Hermes Agent, an intelligent AI assistant created by Nous Research` | 同上 `agTurnedAway` 数组 |
| 内置规则与本仓库相同：每段 3+ 字母数字的第 1、第 2 字符后各一个零宽 | 同上 `agBreaks`（`if j-i >= 3 { at = append(at, i+1, i+2) }`） |
| 内置**只看 system instruction**，不看 messages | 同上：`codeAssistBody` 只处理 `r.System` |
| 内置认不出已被打断的行，会原样放过 | 同上注释：「A line already broken up (the antigravity-cloak plugin's) isn't one any more and is left alone.」 |
| 内置还会把这类 429 识别成「不是额度」并给提示 | `AG_TURNED_AWAY` / `AG_CODEX` / `AG_HERMES` 三条 hint 文案 |
| 中间件跑在 moejs（`github.com/MoeForge/moejs`）里；每个流式事件过一次钩子约 1 微秒，Bun 往返要几十微秒 | magpie 文档「运行方式」；二进制里可见 `github.com/MoeForge/moejs/engine` |
| 只能用相对路径 import；没有 `node_modules` / 定时器 / `fetch` / Node API；`console.log` 每分钟 60 行 | magpie 文档「导入 / 能用什么」 |
| magpie 每秒检查插件文件与 `plugins.json`，有变化就重新加载中间件；on/off 与 options 变更触发宿主重载 | magpie 文档「修改后」 |
| 本地路径装的插件没有版本可比，`magpie plugin update` 不管它 | `plugin-updates.json` 里只有 `@magpie-community/*`；magpie 界面文案「its source no longer has … nothing to update from」 |

复核命令：

```sh
magpie --version
magpie provider antigravity
magpie provider | grep -i prompt          # prompt=as-written 的说明
strings -a /Applications/magpie.app/Contents/MacOS/magpie | grep -i "<关键字>"
curl -s https://raw.githubusercontent.com/yetone/magpie/main/internal/middleware/run.go
curl -s https://raw.githubusercontent.com/yetone/magpie/main/internal/gateway/codeassist.go
```

## 硬性规则

1. **不改行为就不动测试；改行为必须先跑 `npm test`（当前 89 条断言）再提交。**
2. 词表 `DEFAULT_WORDS` 保持纯 ASCII，源码任何位置不得出现字面 U+200B，一律写 `"\u200B"`。
3. `test.mjs` 正文里不允许出现完整敏感词，fixture 一律用 `W` 里的拆分拼接构造。
4. 不变量（已固化成随机 300 组测试，违反即测试失败）：
   - 输出去掉零宽空格后必须与输入完全一致——除此之外不得有任何其他改动
   - 幂等：同一 body 处理两遍结果一致
   - **没插过零宽空格时必须返回 `undefined`**（不是 `body`）：返回对象会让 magpie 重新序列化
     整包 JSON，83KB 请求体上约 0.13ms，比钩子本身（0.04ms）贵 3 倍
5. 中间件文件每秒热加载，但**改完源码要在 magpie 里 off→on 一次**确保宿主重载：
   ```sh
   magpie plugin off /Users/dpdu/Desktop/opt/magpie-antigravity-cloak
   magpie plugin on  /Users/dpdu/Desktop/opt/magpie-antigravity-cloak
   ```
6. 不要用 `fetch` / 定时器 / Node API，也不要 import 插件目录以外的文件——moejs 里没有这些。

## 本仓库版本的关键设计

- 入口 `onProvider(body, ctx)`，按 `ctx.provider.account` 白名单生效，
  默认 `accounts: ["antigravity"]`；其他供应商（Claude 官方订阅、Grok、DeepSeek、
  无 account 的 API key 供应商）一律原样通过并返回 `undefined`
- 词表 13 个默认词：原 9 个（计费头、Claude 身份、`system-conventions`、`RFC 2119` 等）
  加上社区版 0.1.1–0.1.4 的 Codex 两条 GPT-5 prompt、Hermes persona、omp 的
  `RFC 2119 keywords: ...` 整句
- 打断方式与社区版 0.1.3 / magpie 内置相同（每段字母数字两处零宽）
- 性能：词表正则按词表编译一次缓存（每池实例一份，上限 32 条）；每条文本先过单正则预筛；
  命中时用合并成一条 alternation 的正则一遍扫完；没改动返回 `undefined`
- 覆盖协议字段：`system` / `systemInstruction` / `system_instruction` / `instructions`，
  chat 的 `messages` 与 responses 的 `input` 里 `role` 为 `system`/`developer` 的消息；
  deep 选项混淆整个请求体（跳过 `signature` 等键与超长无空格串）
- 相对 magpie 内置的增量：omp 整句、更宽的词、messages/input 位置、deep

## 对照版本：@magpie-community/middleware-antigravity-cloak

后续维护时对照用。**不安装它，只做参考。**

- 位置：`magpie-community/plugins` 仓库 `packages/antigravity-cloak` 子目录
  （<https://github.com/magpie-community/plugins/tree/main/packages/antigravity-cloak>）
- 维护者：yetone（magpie 作者）。registry.json 条目名
  `@magpie-community/middleware-antigravity-cloak`，kind: middleware
- 快照（2026-11-13 核对，版本 0.1.5，目录最后 commit
  `2b7da486ac5c` 2026-11-12 "say what a 429 with quota left means, and how to find the words"）：
  - 0.1.5 **只改 README 与版本号**，中间件源码与 `cases.json` 与 0.1.4 逐字节相同
    （源码 4217 字节，sha256 `67fcec64…`；cases 10025 字节，sha256 `da8d9e17…`）
  - 新增文档：「429 又回来了怎么办」——剩余额度下仍 429 时的二分定位法与 `extraWords` 用法
  - 回放验证：社区版 16 个 cases 喂给本仓库中间件，**16 个逐字节一致**
  - 上一版 0.1.4 是 `9e07c7062795` 2026-11-11：补 omp 首行 `RFC 2119 keywords: ...`
  - 0.1.3 是 `d5f4214effae` 2026-11-10：只在首字符后插一个零宽空格已再次 429，
    改为每个连续 3 字母/数字的第 1、第 2 字符后各插一个（`/[A-Za-z0-9]{3,}/`）
  - 词表 6 个：计费头、`Claude Agent SDK`、Codex 两条、Hermes、omp 整句
  - 选项只有 `extraWords` / `accounts` / `off`，**没有** `deep`、没有 `Claude Code`、
    `system-conventions` 等词、没有词表缓存与预筛（每请求重建正则）
  - 入口同为 `onProvider`，`changed ? body : undefined`（没改动返回 undefined）
  - 源码明文致谢本仓库上游：`After hexiaolv's magpie-antigravity-cloak (MIT)`
  - hexiaolv 上游仓库截至 2026-11-13 仍停在 2026-10-09，没有双零宽和新触发词
- **别和社区版 `antigravity` 供应商插件搞混**（`packages/antigravity`，2026-11-13 已是 0.1.8）：
  那是「登录 Antigravity 并发请求」的供应商插件，不是本中间件。它近期修了版本探测超时、
  gemini-4 的 400 重试、sessionId 生成，以及对 DeepSeek Harness 某段提示词的改写。
  最后一项会**改写原文**（不是只插零宽），与本仓库「只插零宽、去掉即还原」的不变量冲突，
  不要照搬到本仓库。
- 对照更新方法：
  ```sh
  # 看社区版目录有没有新 commit
  curl -s "https://api.github.com/repos/magpie-community/plugins/commits?path=packages/antigravity-cloak&per_page=5"
  # 拉最新源码与用例对照
  curl -s "https://raw.githubusercontent.com/magpie-community/plugins/main/packages/antigravity-cloak/antigravity-cloak.middleware.js"
  curl -s "https://raw.githubusercontent.com/magpie-community/plugins/main/packages/antigravity-cloak/cases.json"
  ```
  重点关注：新触发词、打断方式（几处零宽、插在哪）、onProvider 语义、新协议字段。
  社区版发现的新触发词移植进 `DEFAULT_WORDS` 时要同步补测试并跑 `npm test`。
  Codex / Hermes / omp 整句和双零宽打断已在 2026-11-11 对齐进本仓库。
  快速回放（社区版全部用例跑本仓库中间件）：`npm run replay`

## 曾经搞错的事（别再犯）

1. **说「中间件没跑过，因为没装 antigravity 供应商」——错。**
   2026-11-04 查 `magpie providers` 时确实没有 antigravity；2026-11-13 再看已经有了
   （`ring0am76@gmail.com`，`used by Claude Code`）。**结论有时效，报状态前重新查一次**，
   别拿几天前的输出当现在的事实。
2. **把「中间件」和「供应商插件」混为一谈——错。**
   本仓库只改提示词；登录、发请求、额度、模型列表全在供应商插件那边
   （社区版 `packages/antigravity`，或 `pi-antigravity`）。用户问「稳定性」时要分清是哪一层。
3. **以为「每个请求有自己的运行时」= 模块顶层状态不保留——错。**
   运行时是从 `sync.Pool` 取的实例，`put()` 不重新 `Load`，模块顶层状态跨请求保留。
   所以词表正则缓存有效（每个池实例一份）。
4. **以为「返回 body 和返回 undefined 没区别」——错。**
   返回对象会触发整包 JSON 重新序列化。83KB body 上 0.165ms vs 0.040ms。
   没改动必须返回 `undefined`。
5. **以为「magpie 什么都不做，全靠这个插件」——不准确。**
   内置 `antigravityCloak` 默认就打断那 5 行，只是只看 system instruction、
   且认不出已打断的行。本仓库的增量是 omp 整句 + 更宽的词 + messages/input 位置 + deep。
6. **只按首字符插一个零宽空格——已失效。**
   2026-11-11 起 Google 再次拦截该形态，必须每段 3+ 字母数字插两处。

## 提交与验证

- 提交信息用中文，说明动机与验证方式（参考 `git log`）
- 改动中间件后：`npm test` → `git commit` → magpie 里 off→on 重载
- 引入社区版变更前后可跑 `npm run replay`，确认社区版用例仍逐字节一致
- 用户明确要求才 push 到 `origin`（`hi-unc1e/magpie-antigravity-cloak`）

## 已知边界（有意保留）

- `onProvider(null)` 会抛 TypeError——magpie 传的是 JSON.parse 结果，契约内不会发生
- 上游风控风险：绕过指纹拦截理论上可能导致 Google 账号风控，README「注意」章节已声明
- 词表里有几条（`Claude Code`、`Anthropic's official CLI`、`system-conventions`、`RFC 2119`）
  来自 cli-proxy-api 的默认指纹，magpie 用真实账号验证的结论是这些单独提法会放行。
  保留是为了覆盖面，属于「宁可多打断」的取舍，不是已验证的触发词。
