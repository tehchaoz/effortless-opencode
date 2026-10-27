#!/usr/bin/env node
// Builds parity/vectors.json: the ORIGINAL effortless mod's own answers for a fixed set of inputs.
//
//   node --experimental-strip-types parity/extract-vectors.mjs <path-to-original>/hooks/register.tsx
//
// It slices the pure functions (no Claude Code engine calls) out of the original register.tsx by line range,
// writes them to a scratch module, imports that, and records what each function returns. The OpenCode port is
// then tested against this file, so "does the same thing the same way" is checked, not claimed.
// The original is MIT (see ORIGINAL-LICENSE-MIT); only its outputs are stored here, not its code.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const srcPath = process.argv[2]
if (!srcPath) {
  console.error('usage: extract-vectors.mjs <path to original hooks/register.tsx>')
  process.exit(2)
}
const src = readFileSync(srcPath, 'utf8').split('\n')

// Inclusive 1-based line ranges of the original (version 1.72.0, commit e5c590d).
const RANGES = [
  [12, 18], // MODELS, EFFORTS
  [22, 22], // WEIGHT
  [72, 72], // EFFORT_LABELS
  [88, 89], // CACHE_YELLOW_MIN, CACHE_RED_MIN
  [90, 90], // ICE
  [102, 103], // YELLOW, RED
  [350, 398], // JUDGE_SYSTEM, parseVerdict
  [404, 417], // contextFrom, lastAssistantText
  [455, 512], // namedEffort, isFollowUp, endsOnQuestion, withAttachments, withMidTurn, keepsEffort
  [688, 696], // judgeQuestion
  [815, 852], // handoff check: HANDOFF_SYSTEM, handoffEvidence, parseHandoffAnswer
  [890, 896], // benchGrade
  [1121, 1153], // asSpent, weighted
  [1234, 1253], // cacheColor, cacheLabel, cacheClock
  [1301, 1317], // HOT_PERCENT.., hotVisible
  [1360, 1389], // looksLikeRedo, tipped, bounded, capped
  [1540, 1593], // HANDOFF_PROMPT, HANDOFF_FULL_PROMPT, handoffMessage
  [2064, 2108], // tokens, share, savedText
  [3637, 3642], // helperFloor
]
const body = RANGES.map(([a, b]) => src.slice(a - 1, b).join('\n')).join('\n\n')
const prelude = `type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'\ntype ModelKey = 'haiku' | 'sonnet' | 'opus' | 'fable'\ntype Pick = any\ntype Spent = any\ntype HandoffAfter = 'continue' | 'confirm' | 'copy'\n`
const dir = mkdtempSync(join(tmpdir(), 'effortless-orig-'))
const file = join(dir, 'original-pure.ts')
writeFileSync(file, prelude + body + '\nexport { judgeQuestion, JUDGE_SYSTEM, HANDOFF_SYSTEM }\n')
const o = await import(pathToFileURL(file).href)

const bench = JSON.parse(readFileSync(join(here, 'judge-cases.json'), 'utf8')).cases
const messages = [
  ...new Set([
    ...bench.map(c => c.message),
    '', ' ', 'go', 'ok', 'yes', 'continue', 'do it', 'yes please', 'ok go ahead', 'thanks!', 'B', 'sure', 'k', 'nope',
    'ja', 'kör', 'max effort', 'use max effort please', 'effort: high', 'effort to low', 'set effort at medium', 'xhigh',
    "don't use max effort", 'without high effort', 'a medium sized image of a cat', 'run this at extra high effort',
    'extra-high effort', 'low effort', 'maximum effort', 'effort level high', 'the effort is high today',
    'no', 'no problem', 'no worries thanks', 'nah that is wrong', "that's wrong", "it doesn't work", 'still broken', 'still not working',
    'try again', 'redo it', 'you missed one', 'fel', 'funkar inte', 'it still fails after the change', 'works great', 'not what I meant',
  ]),
]
const contexts = [
  '',
  'user: refactor the auth module\nassistant: Done. I moved the helpers out.',
  'user: delete old logs?\nassistant: Should I archive them first?',
  'user: pick one\nassistant: A, B or C?',
  'assistant: Finished the migration.',
  'user: x\nassistant: ' + 'long reply '.repeat(100) + 'Which option do you want?',
]
const out = { source: { version: '1.72.0', commit: 'e5c590dfd9402244ea66a8bf795d1cb86d1df7b9', repo: 'https://github.com/HeyCubit/effortless' } }

