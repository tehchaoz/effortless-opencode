// Parity tests: core.ts must answer exactly what the ORIGINAL effortless answered (parity/vectors.json).
// Run:  node --experimental-strip-types --test opencode/core.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as c from './core.ts'

const here = dirname(fileURLToPath(import.meta.url))
const V = JSON.parse(readFileSync(join(here, '..', 'parity', 'vectors.json'), 'utf8'))
const cases = JSON.parse(readFileSync(join(here, '..', 'parity', 'judge-cases.json'), 'utf8')).cases

const each = (name: string, fn: (i: any, o: any) => void) => test(`parity: ${name} (${V[name].length})`, () => V[name].forEach((v: any) => fn(v.in, v.out)))

each('isFollowUp', (i, o) => assert.equal(c.isFollowUp(i), o, JSON.stringify(i)))
each('namedEffort', (i, o) => assert.equal(c.namedEffort(i) ?? null, o, JSON.stringify(i)))
each('looksLikeRedo', (i, o) => assert.equal(c.looksLikeRedo(i), o, JSON.stringify(i)))
each('endsOnQuestion', (i, o) => assert.equal(c.endsOnQuestion(i), o))
each('keepsEffort', (i, o) => assert.equal(c.keepsEffort(i[0], i[1]), o, JSON.stringify(i)))
each('withAttachments', (i, o) => assert.equal(c.withAttachments(i[0], i[1]), o))
each('withMidTurn', (i, o) => assert.equal(c.withMidTurn(i[0], i[1]), o))
each('parseHandoffAnswer', (i, o) => assert.equal(c.parseHandoffAnswer(i), o, i))
each('tipped', (i, o) => assert.equal(c.tipped(i[0], i[1] ?? undefined, i[2]), o, JSON.stringify(i)))
each('bounded', (i, o) => assert.equal(c.bounded(i[0], i[1], i[2]), o, JSON.stringify(i)))
each('capped', (i, o) => assert.equal(c.capped(i[0], i[1]), o))
each('helperFloor', (i, o) => assert.equal(c.helperFloor(i[0], i[1]), o))
each('judgeQuestion', (i, o) => assert.equal(c.judgeQuestion(i[0], i[1], i[2]), o))
each('contextFrom', (i, o) => assert.equal(c.contextFrom(i), o))
each('handoffEvidence', (i, o) => assert.equal(c.handoffEvidence(i[0], i[1], i[2], i[3]), o))
each('benchGrade', (i, o) => assert.equal(c.benchGrade({ ok: i[0] }, i[1] ?? undefined), o, JSON.stringify(i)))
each('cacheColor', (i, o) => assert.equal(c.cacheColor(i) ?? null, o))
each('cacheLabel', (i, o) => assert.equal(c.cacheLabel(i), o))
each('cacheClock', (i, o) => assert.equal(c.cacheClock(i), o))
each('handoffMessage', (i, o) => assert.equal(c.handoffMessage(i[0], i[1], i[2]), o))
each('weighted', (i, o) => assert.equal(c.weighted(i), o))

// parseVerdict: identical, except that the port does not need a model field (it never switches models).
test(`parity: parseVerdict (${V.parseVerdict.length})`, () => {
  for (const { in: raw, out: orig } of V.parseVerdict) {
    const got = c.parseVerdict(raw)
    if (orig) {
      const { model, ...rest } = orig
      assert.deepEqual({ ...got, model: undefined }, { ...rest, model: undefined }, raw)
      continue
    }
    // The original rejects a reply with no/unknown model; the port accepts it when the effort is valid. Anything else stays rejected.
    let effortOk = false
    try {
      const m = raw.match(/\{[\s\S]*\}/)
      effortOk = !!m && c.EFFORTS.includes(JSON.parse(m[0]).effort)
    } catch {}
    assert.equal(got !== undefined, effortOk, `${raw} -> ${JSON.stringify(got)}`)
  }
})

// savedText: the original counts two named judges (Jev, Haiku); the port counts any by name. Same text for the same counts.
test(`parity: savedText (${V.savedText.length})`, () => {
  for (const { in: s, out: o } of V.savedText) {
    const j = s.judge ?? {}
    const counts: Record<string, number> = {}
    if (s.judge) {
      counts.Jev = j.jev ?? 0
      counts.Haiku = j.haiku ?? 0
    }
    const port = { ...s, judge: { counts, ms: j.ms ?? 0, tokens: j.tokens ?? 0 } }
    assert.equal(c.savedText(port as any), o)
  }
})

// The prompts the person-facing behaviour hangs on: handoff texts are the original's, byte for byte.
test('parity: handoff prompts are verbatim', () => {
  assert.equal(c.HANDOFF_PROMPT, V.prompts.HANDOFF_PROMPT)
  assert.equal(c.HANDOFF_FULL_PROMPT, V.prompts.HANDOFF_FULL_PROMPT)
  assert.equal(c.HANDOFF_SYSTEM, V.prompts.HANDOFF_SYSTEM)
})

