// 本地单测：node test.mjs（模拟 magpie 网关中间件的 onProvider 调用）
//
// 所有 fixture 一律用拼接构造纯净触发词（见下方 W）——测试文件正文里
// 不允许出现未转义的敏感词，避免零宽字符污染让断言空转。
// 每个混淆断言都成对检查“混淆前不含 ZW、混淆后含 ZW”。
import { onProvider } from "./antigravity-cloak.middleware.js"

// 默认按“请求正在发给 antigravity 账号”调用，个别用例再覆盖 account / options
const onRequest = (body, ctx = {}) =>
  onProvider(body, { protocol: "anthropic", provider: { id: "antigravity", account: "antigravity" }, ...ctx })

const ZW = "\u200B"
// 纯净词构造：把源码里的词拆开拼接，保证测试文件里永远没有完整触发词
const W = {
  billing: "x-an" + "thropic-billing-header",
  cc: "C" + "laude Code",
  sdk: "C" + "laude Agent SDK",
  cli: "A" + "nthropic's official CLI",
  conv: "s" + "ystem-conventions",
  rfc: "R" + "FC 2119",
}

const assert = (cond, name) => {
  if (cond) console.log("✔ " + name)
  else { console.error("✘ " + name); process.exitCode = 1 }
}
// 混淆断言：混淆前的文本必须不含 ZW（fixture 纯净），混淆后必须在词首字符后插入 ZW
const cloaked = (before, after, w) => {
  assert(!before.includes(ZW), `fixture 纯净：${JSON.stringify(w)} 输入不含零宽`)
  assert(after.includes(w[0] + ZW + w.slice(1)), `被混淆：${JSON.stringify(w)}`)
}
const untouched = (after, w) =>
  assert(!after.includes(w[0] + ZW + w.slice(1)), `未被动过：${JSON.stringify(w)}`)

// 1. anthropic：system 为字符串
{
  const sys = `You are ${W.cc}, ${W.cli} for Claude.`
  const body = {
    model: "antigravity/gemini-3.8-flash",
    system: sys,
    messages: [{ role: "user", content: "hi" }],
  }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  cloaked(sys, out.system, W.cc)
  cloaked(sys, out.system, W.cli)
  assert(out.model === "antigravity/gemini-3.8-flash", "anthropic：model 不变")
}

// 2. anthropic：system 为块数组
{
  const t0 = `You are a Claude agent, built on ${W.sdk}.`
  const body = {
    model: "m",
    system: [
      { type: "text", text: t0 },
      { type: "text", text: "clean block" },
    ],
    messages: [],
  }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  cloaked(t0, out.system[0].text, W.sdk)
  assert(out.system[1].text === "clean block", "anthropic 块 system：干净块不动")
}

// 3. gemini：systemInstruction.parts
{
  const t = `Follow <${W.conv}> and ${W.rfc}.`
  const body = {
    systemInstruction: { parts: [{ text: t }] },
    contents: [],
  }
  const out = onRequest(body, { protocol: "gemini", options: {} })
  cloaked(t, out.systemInstruction.parts[0].text, W.conv)
  cloaked(t, out.systemInstruction.parts[0].text, W.rfc)
}

// 3b. 关键回归：billing 头标记（真实 429 的元凶）被混淆
{
  const t = W.billing + ": cc_version=1.2.3; cc_entrypoint=claude-desktop-3p;"
  const body = { system: [{ type: "text", text: t }], messages: [] }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  cloaked(t, out.system[0].text, W.billing)
}

// 4. chat：messages 里的 system
{
  const c = `You are ${W.cc}.`
  const body = {
    messages: [
      { role: "system", content: c },
      { role: "user", content: "user msg" },
    ],
  }
  const out = onRequest(body, { protocol: "chat", options: {} })
  cloaked(c, out.messages[0].content, W.cc)
}

// 5. deep 模式：用户消息、tools 描述、thinking 也被混淆
{
  const userMsg = `marker ${W.cc} here`
  const thinking = `sdk mention ${W.sdk}`
  const desc = `uses ${W.rfc}`
  const body = {
    model: "m",
    system: "clean",
    messages: [
      { role: "user", content: userMsg },
      { role: "assistant", content: [{ type: "thinking", thinking, signature: "sig123" }] },
    ],
    tools: [{ name: "t", description: desc, input_schema: { type: "object" } }],
  }
  const out = onRequest(body, { protocol: "anthropic", options: { deep: true } })
  cloaked(userMsg, out.messages[0].content, W.cc)
  cloaked(thinking, out.messages[1].content[0].thinking, W.sdk)
  assert(out.messages[1].content[0].signature === "sig123", "deep：signature 不动")
  cloaked(desc, out.tools[0].description, W.rfc)
  untouched(out.system, W.cc)
  assert(out.system === "clean", "deep：干净文本不动")
}

// 6. 默认模式：只混淆系统提示词，用户消息不动
{
  const sys = `You are ${W.cc}.`
  const userMsg = `${W.cc} in user`
  const body = {
    system: sys,
    messages: [{ role: "user", content: userMsg }],
  }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  cloaked(sys, out.system, W.cc)
  untouched(out.messages[0].content, W.cc)
}