out.isFollowUp = messages.map(m => ({ in: m, out: o.isFollowUp(m) }))
out.namedEffort = messages.map(m => ({ in: m, out: o.namedEffort(m) ?? null }))
out.looksLikeRedo = messages.map(m => ({ in: m, out: o.looksLikeRedo(m) }))
out.endsOnQuestion = contexts.map(c => ({ in: c, out: o.endsOnQuestion(c) }))
out.keepsEffort = []
for (const m of ['go', 'ok', 'yes', 'B', 'refactor everything', 'thanks']) for (const c of contexts) out.keepsEffort.push({ in: [m, c], out: o.keepsEffort(m, c) })

out.withAttachments = [
  [['fix this', undefined], null],
  [['fix this', []], null],
  [['fix this', [{ type: 'image' }]], null],
  [['fix this', [{ type: 'image' }, { type: 'image' }, { type: 'file' }]], null],
].map(([a]) => ({ in: a, out: o.withAttachments(a[0], a[1]) }))
out.withMidTurn = ['yes', 'also add tests'].flatMap(m => ['low', 'high'].map(e => ({ in: [m, e], out: o.withMidTurn(m, e) })))

// parseVerdict: raw judge replies. The original needs a model field; ports accept it too (and ignore it).
const verdictReplies = [
  '{"model":"sonnet","effort":"high","sure":0.8,"why":"big refactor"}',
  '```json\n{"model":"opus","effort":"medium","sure":1,"why":"normal"}\n```',
  'Sure! {"model":"haiku","effort":"low","sure":0.5,"why":"rename"} hope that helps',
  '{"model":"Claude-Sonnet","effort":"xhigh","why":"x"}',
  '{"model":"claude-opus-5-5","effort":"max","sure":0.95,"why":"' + 'w'.repeat(80) + '"}',
  '{"model":"sonnet","effort":"extreme","why":"bad effort"}',
  '{"model":"gpt","effort":"low","why":"unknown model"}',
  '{"model":"sonnet","effort":"low","sure":2,"why":"sure out of range"}',
  '{"model":"sonnet","effort":"low","sure":"0.9","why":"sure as string"}',
  '{"model":"sonnet","effort":"low","why":"r","handoff":"topic changed"}',
  '{"model":"sonnet","effort":"low","why":"r","handoff":"   "}',
  '{"model":"sonnet","effort":"low","why":"r","handoff":false}',
  '{"model":"sonnet","effort":"low","why":"r","handoff":"' + 'h'.repeat(90) + '"}',
  '{"model":"sonnet","effort":"low"}',
  '{"model":"sonnet","effort":"low","why":7}',
  'not json at all', '', '{broken', '[]', 'null', '{"effort":"low"}',
]
out.parseVerdict = verdictReplies.map(r => ({ in: r, out: o.parseVerdict(r) ?? null }))
out.parseHandoffAnswer = [
  '{"handoff":"task finished, new topic"}', '{"handoff":null}', '{"handoff":""}', '{"handoff":"' + 'x'.repeat(100) + '"}',
  'junk', '```json\n{"handoff":"circles"}\n```', '{"other":1}', '{"handoff":5}',
].map(r => ({ in: r, out: o.parseHandoffAnswer(r) }))

out.tipped = []
for (const e of o.EFFORTS) for (const sure of [undefined, 0.3, 0.64, 0.65, 0.7, 0.84, 0.85, 0.9, 1]) for (const bias of [-2, -1, 0, 1, 2]) out.tipped.push({ in: [e, sure ?? null, bias], out: o.tipped(e, sure, bias) })
out.bounded = []
for (const e of o.EFFORTS) for (const f of o.EFFORTS) for (const c of o.EFFORTS) out.bounded.push({ in: [e, f, c], out: o.bounded(e, f, c) })
out.capped = []
for (const e of o.EFFORTS) for (const s of [true, false]) out.capped.push({ in: [e, s], out: o.capped(e, s) })
out.helperFloor = []
for (const f of o.EFFORTS) for (const c of o.EFFORTS) out.helperFloor.push({ in: [f, c], out: o.helperFloor(f, c) })

out.judgeQuestion = [
  ['rename x', { model: 'sonnet', effort: 'medium', why: '', by: 'manual' }, ''],
  ['B', null, 'user: pick\nassistant: A or B?'],
  ['x'.repeat(2500), { model: 'opus', effort: 'high', why: '', by: 'manual' }, 'user: a\nassistant: b'],
].map(a => ({ in: a, out: o.judgeQuestion(...a) }))

