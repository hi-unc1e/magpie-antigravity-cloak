# magpie-antigravity-cloak

解决 Antigravity 渠道恒定 429 的 [magpie](https://usemagpie.ai) **网关中间件**（middleware）。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green)](https://nodejs.org)

## 它是什么，不是什么

一句话：**agent 的请求路过 magpie 网关时，它只在“这次要发给 Antigravity 账号”的那一刻，把系统提示词里几个会被上游拦掉的词打断；别的一概不碰。**

| | 说明 |
|---|---|
| 它**是** | magpie 的网关中间件，一个 `*.middleware.js` 单文件 + `package.json`，导出 `onProvider(body, ctx)` |
| 它**不是** | 供应商插件。它不登录、不存 token、不发请求、不管额度，也不会让 magpie 多出一个叫 antigravity 的供应商 |
| 它**依赖** | magpie 里已经有一个 antigravity 账号（`magpie provider antigravity` 能列出账号），否则它永远不会被调用 |
| 它**只改** | `ctx.provider.account === "antigravity"` 的请求。Claude 官方订阅、Grok、DeepSeek、API 密钥供应商收到的提示词一个字节都不变 |
| 它**改什么** | 只插零宽空格（U+200B），不增删改任何其他字符；去掉零宽空格就完全还原原文 |

运行位置也值得说清楚：它**不在** Bun 插件宿主里，而是跑在 magpie 网关进程自己的 Go JavaScript 引擎 **moejs** 里（每个流式事件都要过钩子，微秒级）。所以没有定时器、没有 `fetch`、没有 Node API。细节见[运行时](#运行时moejs与缓存)。

## 问题现象

在 magpie 里用 antigravity 供应商的模型（如 `antigravity/gemini-3.7-flash-tiered`）时，Claude Desktop / Claude Code 发出的请求**恒定返回 429**：

```
API Error: Request rejected (429) · Antigravity: Resource has been exhausted (e.g. check quota).
```

换账号、等额度恢复都无效，而标题生成等后台请求和 Codex 请求却正常。

## 根因

Antigravity 上游**按请求文本里的特定指纹字符串拦截**，并统一伪装成 `429 Resource has been exhausted`，实际并不是额度问题。见 [magpie#666](https://github.com/yetone/magpie/issues/666)。

通过抓取真实请求体逐层裁剪回放，实测确认的触发词有两类：

| 触发词 | 来源 | 说明 |
|---|---|---|
| `x-anthropic-billing-header` | Claude Code 塞进 system 的计费标记行 | **关键发现**。curl 手工构造的探测没有这行，所以怎么测都是 200、复现不出来；真实请求必带，所以 100% 触发 |
| `Claude Code` / `Claude Agent SDK` 等 | Claude Code 的系统提示词身份行 | issue #666 确认，与 [cli-proxy-api PR #6280](https://github.com/router-for-me/CLIProxyAPI/pull/6280) 的默认指纹一致 |

这也解释了为什么之前所有"在 system 里混淆 Claude Code 字样"的修复都无效——词表里没有计费头这个词。

## 解决方案

在命中词里每段连续 3 个以上的字母或数字的第 1、第 2 个字符后各插入一个零宽空格（U+200B）。只在首字符后插一个的旧做法，2026-11-11 起已再次被 Antigravity 拦成 429。

```
输入: x-anthropic-billing-header
打断: x-a·n·thropic-b·i·lling-h·e·ader
      · 表示一个肉眼不可见的 U+200B（不在单独的 "x" 后面）
```

上游的关键字匹配失效，请求正常通过；人眼看不出差别，模型效果基本不受影响。此思路来自 [cli-proxy-api PR #6280](https://github.com/router-for-me/CLIProxyAPI/pull/6280)，本插件在其基础上：

- 覆盖实测新发现的计费头触发词
- **只改发给 Antigravity 的请求**：使用 `onProvider(body, ctx)` 按 `ctx.provider.account` 匹配（默认 `accounts: ["antigravity"]`），Claude 官方订阅、Grok、DeepSeek 等其他供应商拿到的提示词保持原样
- 默认覆盖所有系统提示词位置（`system` / `systemInstruction` / `system_instruction` / `instructions`，以及 chat 的 `messages`、Responses 的 `input` 里 `role` 为 `system` 或 `developer` 的消息）
- 可选 `deep` 模式，把用户消息、工具描述、thinking 块也一起混淆

## 安装

两种方式任选其一。

### 方式一：clone 到本地再装（推荐，也是本仓库的维护方式）

```sh
# 换成你自己的 fork 或本仓库
git clone https://github.com/hi-unc1e/magpie-antigravity-cloak.git
cd magpie-antigravity-cloak
npm test   # 可选：先跑一遍单测确认环境正常
magpie plugin add "$(pwd)"
```

本地安装的好处：magpie 每秒检查插件文件，改 `antigravity-cloak.middleware.js` 立即生效，方便自定义词表或调试。

> 注意：magpie 不识别插件短名，`options` 等操作都要用完整路径。

### 方式二：从 magpie 插件页装

打开 magpie 的 **插件** 页 → 切到 **发现** 标签 → 拉到最底部 **「已有想装的？」** 输入框，填入仓库地址后点 **安装**。

### 别装错：社区版是另一个包

`@magpie-community/middleware-antigravity-cloak`（`magpie-community/plugins` 仓库，yetone 维护）是同一思路的**另一个实现**，不是本仓库的上游，会每小时自动更新。

```sh
magpie plugin add antigravity-cloak   # ← 装的是社区版，不是本仓库
```

两者差异见 [AGENTS.md](AGENTS.md) 的对照章节。本仓库是 `hexiaolv/magpie-antigravity-cloak` 的 fork，但词表、作用域、性能优化都已自己演进。

## 配置（可选）

```sh
magpie plugin options "$(pwd)" '{"extraWords": ["自定义词"], "accounts": ["antigravity"], "off": false, "deep": false}'
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `extraWords` | `[]` | 追加自定义敏感词（纯文本，大小写不敏感） |
| `accounts` | `["antigravity"]` | 生效的账号种类（匹配 `ctx.provider.account`）；其他供应商原样通过 |
| `off` | `false` | 设为 `true` 时完全放行，不混淆 |
| `deep` | `false` | 设为 `true` 时深度混淆整个请求体（用户消息、tools、thinking 也一起），覆盖面更大但更激进，可能影响模型效果 |

默认词表：`x-anthropic-billing-header`、`Claude Agent SDK`、`Claude Code`、`Anthropic's official CLI`、`system-conventions`、`system_conventions`、`system-directive`、`system_directive`、`RFC 2119`，以及社区版 0.1.1–0.1.4 补上的 `You are Codex, an agent based on GPT-5`、`You are Codex, a coding agent based on GPT-5`、`Hermes Agent, an intelligent AI assistant created by Nous Research`、`RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.`。

插件文件每秒热加载，改完 `antigravity-cloak.middleware.js` 立即生效，无需重启 magpie。

## 验证

```sh
npm test
```

跑 89 条断言（作用域仅限 `antigravity`、各协议 system 形态、双零宽打断、Codex/Hermes/omp 新触发词、深度模式、幂等、还原等价、base64 跳过、正则特殊字符、重叠匹配、词表缓存隔离、`undefined` 返回值语义、合并扫描与逐词逻辑等价，以及 300 组随机不变量）。

端到端验证（用真实 Claude Code 打 magpie，因为手工 curl 复现不出计费头触发词）：

```sh
ANTHROPIC_BASE_URL=http://localhost:3425 ANTHROPIC_AUTH_TOKEN=<你的 magpie key> \
  claude -p "回复一个字：好" --model antigravity/gemini-3.7-flash-tiered
```

预期输出 `好`，magpie 路由记录（`~/.config/magpie/routing/`）里该请求状态为 200。

## 工作原理

```
Claude Desktop / Claude Code
        │ 真实请求（system 带计费头与身份字样）
        ▼
magpie 网关 (localhost:3425)
        │ onProvider(body, ctx) ← 只在 ctx.provider.account 为 antigravity 时生效
        ▼
Antigravity 上游（敏感词里每段字母数字的第 1、第 2 字符后各有一个 U+200B，指纹匹配失效，放行）
其他供应商      （完全不动，原样收到请求）
```

实现要点：

- **没改动就不返回对象**：`onProvider` 返回 `undefined` 时 magpie 保留**原始字节**；返回对象则要把整包 JSON 重新序列化一遍。实测 83KB 请求体上这一步约 0.13ms，而钩子本身只要 0.04ms——所以只有在真的插了零宽空格时才返回 body
- **一遍扫完**：词表合并成一条 alternation 正则，不再逐词各跑一遍（默认词表下与逐词结果逐字一致）
- **幂等**：已混淆的词中间多了零宽空格，不再匹配，重复处理结果一致
- **可还原**：去掉零宽空格即还原原文
- **保守跳过**：`signature` 等字段、超长无空格疑似 base64 的字符串不碰
- **大小写不敏感**，按词长从长到短匹配，避免短词破坏长词

### 运行时（moejs）与缓存

中间件不在 Bun 里，而是跑在 magpie 网关进程内的 Go JavaScript 引擎 moejs 里（每个流式事件都要过钩子，一微秒级）。每个中间件只编译一次，请求从运行时的池子里取一个，**模块顶层状态在同一个池实例里跨请求保留**，所以词表正则缓存是有效的（池里每个实例各一份，最多 32 条）。

约束：只能用相对路径导入插件目录里的文件（没有 `node_modules`），没有定时器、没有 `fetch`、没有 Node API；只有 `console.log`（每分钟最多 60 行）。

## 与 magpie 内置机制的关系

magpie 自己（`internal/gateway/codeassist.go`，v0.1.1641 起）在路由**之后**、发往 Antigravity 之前，会把下面 5 行打断，默认开启，`magpie provider set antigravity prompt=as-written` 可关：

1. `x-anthropic-billing-header:`
2. `built on anthropic's claude agent sdk`
3. `You are Codex, an agent based on GPT-5`
4. `You are Codex, a coding agent based on GPT-5`
5. `Hermes Agent, an intelligent AI assistant created by Nous Research`

规则与本中间件相同（每段 3 个以上字母或数字的第 1、第 2 字符后各一个零宽），而且**只看 system instruction**，不看 messages；已经打断过的行它认不出来，会原样放过（源码注释原话：*“A line already broken up (the antigravity-cloak plugin's) isn't one any more and is left alone.”*）。

所以本中间件补的是内置没做的部分：

| 本中间件额外做的 | 内置做不做 |
|---|---|
| omp 首行 `RFC 2119 keywords: ...` | 不做 |
| `Claude Code`、`Anthropic's official CLI`、`system-conventions` 等更宽的词 | 不做（内置用更精确的整行） |
| chat 的 `messages` / responses 的 `input` 里的 system、developer 消息 | 不做（只看 system instruction） |
| `deep` 模式（用户消息、tools、thinking 一起） | 不做 |
| 先于内置生效，把活儿接下来 | 已打断的行它就不动 |

把 magpie 设成 `prompt=as-written` 后，内置不再打断，就只剩本中间件。内置还会识别这类 429 并给出提示（“whatever quota is left, so it is not a quota”）。

## 文件结构

```
magpie-antigravity-cloak/
├── antigravity-cloak.middleware.js      # 中间件主体（onProvider 入口）
├── test.mjs                             # 本地单测（89 条断言）
├── scripts/replay-community-cases.mjs   # 拿社区版 cases.json 回放本仓库中间件
├── package.json                         # magpie 插件清单
├── AGENTS.md                            # 维护者/agent 必读：事实库、规则、对照版本
├── LICENSE
└── README.md
```

## 排查记录（为什么这个 bug 难找）

这个问题的狡猾之处在于**所有手工探测都复现不出来**：

1. curl 构造请求 → 200，一切正常
2. 只混淆 `Claude Code` 等身份字样 → 真实请求依然 429
3. 抓取真实 Claude Code 请求体（95KB）回放 → 429，终于复现
4. 逐层裁剪：去掉 tools → 仍 429；只留 system → 429；二分 system 三块 → 第一块（仅 84 字符的计费标记行）单独触发
5. 在块内继续二分 → `x-anthropic-billing-header:` 是确切的触发字符串
6. 词表加上它 → 完整真实请求回放 200 ✓

教训：**根因探测必须用真实客户端流量**，手工构造的请求少一行计费标记就永远复现不出来。

## 429 又回来了怎么办

（来自社区版 0.1.5 的排查指南）

如果 magpie 还显示有额度、同一模型同一账号的其他请求（比如标题生成）也能通，却仍然收到 `429 Resource has been exhausted`，那这就是指纹拒绝，不是额度问题：**系统提示词里还有别的内容被匹配到了**。常见来源不是 agent 自己的提示词，而是自定义提示词，或者别的插件/扩展往提示词里加的内容。

定位方法：用一句很短的 user 消息重放失败的请求，把 system 提示词逐段拿掉（一次一半），直到 429 消失；再把让 429 回来的那段里**有代表性的一句**加进 `extraWords`，或者直接在那段文字的来源处改写或删掉它。

本中间件只打断你给它的那些词和句子，不会隐藏任意提示词——遇到新的指纹，得把新词补进词表（`extraWords` 或 `DEFAULT_WORDS`）。

## 文档里的结论从哪来

本文和 [AGENTS.md](AGENTS.md) 里关于 magpie 行为的描述，都不是猜的，出处是 magpie 源码：

| 结论 | 出处 |
|---|---|
| 返回 `undefined` 保留原始字节，返回对象要重新序列化 | `internal/middleware/run.go` 的 `Run.Tried`（`case out != nil: body = out`）与 `apply` 注释 |
| 中间件编译一次、请求从池里取运行时、模块顶层状态跨请求保留 | `internal/middleware/middleware.go` 的 `sync.Pool`、`newInst`、`get`/`put` |
| 跑在 moejs 里、只能用相对路径 import、无定时器/fetch/Node API | magpie 文档「插件开发 → 网关中间件 → 运行方式 / 能用什么」 |
| 内置已打断哪 5 行、只看 system instruction、认不出已打断的行 | `internal/gateway/codeassist.go` 的 `agTurnedAway`、`antigravityCloak`、`codeAssistBody` |
| `prompt=as-written` 可关内置打断 | `magpie provider` 帮助文本 |

改代码前想确认某条 magpie 行为，**去看源码或本地二进制，不要凭印象**：

```sh
magpie --version
strings -a /Applications/magpie.app/Contents/MacOS/magpie | grep -i "<关键字>"
curl -s https://raw.githubusercontent.com/yetone/magpie/main/internal/middleware/run.go
```

## 注意

维护者提醒：改写这些字样绕过上游拦截，理论上存在账号被 Google 风控的风险，请自行权衡。

## 致谢

- [yetone/magpie](https://github.com/yetone/magpie) — issue [#666](https://github.com/yetone/magpie/issues/666) 的根因分析
- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — [PR #6280](https://github.com/router-for-me/CLIProxyAPI/pull/6280) 的零宽空格混淆思路
- [hexiaolv/magpie-antigravity-cloak](https://github.com/hexiaolv/magpie-antigravity-cloak) — 本仓库的上游
- [magpie-community/plugins](https://github.com/magpie-community/plugins/tree/main/packages/antigravity-cloak) — 同思路的社区实现，双零宽打断与新触发词的主要来源

## License

[MIT](LICENSE)
