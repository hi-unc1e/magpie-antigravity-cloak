// antigravity-cloak：Antigravity 429 问题中间件
//
// 根因（实测定位，比 issue #666 的结论更进一步）：
//   Antigravity 上游按请求文本里的特定指纹字符串拦截，并统一伪装成
//   "429 Resource has been exhausted"，实际并不是额度用完了。
//   实测确认的触发词有两类：
//   1. 计费头标记：Claude Code 会往 system 里塞一行
//      "x-anthropic-billing-header" 开头的计费信息（含 cc_version 等），
//      上游按这个字符串拦截。curl 手工构造的探测没有这行，
//      这是之前修复一直失败、排查一直"复现不出来"的原因。
//   2. 身份字样："Claude Code" / "Claude Agent SDK" 等
//      （issue #666 确认，cli-proxy-api PR #6280 的默认指纹）。
//
// 做法（参考 cli-proxy-api PR #6280，2026-11-11 起与社区版 0.1.3 同步）：
//   命中词里每段连续 3 个以上的字母或数字，在第 1、第 2 个字符后
//   各插一个零宽空格。只在首字符后插一个，2026-11-11 起已再次被
//   Antigravity 拦下（实测：x\u200b-anthropic-billing-header、C\u200blaude Agent SDK）。
//   没有这种长串的短词（如两字自定义词）仍在整段首字符后插一个。
//   人眼看不出差别，模型也基本不受影响，但上游的关键字匹配失效。
//   只改发给 Antigravity 的请求：入口是 onProvider(body, ctx)，
//   按 ctx.provider.account 判断账号种类（默认 accounts: ["antigravity"]）；
//   其他供应商、Claude 官方订阅之类拿到的提示词保持原样。
//   默认只混淆系统提示词（system / systemInstruction / system_instruction /
//   instructions，chat 协议下 messages 里 role 为 system/developer 的消息，
//   以及 Responses 协议下 input 里的 system/developer 消息）；
//   deep 选项会混淆整个请求体（用户消息、tools、thinking 也一起）。
//
// 安装：magpie plugin add "$(pwd)"（在仓库根目录执行；短名不识别，
//   options 等操作也要用完整路径）
//
// 可选配置（magpie plugin options <完整路径> '<json>'）：
//   { "extraWords": ["自定义敏感词"], "accounts": ["antigravity"], "off": true, "deep": true }
//   off 设为 true 时完全放行；accounts 是生效的账号种类（ctx.provider.account），
//   留空或不存在时默认只对 antigravity 生效；deep 设为 true 时深度混淆整个请求体，
//   覆盖面更大但更激进。
//
// 性能：词表正则按词表内容编译一次并缓存（跨请求复用），
//   每条文本先用单个预筛正则判一次"是否含任一敏感词"，
//   未命中就直接返回，避免对大体积请求体做 N 遍全量扫描。

// 零宽空格：用转义写法，源码里不留肉眼不可见的字符（词表请保持纯 ASCII）
const ZERO_WIDTH = "\u200B"

// 默认敏感词，全部纯 ASCII。不要把零宽字符写进词表，会被 normalizeWords 过滤掉。
// 大小写不敏感。
const DEFAULT_WORDS = [
  "x-anthropic-billing-header",
  "Claude Agent SDK",
  "Claude Code",
  "Anthropic's official CLI",
  "system-conventions",
  "system_conventions",
  "system-directive",
  "system_directive",
  "RFC 2119",
  // 社区版 0.1.1–0.1.4 补上的触发词（Codex / Hermes / omp 首行）
  "You are Codex, an agent based on GPT-5",
  "You are Codex, a coding agent based on GPT-5",
  "Hermes Agent, an intelligent AI assistant created by Nous Research",
  "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
]

// 递归时不碰的字段：签名类、标识类字段被改写会导致上游校验失败
const SKIP_KEYS = new Set(["signature", "id", "session", "sessionId", "requestId"])

// 词表 → 编译结果（预筛正则 + 逐词替换正则）的缓存，key 为词表规范化后的拼接
const COMPILED = new Map()
const MAX_CACHE = 32