// 6b. 默认模式：chat 协议下 messages 里的 system 消息也被混淆
{
  const sys = `You are ${W.cc}.`
  const userMsg = `${W.cc} in user`
  const body = {
    messages: [
      { role: "system", content: sys, other: "keep" },
      { role: "user", content: userMsg },
    ],
  }
  const out = onRequest(body, { protocol: "chat", options: {} })
  cloaked(sys, out.messages[0].content, W.cc)
  assert(out.messages[0].other === "keep", "默认：chat system 其他字段不动")
  untouched(out.messages[1].content, W.cc)
}

// 7. off 选项
{
  const sys = `You are ${W.cc}.`
  const body = { system: sys, messages: [] }
  const out = onRequest(body, { protocol: "anthropic", options: { off: true } })
  untouched(out.system, W.cc)
  assert(out.system === sys, "off=true：完全放行")
}

// 8. extraWords
{
  const sys = "hello my-secret-marker"
  const body = { system: sys, messages: [] }
  const out = onRequest(body, { protocol: "anthropic", options: { extraWords: ["my-secret-marker"] } })
  cloaked(sys, out.system, "my-secret-marker")
}

// 9. 还原等价 + 幂等：去零宽后与原文一致，跑两遍结果一致
{
  const orig = `You are ${W.cc}, ${W.cli}. ${W.billing}: v=1;`
  const once = onRequest({ system: orig, messages: [] }, { protocol: "anthropic", options: {} })
  const twice = onRequest(structuredClone(once), { protocol: "anthropic", options: {} })
  assert(once.system.replaceAll(ZW, "") === orig, "还原：去零宽空格后与原文一致")
  assert(twice.system === once.system, "幂等：跑两遍结果一致")
}

// 10. base64 大块不碰
{
  const b64 = "Q0xhdWRl" + "x".repeat(5000)
  const body = { system: "ok", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: b64 } }] }] }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  assert(out.messages[0].content[0].source.data === b64, "base64 图片数据不动")
}

// 11. 词表含正则特殊字符也能安全匹配
{
  const sys = "use (a|b) [c] marker"
  const out = onRequest({ system: sys, messages: [] }, { protocol: "anthropic", options: { extraWords: ["(a|b) [c]"] } })
  // 期望结果 "("\u200B + a)"：插在 ( 后面
  assert(out.system.includes("(" + ZW + "a"), "正则特殊字符按字面匹配")
}

// 12. 重叠匹配不漏：短词在连续重复串里的每个出现都被混淆
{
  const sys = "aaaa"
  const out = onRequest({ system: sys, messages: [] }, { protocol: "anthropic", options: { extraWords: ["aa"] } })
  // "aa" 出现 2 次（重叠的第三个不计），每处首字符后插 ZW
  const count = (out.system.match(new RegExp(ZW, "g")) || []).length
  assert(count === 2, `重叠匹配不漏（插了 ${count} 处，应为 2）`)
}

// 13. 词表缓存：不同 extraWords 交替调用互不污染
{
  const sys = "alpha-marker and beta-marker"
  const optsA = { protocol: "anthropic", options: { extraWords: ["alpha-marker"] } }
  const optsB = { protocol: "anthropic", options: { extraWords: ["beta-marker"] } }
  const a = onRequest({ system: sys, messages: [] }, optsA)
  const b = onRequest({ system: sys, messages: [] }, optsB)
  const a2 = onRequest({ system: sys, messages: [] }, optsA)
  cloaked(sys, a.system, "alpha-marker")
  untouched(a.system, "beta-marker")
  cloaked(sys, b.system, "beta-marker")
  untouched(b.system, "alpha-marker")
  assert(a2.system === a.system, "词表缓存：同一词表重复调用结果一致")
}

// 14. 预筛不误伤：不含任何敏感词的请求体原样返回
{
  const big = "lorem ipsum dolor sit amet ".repeat(2000)
  const body = {
    model: "m",
    system: big,
    messages: [{ role: "user", content: big }],
    tools: [{ name: "t", description: big }],
  }
  const before = JSON.stringify(body)
  const out = onRequest(body, { protocol: "anthropic", options: { deep: true } })
  assert(JSON.stringify(out) === before, "预筛：无敏感词时请求体原样返回")
}

