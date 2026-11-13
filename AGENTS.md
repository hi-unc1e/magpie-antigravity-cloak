# AGENTS.md

本仓库的 agent 工作约定。先读这里，再动代码。

## 项目是什么

`magpie-antigravity-cloak`：magpie 网关中间件，解决 Antigravity 上游按系统提示词指纹拦截、
伪装成 429 的问题。做法是在命中词里每段连续 3 个以上的字母或数字的第 1、第 2 个
字符后各插入一个零宽空格（U+200B）。只打断首字符的旧形态 2026-11-11 起已再次被拦。

- 上游：`hexiaolv/magpie-antigravity-cloak`（独立仓库，非 fork），本仓库是 `hi-unc1e` 的 fork
- 已本地安装进 magpie：`magpie plugin add /Users/dpdu/Desktop/opt/magpie-antigravity-cloak`
  （按完整路径操作；**不要**按名字装，会装成社区自动更新包）

## 硬性规则

1. **不改行为就不动测试；改行为必须先跑 `npm test`（当前 89 条断言）再提交。**
2. 词表 `DEFAULT_WORDS` 保持纯 ASCII，源码任何位置不得出现字面 U+200B，一律写 `"\u200B"`。
3. `test.mjs` 正文里不允许出现完整敏感词，fixture 一律用 `W` 里的拆分拼接构造。
4. 不变量（已固化成随机 300 组测试，违反即测试失败）：
   - 输出去掉零宽空格后必须与输入完全一致——除此之外不得有任何其他改动
   - 幂等：同一 body 处理两遍结果一致
   - **没插过零宽空格时必须返回 `undefined`**（不是 `body`）：返回对象会让 magpie 重新序列化整包 JSON，83KB 请求体上约 0.13ms，比钩子本身贵 3 倍
5. 中间件文件每秒热加载，但**改完源码要在 magpie 里 off→on 一次**确保宿主重载：
   ```sh
   magpie plugin off /Users/dpdu/Desktop/opt/magpie-antigravity-cloak
   magpie plugin on  /Users/dpdu/Desktop/opt/magpie-antigravity-cloak
   ```

## 本仓库版本的关键设计（与社区版的差异）

### 运行时事实（看 magpie 源码得出，别凭印象改）

- 中间件跑在网关进程的 **moejs**（`github.com/MoeForge/moejs`）里，不在 Bun 里
- 每个中间件编译一次，请求从 `sync.Pool` 取运行时（`internal/middleware/middleware.go`）；
  `put()` 只 `ReleaseCallData()`，不重新 `Load`，所以**模块顶层状态在同一池实例里跨请求保留**
  → `COMPILED` 正则缓存有效，每个池实例各一份
- 没有定时器 / `fetch` / Node API；只能相对路径 import；`console.log` 每分钟 60 行
- `onProvider` 返回 `undefined` → magpie 保留原始字节；返回对象 → 重新序列化写回（大 body 的主要开销）

### magpie 内置已做的事（别重复造）

`internal/gateway/codeassist.go` 的 `antigravityCloak` 在路由**之后**打断 5 行，
默认开（`prompt=default`，`prompt=as-written` 关）：billing header、
`built on anthropic's claude agent sdk`、Codex 两条 GPT-5 身份行、Hermes 旧人设。
规则与本仓库相同（每段 3+ 字母数字两处零宽），**但只看 system instruction**，
且认不出已打断的行（源码注释："A line already broken up (the antigravity-cloak
plugin's) isn't one any more and is left alone."）。
本仓库的增量 = omp 整句 + 更宽的词 + messages/input 位置 + deep。

### 本仓库的设计

- 入口 `onProvider(body, ctx)`，按 `ctx.provider.account` 白名单生效，
  默认 `accounts: ["antigravity"]`；其他供应商（Claude 官方订阅、Grok、DeepSeek、
  无 account 的 API key 供应商）一律原样通过
- 词表 13 个默认词：原 9 个（计费头、Claude 身份、`system-conventions`、`RFC 2119` 等）
  加上社区版 0.1.1–0.1.4 的 Codex 两条 GPT-5 prompt、Hermes persona、omp 的
  `RFC 2119 keywords: ...` 整句。打断方式与社区版 0.1.3 相同（每段字母数字两处零宽），
  另保留词表缓存、预筛和 `deep`
- 性能：词表正则编译一次按词表缓存（`compileCloak`），每条文本先过单正则预筛再逐词替换
- 覆盖协议字段：`system` / `systemInstruction` / `system_instruction` / `instructions`，
  chat 的 `messages` 与 responses 的 `input` 里 `role` 为 `system`/`developer` 的消息；
  deep 选项混淆整个请求体（跳过 `signature` 等键与超长无空格串）

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
  - 词表 6 个：
    1. `x-anthropic-billing-header`
    2. `Claude Agent SDK`
    3. `You are Codex, an agent based on GPT-5`
    4. `You are Codex, a coding agent based on GPT-5`
    5. `Hermes Agent, an intelligent AI assistant created by Nous Research`
    6. `RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.`
  - 源码注释确认实测触发词还包括 `You are a Claude agent, built on Anthropic's Claude Agent SDK`
    （作为 `Claude Agent SDK` 的上下文出现在 cases.json 里）
  - 选项只有 `extraWords` / `accounts` / `off`，**没有** `deep`、没有 `Claude Code`、
    `system-conventions` 等词、没有词表缓存与预筛（每请求重建正则）
  - 入口同为 `onProvider`，`accounts` 默认 `["antigravity"]`，按协议分支处理
    system 位置；`changed ? body : undefined`（无改动时返回 undefined 保留原请求）
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
  cases.json 的 `expect_request` 可直接当测试素材（无 `expect_request` 的条目表示应原样通过）。
  社区版发现的新触发词移植进 `DEFAULT_WORDS` 时要同步补测试并跑 `npm test`。
  Codex / Hermes / omp 整句和双零宽打断已在 2026-11-11 对齐进本仓库。
  快速回放（社区版全部用例跑本仓库中间件）：

## 提交与验证

- 提交信息用中文，说明动机与验证方式（参考 `git log`）
- 改动中间件后：`npm test` → `git commit` → magpie 里 off→on 重载
- 未 push 时保持本地，用户明确要求才 push 到 `origin`（`hi-unc1e/magpie-antigravity-cloak`）

## 已知边界（有意保留）

- `onProvider(null)` 会抛 TypeError——magpie 传的是 JSON.parse 结果，契约内不会发生
- 上游风控风险：绕过指纹拦截理论上可能导致 Google 账号风控，README「注意」章节已声明
