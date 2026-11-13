// 回放社区版 antigravity-cloak 的 cases.json，验证本仓库中间件对同一批输入的结果。
//
//   node scripts/replay-community-cases.mjs            # 拉 main 最新
//   node scripts/replay-community-cases.mjs <ref>      # 指定 commit / tag
//
// 判定：有 expect_request 的条目必须逐字节一致；没有 expect_request 的条目必须原样返回。
// 差异会列出来并区分为「仅多打断了一些词」（本仓库词表是社区版的超集，可接受）
// 与「内容不一致」（需要看）。
import { onProvider } from "../antigravity-cloak.middleware.js"

const REF = process.argv[2] ?? "main"
const BASE = "https://raw.githubusercontent.com/magpie-community/plugins"
const ZW = "\u200B"

const url = `${BASE}/${REF}/packages/antigravity-cloak/cases.json`
const res = await fetch(url)
if (!res.ok) {
  console.error(`拉取失败：${url} → HTTP ${res.status}`)
  process.exit(1)
}
const cases = await res.json()

let pass = 0
const diffs = []
for (const c of cases) {
  const want = c.expect_request ?? c.request
  const ctx = { protocol: c.protocol, provider: c.provider, options: c.options ?? {} }
  const got = onProvider(structuredClone(c.request), ctx)
  const same = JSON.stringify(got) === JSON.stringify(want)
  const strip = (v) => JSON.stringify(v).replaceAll(ZW, "")
  if (same) pass++
  else diffs.push({ name: c.name, onlyZw: strip(got) === strip(want) })
}

console.log(`ref=${REF} 用例 ${cases.length}：逐字节一致 ${pass}，有差异 ${diffs.length}`)
for (const d of diffs) {
  console.log(`  · ${d.name} → ${d.onlyZw ? "仅多打断了一些词（词表超集，可接受）" : "内容不一致"}`)
}
if (diffs.some((d) => !d.onlyZw)) process.exitCode = 1