// 15. 不变量（300 组随机，固定种子可复现）：只插入零宽空格、不引入其他改动、幂等
{
  let seed = 20241104
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const needles = [W.billing, W.cc, W.sdk, W.cli, W.conv, W.rfc]
  const mixCase = (s) => s.split("").map((c) => (rnd() < 0.4 ? c.toUpperCase() : c)).join("")
  const filler = ["hello", "the quick brown fox", "你好，世界", "\n", " ", "(a|b) [c]", "$1 $&", "🎉", "", "claude codex", "  \t "]
  const text = (d = 0) => {
    const r = rnd()
    if (r < 0.35) return pick(["", "pre "]) + mixCase(pick(needles)) + pick(["", " post", "; cc_version=1;"])
    if (r < 0.42) return "Q0xhdWRl" + "A".repeat(4100 + Math.floor(rnd() * 100))
    if (r < 0.5 && d < 3) return text(d + 1) + pick([" ", ""]) + text(d + 1)
    let s = ""
    for (let i = 0; i < 4; i++) s += pick(filler)
    return s
  }
  const value = (d = 0) => {
    const r = rnd()
    if (r < 0.5 || d >= 3) return text(d)
    if (r < 0.58) return pick([null, 0, 1.5, true, false])
    if (r < 0.78) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(d + 1))
    const o = {}
    for (let i = 0; i < 4; i++) o[pick(["text", "content", "system", "signature", "id", "parts", "x"])] = value(d + 1)
    return o
  }
  // 序列化前去掉 ZW，用于判断“除了插入 ZW 以外是否还有别的改动”
  const strip = (v) =>
    JSON.stringify(v, (k, val) =>
      val === undefined ? "\u0000undefined" : typeof val === "string" ? val.replaceAll(ZW, "") : val,
    )
  let onlyZw = true
  let idempotent = true
  for (let i = 0; i < 300; i++) {
    let body =
      rnd() < 0.5
        ? { system: text(), messages: [{ role: "system", content: text() }, { role: "user", content: text() }] }
        : value()
    // 中间的 magpie 只会传 JSON.parse 出来的对象；null 根不在契约内
    if (body == null) body = { system: text(), messages: [] }
    const opts = { deep: rnd() < 0.5, extraWords: rnd() < 0.3 ? ["my-marker", "aa", "(a|b) [c]"] : [] }
    const before = strip(body)
    const once = onRequest(structuredClone(body), { protocol: "anthropic", options: opts })
    if (strip(once) !== before) onlyZw = false
    const twice = onRequest(structuredClone(once), { protocol: "anthropic", options: opts })
    if (strip(twice) !== strip(once)) idempotent = false
  }
  assert(onlyZw, "不变量（300 组随机）：输出只比输入多零宽空格，无其他任何改动")
  assert(idempotent, "不变量（300 组随机）：重复处理结果不变（幂等）")
}

// 16. 作用域：只对 antigravity 账号生效，其他账号/密钥供应商一律不动
{
  const sys = `You are ${W.cc}, ${W.billing}: v=1;`
  const mk = (ctx) => onProvider({ system: sys, messages: [] }, { protocol: "anthropic", options: {}, ...ctx })
  const others = [
    ["claude 官方订阅", { provider: { id: "claude", account: "claude" } }],
    ["grok 订阅", { provider: { id: "grok", account: "grok" } }],
    ["API 密钥供应商（无 account）", { provider: { id: "deepseek" } }],
    ["没有 provider 信息", {}],
    ["account 为空字符串", { provider: { id: "x", account: "" } }],
  ]
  for (const [name, ctx] of others) assert(mk(ctx).system === sys, `作用域：${name} 原样通过`)
  cloaked(sys, mk({ provider: { id: "antigravity", account: "antigravity" } }).system, W.billing)
}

// 17. accounts 选项可覆盖生效范围
{
  const sys = `You are ${W.cc}.`
  const opts = { accounts: ["claude"] }
  const atAntigravity = onProvider({ system: sys, messages: [] }, { protocol: "anthropic", provider: { account: "antigravity" }, options: opts })
  const atClaude = onProvider({ system: sys, messages: [] }, { protocol: "anthropic", provider: { account: "claude" }, options: opts })
  assert(atAntigravity.system === sys, "accounts=[claude]：antigravity 不动")
  cloaked(sys, atClaude.system, W.cc)
  // accounts 为空数组时回退到默认的 antigravity
  const empty = { accounts: [] }
  cloaked(sys, onProvider({ system: sys, messages: [] }, { protocol: "anthropic", provider: { account: "antigravity" }, options: empty }).system, W.cc)
}

// 18. responses 协议：instructions 与 input 里的 system/developer 消息
{
  const ins = `You are ${W.cc}.`
  const dev = `built on ${W.sdk}`
  const user = `${W.cc} in user`
  const body = {
    instructions: ins,
    input: [
      { role: "developer", content: dev },
      { role: "user", content: user },
    ],
  }
  const out = onProvider(body, { protocol: "responses", provider: { account: "antigravity" }, options: {} })
  cloaked(ins, out.instructions, W.cc)
  cloaked(dev, out.input[0].content, W.sdk)
  untouched(out.input[1].content, W.cc)
}

// 19. gemini 的另一种拼法 system_instruction 也覆盖
{
  const t = `Follow ${W.rfc}.`
  const body = { system_instruction: { parts: [{ text: t }] }, contents: [] }
  const out = onProvider(body, { protocol: "gemini", provider: { account: "antigravity" }, options: {} })
  cloaked(t, out.system_instruction.parts[0].text, W.rfc)
}

console.log(process.exitCode ? "有失败" : "全部通过")
