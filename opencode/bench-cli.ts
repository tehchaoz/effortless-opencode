// Scores a judge model on the original's 75 labelled prompts, through the same code the plugin uses
// (follow-ups keep the effort, everything else goes to the judge), and prints the original's report.
//
//   node --experimental-strip-types opencode/bench-cli.ts --url http://127.0.0.1:8080/v1 --model qwen3-coder-next
//   options: --concurrency 2  --limit 20  --key-env NAME  --out parity/results/<name>.md
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from './core.ts'

const arg = (name: string, dflt = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const url = arg('url').replace(/\/+$/, '')
const model = arg('model')
if (!url || !model) {
  console.error('usage: bench-cli.ts --url <openai-compatible base url> --model <id> [--concurrency 2] [--limit N] [--key-env NAME] [--out file.md]')
  process.exit(2)
}
const key = arg('key-env') ? process.env[arg('key-env')] : undefined
const here = dirname(fileURLToPath(import.meta.url))
let cases: core.BenchCase[] = JSON.parse(readFileSync(join(here, '..', 'parity', 'judge-cases.json'), 'utf8')).cases
if (arg('limit')) cases = cases.slice(0, Number(arg('limit')))

const answers: core.BenchAnswer[] = []
for (const fixed of ['medium', 'high'] as core.Effort[]) for (const c of cases) answers.push({ id: c.id, judge: `always ${fixed}`, effort: fixed, ms: 0, tokens: 0 })
let next = 0
let formatErrors = 0
const worker = async () => {
  while (next < cases.length) {
    const c = cases[next++]
    if (core.keepsEffort(c.message, c.context ?? '')) {
      answers.push({ id: c.id, judge: model, effort: c.current.effort, ms: 0, tokens: 0 })
      continue
    }
    const started = Date.now()
    try {
      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: core.JUDGE_SYSTEM }, { role: 'user', content: core.judgeQuestion(c.message, c.current, c.context ?? '') }], max_tokens: 512, temperature: 0, reasoning_effort: 'low', stream: false }),
        signal: AbortSignal.timeout(60_000),
      })
      const j: any = await res.json()
      const v = core.parseVerdict(String(j?.choices?.[0]?.message?.content ?? ''))
      if (!v) formatErrors++
      answers.push({ id: c.id, judge: model, effort: v?.effort, why: v?.why, sure: v?.sure, ms: Date.now() - started, tokens: Number(j?.usage?.total_tokens ?? 0) })
    } catch {
      formatErrors++
      answers.push({ id: c.id, judge: model, ms: Date.now() - started, tokens: 0 })
    }
  }
}
const n = Math.max(1, Number(arg('concurrency', '2')))
await Promise.all(Array.from({ length: n }, worker))
const report = core.benchReport(cases, answers)
console.log(report)
console.log(`\n${cases.length} cases, ${formatErrors} unreadable/failed judge answers`)
if (arg('out')) {
  mkdirSync(dirname(arg('out')), { recursive: true })
  writeFileSync(arg('out'), `# Judge benchmark: ${model} @ ${url}\n\n${new Date().toISOString()} — ${cases.length} cases, ${formatErrors} unreadable/failed answers\n\n${report}\n`)
}