// 去重、去掉已含零宽空格的（用户误贴混淆文本）、按长度从长到短排序，
// 避免短词先匹配破坏长词
function normalizeWords(extra) {
  const words = DEFAULT_WORDS.concat(Array.isArray(extra) ? extra : [])
  const seen = new Set()
  const out = []
  for (const w of words) {
    if (typeof w !== "string" || w.length < 2 || w.includes(ZERO_WIDTH)) continue
    const k = w.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  out.sort((a, b) => b.length - a.length)
  return out
}

// 词表是纯文本不是正则，先转义特殊字符
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// 同一套词表只编译一次：预筛正则（无 g，可安全复用 test）+
// 逐词替换正则（带 g，String.replace 每次调用都会重置 lastIndex，可安全复用）
function compileCloak(extra) {
  const words = normalizeWords(extra)
  const key = words.join("\u0000")
  const hit = COMPILED.get(key)
  if (hit) return hit

  const cloak = {
    gate: words.length ? new RegExp(words.map(escapeRegExp).join("|"), "i") : null,
    passes: words.map((w) => new RegExp(escapeRegExp(w), "gi")),
  }
  if (COMPILED.size >= MAX_CACHE) COMPILED.clear()
  COMPILED.set(key, cloak)
  return cloak
}

// 打断一段连续字母数字：第 1、第 2 个字符后各一个零宽空格。
// 与社区版 cloaker 一致：/ [A-Za-z0-9]{3,} /
function breakRun(run) {
  return run[0] + ZERO_WIDTH + run[1] + ZERO_WIDTH + run.slice(2)
}

// 命中整段后：段内每个 3 字以上的字母数字串都打断。
// 一段都没有（两字自定义词等）则退回到整段首字符后插一个。
// 已打断的串不再是连续字母数字，外层词也因为中间多了零宽空格而不再匹配，幂等。
function cloakMatch(m) {
  const broken = m.replace(/[A-Za-z0-9]{3,}/g, breakRun)
  if (broken !== m) return broken
  return m[0] + ZERO_WIDTH + m.slice(1)
}

// 在 text 的每个敏感词上做 cloakMatch。
// 每个词用正则整体替换一遍：已混淆的词中间多了零宽空格，
// 不再匹配，天然幂等。
function cloakText(text, cloak) {
  if (typeof text !== "string" || text.length < 2) return text
  // 预筛：一条文本都不含敏感词时，省掉 N 遍 replace
  if (!cloak.gate || !cloak.gate.test(text)) return text
  let out = text
  for (const re of cloak.passes) out = out.replace(re, cloakMatch)
  return out
}

// 递归遍历 JSON 值：对每个字符串混淆，并原地写回。
// 疑似 base64 / data URL 的超长无空格串不碰；签名等字段不碰。
function cloakDeep(value, cloak) {
  if (value == null) return value
  const t = typeof value
  if (t === "string") {
    if (value.length > 4096 && !value.includes(" ")) return value
    return cloakText(value, cloak)
  }
  if (t !== "object") return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = cloakDeep(value[i], cloak)
    return value
  }
  // 只遍历自有可枚举属性，不碰原型链
  const keys = Object.keys(value)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (SKIP_KEYS.has(k)) continue
    value[k] = cloakDeep(value[k], cloak)
  }
  return value
}

// 判断 chat / responses 协议下带系统提示词的消息
function isSystemMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false
  return msg.role === "system" || msg.role === "developer"
}

// 混淆一个可能是字符串或嵌套对象的系统提示词字段
function cloakSystemField(sys, cloak) {
  if (typeof sys === "string") return cloakText(sys, cloak)
  if (sys && typeof sys === "object") cloakDeep(sys, cloak)
  return sys
}

// 系统提示词可能出现的字段：anthropic 的 system、gemini 的 systemInstruction
// （两种拼法）、responses 的 instructions
const SYSTEM_KEYS = ["system", "systemInstruction", "system_instruction", "instructions"]
// 系统消息可能出现的数组：chat 的 messages、responses 的 input
const MESSAGE_KEYS = ["messages", "input"]

const DEFAULT_ACCOUNTS = ["antigravity"]

// 只对指定的账号种类生效；API 密钥供应商没有 account，一律不动
function accountMatches(ctx, opts) {
  const list = Array.isArray(opts.accounts) && opts.accounts.length ? opts.accounts : DEFAULT_ACCOUNTS
  const account = ctx.provider?.account
  return typeof account === "string" && list.includes(account)
}

export function onProvider(body, ctx) {
  const opts = ctx.options ?? {}
  if (opts.off) return body
  if (!accountMatches(ctx, opts)) return body

  const cloak = compileCloak(opts.extraWords)

  // deep：全字段深度混淆，用户消息、tools、thinking 也一起
  if (opts.deep) return cloakDeep(body, cloak)

  // 默认：只混淆系统提示词（cli-proxy-api 的保守行为，模型输出质量影响最小）
  for (let i = 0; i < SYSTEM_KEYS.length; i++) {
    const key = SYSTEM_KEYS[i]
    if (body[key] != null) body[key] = cloakSystemField(body[key], cloak)
  }
  for (let k = 0; k < MESSAGE_KEYS.length; k++) {
    const list = body[MESSAGE_KEYS[k]]
    if (!Array.isArray(list)) continue
    for (let i = 0; i < list.length; i++) {
      const msg = list[i]
      if (!isSystemMessage(msg)) continue
      msg.content = cloakSystemField(msg.content, cloak)
    }
  }
  return body
}
