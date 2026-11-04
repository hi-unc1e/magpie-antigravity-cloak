# AGENTS.md

本仓库的 agent 工作约定。先读这里，再动代码。

## 项目是什么

`magpie-antigravity-cloak`：magpie 网关中间件，解决 Antigravity 上游按系统提示词指纹拦截、
伪装成 429 的问题。做法是在敏感词（`x-anthropic-billing-header`、`Claude Code` 等）第一个
字符后插入零宽空格（U+200B），让上游关键字匹配失效。

- 上游：`hexiaolv/magpie-antigravity-cloak`（独立仓库，非 fork），本仓库是 `hi-unc1e` 的 fork
- 已本地安装进 magpie：`magpie plugin add /Users/dpdu/Desktop/opt/magpie-antigravity-cloak`
  （按完整路径操作；**不要**按名字装，会装成社区自动更新包）

## 硬性规则

1. **不改行为就不动测试；改行为必须先跑 `npm test`（当前 70 条断言）再提交。**
2. 词表 `DEFAULT_WORDS` 保持纯 ASCII，源码任何位置不得出现字面 U+200B，一律写 `"\u200B"`。
3. `test.mjs` 正文里不允许出现完整敏感词，fixture 一律用 `W` 里的拆分拼接构造。
4. 不变量（已固化成随机 300 组测试，违反即测试失败）：
   - 输出去掉零宽空格后必须与输入完全一致——除此之外不得有任何其他改动
   - 幂等：同一 body 处理两遍结果一致
5. 中间件文件每秒热加载，但**改完源码要在 magpie 里 off→on 一次**确保宿主重载：
   ```sh
   magpie plugin off /Users/dpdu/Desktop/opt/magpie-antigravity-cloak
   magpie plugin on  /Users/dpdu/Desktop/opt/magpie-antigravity-cloak
   ```

## 本仓库版本的关键设计（与社区版的差异）

- 入口 `onProvider(body, ctx)`，按 `ctx.provider.account` 白名单生效，
  默认 `accounts: ["antigravity"]`；其他供应商（Claude 官方订阅、Grok、DeepSeek、
  无 account 的 API key 供应商）一律原样通过
- 词表 9 个默认词（含计费头触发词 `x-anthropic-billing-header`、`system-conventions`、
  `RFC 2119` 等）；社区版 5 个（多出 Codex 两条 GPT-5 prompt 和 Hermes persona，
  少计费头等——见下方对照）
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
- 快照（2026-11-04 记录，版本 0.1.2，目录最后 commit
  `ac11dcbb92b8` 2026-10-26 "Hermes Agent's earlier persona is broken too"）：
  - 词表 5 个：
    1. `x-anthropic-billing-header`
    2. `Claude Agent SDK`
    3. `You are Codex, an agent based on GPT-5`
    4. `You are Codex, a coding agent based on GPT-5`
    5. `Hermes Agent, an intelligent AI assistant created by Nous Research`
  - 源码注释确认实测触发词还包括 `You are a Claude agent, built on Anthropic's Claude Agent SDK`
    （作为 `Claude Agent SDK` 的上下文出现在 cases.json 里）
  - 选项只有 `extraWords` / `accounts` / `off`，**没有** `deep`、没有计费头以外的
    `system-conventions` 等词、没有词表缓存与预筛（每请求重建正则）
  - 入口同为 `onProvider`，`accounts` 默认 `["antigravity"]`，按协议分支处理
    system 位置；`changed ? body : undefined`（无改动时返回 undefined 保留原请求）
  - 源码明文致谢本仓库上游：`After hexiaolv's magpie-antigravity-cloak (MIT)`
- 对照更新方法：
  ```sh
  # 看社区版目录有没有新 commit
  curl -s "https://api.github.com/repos/magpie-community/plugins/commits?path=packages/antigravity-cloak&per_page=5"
  # 拉最新源码与用例对照
  curl -s "https://raw.githubusercontent.com/magpie-community/plugins/main/packages/antigravity-cloak/antigravity-cloak.middleware.js"
  curl -s "https://raw.githubusercontent.com/magpie-community/plugins/main/packages/antigravity-cloak/cases.json"
  ```
  重点关注：新触发词（尤其 Codex/Hermes 类 agent persona 词，本仓库词表尚缺）、
  onProvider 语义变化、新协议字段。cases.json 的 `expect_request` 可直接当测试素材。
  社区版发现的新触发词移植进 `DEFAULT_WORDS` 时要同步补测试并跑 `npm test`。

## 提交与验证

- 提交信息用中文，说明动机与验证方式（参考 `git log`）
- 改动中间件后：`npm test` → `git commit` → magpie 里 off→on 重载
- 未 push 时保持本地，用户明确要求才 push 到 `origin`（`hi-unc1e/magpie-antigravity-cloak`）

## 已知边界（有意保留）

- `onProvider(null)` 会抛 TypeError——magpie 传的是 JSON.parse 结果，契约内不会发生
- 上游风控风险：绕过指纹拦截理论上可能导致 Google 账号风控，README「注意」章节已声明