const convo = [
  { role: 'user', text: 'Build a landing page for my bakery with a menu and an order form' },
  { role: 'assistant', text: 'Done. Files: index.html, style.css. Want me to add a gallery?' },
  { role: 'user', text: 'add the gallery' },
  { role: 'assistant', text: 'Added a gallery section to index.html with 6 images.' },
  { role: 'user', text: 'now fix the mobile nav' },
  { role: 'assistant', text: 'x'.repeat(2500) + ' Should I also fix the footer?' },
]
out.contextFrom = [[], convo.slice(0, 2), convo, [{ role: 'assistant', text: 'hello' }], [{ role: 'user', text: 'u'.repeat(600) }]].map(m => ({ in: m, out: o.contextFrom(m) }))
out.handoffEvidence = [
  [convo, 'what next', 35, false],
  [convo, 'n'.repeat(800), 80, true],
  [[], 'hi', 0, false],
  [convo.slice(0, 2), 'ok', 10, false],
].map(a => ({ in: a, out: o.handoffEvidence(...a) }))

out.benchGrade = []
for (const c of bench) for (const e of [...o.EFFORTS, undefined]) out.benchGrade.push({ in: [c.ok, e ?? null], out: o.benchGrade(c, e) })
// de-duplicate identical ok lists to keep the file small
const seen = new Set()
out.benchGrade = out.benchGrade.filter(x => { const k = JSON.stringify(x.in); if (seen.has(k)) return false; seen.add(k); return true })

out.cacheColor = [-1, 0, 1, 2, 5, 6, 7, 20, 21, 22, 40, 59, 60].map(m => ({ in: m, out: o.cacheColor(m) ?? null }))
out.cacheLabel = [-1, 0, 1, 2, 5, 30, 60].map(m => ({ in: m, out: o.cacheLabel(m) }))
out.cacheClock = [-5, 0, 1, 999, 1000, 59_000, 61_000, 3_540_000, 3_599_999].map(m => ({ in: m, out: o.cacheClock(m) }))
out.hotVisible = []
const heat = { kind: 'five_hour', percent: 82, resetsAt: '2026-10-27T20:00:00Z' }
for (const closed of [null, { window: 'five_hour ' + Math.round(new Date(heat.resetsAt).getTime() / 900_000), percent: 82 }, { window: 'other 1', percent: 90 }])
  for (const pct of [82, 94, 95, 99]) out.hotVisible.push({ in: [{ ...heat, percent: pct }, closed], out: o.hotVisible({ ...heat, percent: pct }, closed) })

out.handoffMessage = [
  ['the handoff text', 'continue'], ['the handoff text', 'confirm'], ['  padded  ', 'copy'], ['saved by skill', 'continue', 'session-handoff'], ['saved by skill', 'confirm', 'session-handoff'],
].map(a => ({ in: a, out: o.handoffMessage(...a) }))
const port = await import('../opencode/core.ts')
out.port = { JUDGE_SYSTEM: port.JUDGE_SYSTEM }
out.prompts = { JUDGE_SYSTEM: o.JUDGE_SYSTEM, HANDOFF_SYSTEM: o.HANDOFF_SYSTEM, HANDOFF_PROMPT: o.HANDOFF_PROMPT, HANDOFF_FULL_PROMPT: o.HANDOFF_FULL_PROMPT }

const spents = [
  {},
  { prompts: 3, requests: 9, input: 1200, write: 4000, read: 90000, out: 2500, byEffort: { low: { prompts: 2, cost: 9000 }, high: { prompts: 1, cost: 30000 } }, judge: { jev: 0, haiku: 3, ms: 2400, tokens: 900 }, moved: 0, redone: 0 },
  { prompts: 1, requests: 2, input: 10, write: 0, read: 0, out: 5, byEffort: { medium: { prompts: 1, cost: 35 } }, judge: { jev: 2, haiku: 1, ms: 300, tokens: 50 }, moved: 2, redone: 1, helpers: { runs: { low: 1, medium: 2 }, requests: 5, cost: 800 } },
  { prompts: 0, requests: 0, judge: { jev: 0, haiku: 1, ms: 700, tokens: 12 } },
]
out.savedText = spents.map(s => ({ in: s, out: o.savedText(s) }))
out.weighted = [{}, { input_tokens: 100 }, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40 }, { cache_read_input_tokens: null }].map(u => ({ in: u, out: o.weighted(u) }))

writeFileSync(join(here, 'vectors.json'), JSON.stringify(out, null, 1) + '\n')
const counts = Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}:${v.length}`).join(' ')
console.log('wrote parity/vectors.json —', counts)
try { execSync('true') } catch {}