// The judge prompt differs only where Claude model tiers were involved. Every other paragraph is kept verbatim.
test('parity: judge prompt keeps every effort paragraph of the original', () => {
  const orig: string[] = V.prompts.JUDGE_SYSTEM.split('\n\n')
  const mine = c.JUDGE_SYSTEM
  const dropped = (p: string) => /^You choose which Claude model/.test(p) || /^Models, cheapest first/.test(p) || /^Effort is relative to the model in use/.test(p) || /^If the message is a short follow-up/.test(p) || /^Reply with JSON only/.test(p)
  const kept = orig.filter(p => !dropped(p))
  assert.equal(kept.length, 5, 'the original has 5 paragraphs the port keeps verbatim')
  for (const p of kept) assert.ok(mine.includes(p), `missing paragraph: ${p.slice(0, 70)}`)
  assert.ok(!/haiku|sonnet|opus|fable/i.test(mine), 'no Claude model tiers in the port prompt')
})

test('bench cases: 75 labelled prompts, the follow-ups never reach the judge', () => {
  assert.equal(cases.length, 75)
  const fu = cases.filter((x: any) => c.keepsEffort(x.message, x.context ?? ''))
  assert.ok(fu.length > 0)
})

// --- port-only behaviour -----------------------------------------------------------------------------------------
test('applyVerdict: slider, then Min/Max, then save mode, with the original wording of why', () => {
  const cfg = { bias: 0, floor: 'low' as const, ceiling: 'max' as const }
  assert.deepEqual(c.applyVerdict({ effort: 'high', why: 'big refactor', sure: 0.9 }, cfg, false), { effort: 'high', why: 'big refactor', by: 'judge', sure: 0.9 })
  assert.equal(c.applyVerdict({ effort: 'high', why: 'x' }, cfg, true).why, 'save mode')
  assert.equal(c.applyVerdict({ effort: 'high', why: 'x' }, cfg, true).effort, 'medium')
  assert.equal(c.applyVerdict({ effort: 'low', why: 'x', sure: 0.5 }, { ...cfg, bias: 1 }, false).effort, 'medium')
  assert.equal(c.applyVerdict({ effort: 'low', why: 'x', sure: 0.5 }, { ...cfg, bias: 1 }, false).why, 'your settings')
  assert.equal(c.applyVerdict({ effort: 'max', why: 'x' }, { ...cfg, ceiling: 'high' }, false).effort, 'high')
})

test('readConfig: same clamps as the original', () => {
  const d = c.readConfig({})
  assert.equal(d.floor, 'low'); assert.equal(d.ceiling, 'max'); assert.equal(d.bias, 0); assert.equal(d.swampAt, 70)
  assert.deepEqual(d.hide, ['reason']); assert.equal(d.handoffAfter, 'continue'); assert.equal(d.compactWith, 'small')
  const s = c.readConfig({ bias: '9', floor: 'nonsense', ceiling: 'high', swampAt: '55', hide: 'handoff, timer,bogus', handoffAfter: 'confirm', helpers: 'on', auto: 'off' })
  assert.equal(s.bias, 2); assert.equal(s.floor, 'low'); assert.equal(s.ceiling, 'high'); assert.equal(s.swampAt, 70)
  assert.deepEqual(s.hide, ['handoff', 'timer']); assert.equal(s.handoffAfter, 'confirm'); assert.equal(s.helpers, 'on'); assert.equal(s.auto, false)
  assert.deepEqual(c.readConfig({ hide: '' }).hide, [])
})

test('supportsEffort + effortOptions: gpt-oss is clamped to three levels, unknown models are left alone', () => {
  const cfg = { effortModels: c.DEFAULT_EFFORT_MODELS }
  assert.ok(c.supportsEffort('local', 'gpt-oss-120b', cfg))
  assert.ok(c.supportsEffort('anthropic', 'claude-opus-5-5', cfg))
  assert.ok(!c.supportsEffort('ollama', 'qwen3-coder:30b', cfg))
  assert.deepEqual(c.effortOptions({ id: 'local', npm: '@ai-sdk/openai-compatible' }, 'gpt-oss-120b', 'max'), { reasoningEffort: 'high' })
  assert.deepEqual(c.effortOptions({ id: 'local' }, 'gpt-oss-120b', 'low'), { reasoningEffort: 'low' })
  assert.equal(c.effortOptions({ id: 'ollama' }, 'qwen3-coder:30b', 'low'), undefined)
})

test('transcriptOf keeps the end of a long chat', () => {
  const t = c.transcriptOf([{ role: 'user', text: 'a'.repeat(100) }, { role: 'assistant', text: 'b'.repeat(100) }], 120)
  assert.ok(t.startsWith('[earlier part'))
  assert.ok(t.endsWith('b'.repeat(100)))
})
