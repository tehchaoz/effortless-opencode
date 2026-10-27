// effortless for OpenCode. A port of HeyCubit/effortless (MIT) v1.72.0, which is a Claude Code mod.
//
// What it does, the way the original does it:
//   * Picks the reasoning effort for every prompt automatically. A judge model reads the prompt (and the end of the
//     last reply) and answers low..max; short follow-ups ("ok", "go") keep the effort, a named level ("max effort")
//     runs as said without a judge, and the slider, Min/Max and save mode shape the result. See core.ts.
//   * Applies it to every request of the turn (chat.params), and only on models that take an effort.
//   * You always win: choosing a variant yourself turns Auto off at your next message.
//   * Tracks context fullness, warns when a chat is swamped, advises a handoff when a fresh chat would pay off,
//     hands off (quick or full) and compacts with a cheap model, counts what Auto-steered prompts cost.
//   * /effortless settings | set | auto | save | stats | bench | debug | handoff [full] | compact | cold | swamp | down
//
// Install: see README.md. Everything stateful lives in ~/.local/state/effortless/opencode and
// ~/.config/effortless/opencode.json.
import type { Plugin } from '@opencode-ai/plugin'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as core from './core.ts'

type S = {
  pick: core.Pick | null
  heldPick: core.Pick | null
  busy: boolean
  busyAt: number
  spent: core.Spent
  context: { tokens: number; window: number; percent: number } | null
  seenVariant: string | null | undefined
  skipNext: boolean
  advice: string | null
  promptsSinceCheck: number
  cacheExpires: number
  judging: boolean
  judgeDown: string | null
  forced: Partial<Record<'cold' | 'swamp' | 'down', boolean>>
  alerted: { swamp: boolean; cold: boolean }
  counted: Set<string>
  model: { providerID: string; modelID: string } | null
  paused: boolean
  lastRequest: { model: string; effort: string | null; sent: unknown; at: number } | null
  stayPrompts: number
  lastJudge: string
}

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_DIR = process.env.EFFORTLESS_HOME || join(homedir(), '.local', 'state', 'effortless', 'opencode')
const CONFIG_FILE = process.env.EFFORTLESS_CONFIG || join(homedir(), '.config', 'effortless', 'opencode.json')
const BENCH_FILE = process.env.EFFORTLESS_BENCH || join(HERE, '..', 'parity', 'judge-cases.json')
const LOG_FILE = join(STATE_DIR, 'debug.log')

const readJson = (path: string, dflt: any) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return dflt
  }
}
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, path)
}

const SETTABLE = ['auto', 'judge', 'judgeUrl', 'judgeModel', 'judgeKeyEnv', 'judgeTimeoutMs', 'bias', 'floor', 'ceiling', 'hide', 'swampAt', 'handoffSkill', 'handoffAfter', 'handoffButton', 'compactWith', 'helpers', 'effortModels', 'cacheTtlMinutes'] as const

export const EffortlessPlugin: Plugin = async ({ client, directory }, options) => {
  mkdirSync(STATE_DIR, { recursive: true })
  let cfg = core.readConfig({ ...(options ?? {}), ...readJson(CONFIG_FILE, {}) })
  const sessions = new Map<string, S>()
  // Sessions this plugin made itself (judge calls, handoff forks): never judged, never counted.
  const side = new Set<string>()
  const infoCache = new Map<string, { parentID?: string | null }>()
  let providerModels: Map<string, any> | null = null
  let smallModel: string | undefined
  const warned = new Set<string>()
  const startedAt = Date.now()
  let saveUntil: number | null = readJson(join(STATE_DIR, 'state.json'), {}).saveUntil ?? null
  const lastHandoff = { kind: 'quick' as 'quick' | 'full', after: cfg.handoffAfter as core.HandoffAfter }
  const waiters = new Map<string, () => void>()

  const st = (sid: string): S => {
    let s = sessions.get(sid)
    if (!s) {
      // What a session measured outlives the process: stats, context and the last pick come back after a restart.
      const saved = readJson(join(STATE_DIR, `session-${sid}.json`), {})
      sessions.set(
        sid,
        (s = {
          pick: saved.pick ?? null, heldPick: null, busy: false, busyAt: 0, spent: core.asSpent(saved.spent), context: saved.context ?? null, seenVariant: undefined, skipNext: false,
          advice: saved.advice ?? null, promptsSinceCheck: saved.promptsSinceCheck ?? 0, cacheExpires: saved.cacheExpires ?? 0, judging: false, judgeDown: null, forced: {}, alerted: { swamp: false, cold: false },
          counted: new Set(saved.counted ?? []), model: null, paused: false, lastRequest: null, stayPrompts: saved.stayPrompts ?? 0, lastJudge: '',
        }),
      )
    }
    return s
  }

  // --- small helpers -------------------------------------------------------------------------------------------
  const trace = (line: string) => { if (process.env.EFFORTLESS_TRACE) proof(`trace ${line}`) }
  const proof = (line: string) => {
    try {
      if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 512_000) renameSync(LOG_FILE, LOG_FILE + '.1')
      appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }
  const toast = async (message: string, variant: 'info' | 'success' | 'warning' | 'error' = 'info', duration = 6000) => {
    try {
      await (client as any).tui.showToast({ body: { title: 'effortless', message, variant, duration } })
    } catch {}
  }
  const data = (r: any) => (r && typeof r === 'object' && 'data' in r ? r.data : r)
  const textOf = (parts: any[] | undefined) => (parts ?? []).filter(p => p.type === 'text' && !p.synthetic && !p.ignored).map(p => p.text).join('\n').trim()
  const hidden = (what: core.Hideable) => cfg.hide.includes(what)

  const modelsMap = async () => {
    if (providerModels) return providerModels
    const m = new Map<string, any>()
    try {
      const r = data(await (client as any).config.providers())
      for (const p of r?.providers ?? []) for (const [id, model] of Object.entries(p.models ?? {})) m.set(`${p.id}/${id}`, { ...(model as any), provider: p })
    } catch {}
    try {
      smallModel = data(await (client as any).config.get())?.small_model
    } catch {}
    providerModels = m
    return m
  }
  const modelOf = async (providerID: string, modelID: string) => (await modelsMap()).get(`${providerID}/${modelID}`)
  const sessionInfo = async (sid: string) => {
    if (infoCache.has(sid)) return infoCache.get(sid)!
    let info: { parentID?: string | null } = {}
    try {
      info = { parentID: data(await (client as any).session.get({ path: { id: sid } }))?.parentID ?? null }
    } catch {}
    infoCache.set(sid, info)
    return info
  }
  const chatMessages = async (sid: string): Promise<{ role: string; text: string }[]> => {
    try {
      const rows = data(await (client as any).session.messages({ path: { id: sid } })) ?? []
      return rows.map((m: any) => ({ role: m.info.role, text: textOf(m.parts) })).filter((m: any) => m.text)
    } catch {
      return []
    }
  }
  const gate = async (providerID: string, modelID: string) => core.supportsEffort(providerID, modelID, cfg)
  const label = (e?: core.Effort | null) => (e ? core.EFFORT_LABELS[e] : 'Auto')

  // --- status file for the TUI ------------------------------------------------------------------------------------
  const publish = (sid: string) => {
    try {
      const s = st(sid)
      const now = Date.now()
      const left = cfg.cacheTtlMinutes > 0 ? core.minutesLeft(s.cacheExpires, now) : null
      writeJson(join(STATE_DIR, `status-${sid}.json`), {
        at: now, auto: cfg.auto, paused: s.paused, judging: s.judging, effort: s.pick?.effort ?? null, label: s.judging ? 'Deciding…' : label(s.pick?.effort),
        by: s.pick?.by ?? null, why: hidden('reason') ? '' : s.pick?.why ?? '', percent: s.context ? Math.round(s.context.percent) : null,
        cache: left === null || s.cacheExpires === 0 || hidden('timer') ? null : core.cacheLabel(left), cold: left === 0 && s.cacheExpires > 0,
        advice: hidden('handoff') ? null : s.advice, swamped: !!s.context && s.context.percent >= cfg.swampAt, saving: saveUntil !== null && saveUntil > now,
        judgeDown: s.judgeDown, hide: cfg.hide, handoffButton: cfg.handoffButton, busy: s.busy,
      })
      persistSession(sid)
    } catch {}
  }
  const persistState = () => writeJson(join(STATE_DIR, 'state.json'), { saveUntil })
  const persistSession = (sid: string) => {
    try {
      const s = st(sid)
      writeJson(join(STATE_DIR, `session-${sid}.json`), {
        spent: s.spent, pick: s.pick, context: s.context, advice: s.advice, promptsSinceCheck: s.promptsSinceCheck,
        cacheExpires: s.cacheExpires, stayPrompts: s.stayPrompts, counted: [...s.counted].slice(-200),
      })
    } catch {}
  }
  const saving = () => saveUntil !== null && saveUntil > Date.now()

  // --- the judge --------------------------------------------------------------------------------------------------
  type Ask = { text: string; tokens: number; ms: number; name: string } | { error: string }

  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

  /** One side call to the judge model: plain HTTP when the chat's provider speaks OpenAI chat completions, else a throwaway session on the chat's own login. */
  async function askModel(ref: { providerID: string; modelID: string } | null, system: string, prompt: string, maxTokens = 512, timeoutMs = cfg.judgeTimeoutMs): Promise<Ask> {
    const started = Date.now()
    try {
      let target: { url?: string; model: string; key?: string; providerID?: string; name: string } | null = null
      if (cfg.judge === 'custom' && cfg.judgeUrl && cfg.judgeModel) target = { url: cfg.judgeUrl, model: cfg.judgeModel, key: cfg.judgeKeyEnv ? process.env[cfg.judgeKeyEnv] : undefined, name: cfg.judgeModel }
      else {
        await modelsMap()
        let use = ref
        if (smallModel && smallModel.includes('/')) use = { providerID: smallModel.split('/')[0], modelID: smallModel.split('/').slice(1).join('/') }
        if (!use) return { error: 'no model to judge with' }
        const m = await modelOf(use.providerID, use.modelID)
        const npm: string = m?.api?.npm ?? ''
        // A provider declared in opencode.json carries its base URL and key in options; a built-in one in api.url.
        const baseURL = String(m?.api?.url || m?.provider?.options?.baseURL || '').replace(/\/+$/, '')
        const key = m?.provider?.key || (typeof m?.provider?.options?.apiKey === 'string' ? m.provider.options.apiKey : undefined)
        // A raw HTTP call needs a key we hold. Built-in providers (opencode / opencode-go) keep their
        // credential in opencode's own auth store, not in the model record, so a keyless raw call 401s in
        // ~150 ms and the judge silently returns nothing (confirmed 2026-10-27). Without a key, use the
        // authenticated throwaway-session path instead.
        // opencode.ai rejects plain HTTP clients with Cloudflare 403 (error 1010), key or not — measured
        // 2026-10-27. For that host the judge must ride opencode's own session transport.
        const cloudflareBlocked = /opencode\.ai/.test(baseURL)
        if (baseURL && key && !cloudflareBlocked && !/anthropic|google|bedrock|vertex/.test(npm)) target = { url: baseURL, model: m.api?.id || m.id, key, providerID: use.providerID, name: m.id }
        else target = { providerID: use.providerID, model: use.modelID, name: use.modelID }
        proof(`judge target: ${target.url ? `http ${target.url}` : 'throwaway session'} model ${target.model}`)
      }
      if (target.url) {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), timeoutMs)
        try {
          const res = await fetch(`${target.url}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(target.key ? { authorization: `Bearer ${target.key}` } : {}) },
            body: JSON.stringify({ model: target.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, reasoning_effort: 'low', stream: false }),
            signal: ctl.signal,
          })
          if (!res.ok) return { error: `HTTP ${res.status}` }
          const j: any = await res.json()
          const msg: any = j?.choices?.[0]?.message ?? {}
          // Reasoning models (DeepSeek V4, Kimi K3, GLM) put the answer in reasoning_content and can leave
          // content empty, especially at low effort. Read whichever is populated.
          const text = String(msg.content ?? '') || String(msg.reasoning_content ?? '')
          return { text: String(text), tokens: Number(j?.usage?.total_tokens ?? 0), ms: Date.now() - started, name: target.name }
        } finally {
          clearTimeout(timer)
        }
      }
      // Throwaway session on the chat's own provider login (what the original does with Haiku on your own Claude login).
      const created = data(await (client as any).session.create({ body: { title: 'effortless judge' } }))
      const id = created.id as string
      side.add(id)
      try {
        const r = data(await withTimeout((client as any).session.prompt({ path: { id }, body: { model: { providerID: target.providerID, modelID: target.model }, system, tools: {}, parts: [{ type: 'text', text: prompt }] } }), timeoutMs))
        const tokens = r?.info?.tokens
        return { text: textOf(r?.parts), tokens: tokens ? (tokens.input ?? 0) + (tokens.output ?? 0) : 0, ms: Date.now() - started, name: target.name }
      } finally {
        ;(client as any).session.delete({ path: { id } }).catch(() => {})
        setTimeout(() => side.delete(id), 30_000)
      }
    } catch (e: any) {
      return { error: e?.name === 'AbortError' || e?.message === 'timeout' ? 'timeout' : String(e?.message ?? e).slice(0, 80) }
    }
  }

  const warnJudge = (sid: string, reason: string) => {
    const s = st(sid)
    s.judgeDown = reason
    if (hidden('down') || warned.has(sid + reason)) return
    warned.add(sid + reason)
    void toast(`The judge is not answering (${reason}). Efforts stay as they are until it does.`, 'warning')
  }

  async function judge(sid: string, prompt: string, current: core.Pick | null, context: string) {
    const s = st(sid)
    const used = s.context?.window ? `Context used: ${Math.round(s.context.percent)}% of the window` : ''
    const asked = [core.judgeQuestion(prompt, current && { model: s.model?.modelID, effort: current.effort }, context), used].filter(Boolean).join('\n\n')
    const r = await askModel(s.model, core.JUDGE_SYSTEM, asked)
    if ('error' in r) {
      warnJudge(sid, r.error)
      return { tokens: 0, ms: 0, name: '' as string, verdict: undefined as core.Verdict | undefined }
    }
    const verdict = core.parseVerdict(r.text)
    if (!verdict) warnJudge(sid, 'unreadable answer')
    else s.judgeDown = null
    return { verdict, tokens: r.tokens, ms: r.ms, name: r.name }
  }

  function countPrompt(s: S, effort: core.Effort | undefined, judgeName: string | undefined, ms: number, tokens: number) {
    s.spent.prompts++
    if (effort) s.spent.byEffort[effort] = { prompts: (s.spent.byEffort[effort]?.prompts ?? 0) + 1, cost: s.spent.byEffort[effort]?.cost ?? 0 }
    if (judgeName) {
      s.spent.judge.counts[judgeName] = (s.spent.judge.counts[judgeName] ?? 0) + 1
      s.spent.judge.ms += ms
      s.spent.judge.tokens += tokens
    }
  }

  // --- the handoff check: from 30% context, every second message --------------------------------------------------
  async function checkHandoff(sid: string, next: string) {
    const s = st(sid)
    const percent = s.context?.percent ?? 0
    if (percent < core.HANDOFF_CHECK_FROM) {
      s.promptsSinceCheck = 0
      if (s.advice !== null) {
        s.advice = null
        publish(sid)
      }
      return
    }
    if (++s.promptsSinceCheck < core.HANDOFF_CHECK_EVERY) return
    s.promptsSinceCheck = 0
    try {
      const cold = cfg.cacheTtlMinutes > 0 && s.cacheExpires > 0 && core.minutesLeft(s.cacheExpires, Date.now()) === 0
      const evidence = core.handoffEvidence(await chatMessages(sid), next, percent, cold)
      const r = await askModel(s.model, core.HANDOFF_SYSTEM, evidence, 512, cfg.judgeTimeoutMs + 2000)
      if ('error' in r) return
      const reason = core.parseHandoffAnswer(r.text)
      proof(`handoff check at ${Math.round(percent)}%: ${reason ?? 'no'}`)
      if (reason !== s.advice) {
        s.advice = reason
        publish(sid)
        if (reason && !hidden('handoff')) void toast(`A fresh chat would pay off: ${reason}. /effortless handoff`, 'info', 9000)
      }
    } catch {}
  }

  // --- applying the effort: chat.params ---------------------------------------------------------------------------
  const requestEffort = async (sid: string, s: S): Promise<core.Effort | null> => {
    if (!cfg.auto && s.pick?.by !== 'manual') return null
    const own = s.pick
    const info = await sessionInfo(sid)
    if (info.parentID) {
      // A helper (subagent). helpers=on: the judge picked for it at its start. Otherwise it follows the turn, never below medium.
      if (cfg.helpers === 'on' && own) return own.effort
      const parent = sessions.get(info.parentID)?.pick
      if (!parent || parent.by === 'manual') return null
      const floor = core.helperFloor(cfg.floor, cfg.ceiling)
      return core.EFFORTS.indexOf(parent.effort) < core.EFFORTS.indexOf(floor) ? floor : parent.effort
    }
    return own?.effort ?? null
  }

  // --- handoff and compact ----------------------------------------------------------------------------------------
  async function newChatWith(handoff: string, after: core.HandoffAfter, skill?: string) {
    const text = core.handoffMessage(handoff, after, skill)
    if (after === 'copy') {
      const file = join(STATE_DIR, `handoff-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
      writeFileSync(file, handoff.trim() + '\n')
      const copied = ['wl-copy', 'xclip -selection clipboard', 'xsel -ib', 'pbcopy'].some(c => {
        const [bin, ...a] = c.split(' ')
        return spawnSync(bin, a, { input: handoff, timeout: 3000 }).status === 0
      })
      return copied ? 'Handoff copied to the clipboard.' : `Handoff saved to ${file} (no clipboard tool found).`
    }
    const created = data(await (client as any).session.create({ body: { title: 'Handoff' } }))
    const id = created.id as string
    await (client as any).session.promptAsync({ path: { id }, body: { parts: [{ type: 'text', text }] } })
    try {
      await (client as any).tui.selectSession({ body: { sessionID: id } })
    } catch {}
    return after === 'confirm' ? `New chat ${id} opened; it will say where things stand and wait.` : `New chat ${id} opened and carrying on.`
  }

  async function waitIdle(sid: string, ms: number) {
    await withTimeout(new Promise<void>(res => waiters.set(sid, res)), ms).finally(() => waiters.delete(sid))
  }

  async function runHandoff(sid: string, full: boolean, after: core.HandoffAfter) {
    const s = st(sid)
    try {
      let text = ''
      if (full) {
        // Full: a turn in this chat that may check git and save HANDOFF.md (or runs the person's own skill).
        const before = (await chatMessages(sid)).length
        if (cfg.handoffSkill) await (client as any).session.command({ path: { id: sid }, body: { command: cfg.handoffSkill, arguments: '' } }).catch(() => (client as any).session.promptAsync({ path: { id: sid }, body: { parts: [{ type: 'text', text: `/${cfg.handoffSkill}` }] } }))
        else await (client as any).session.promptAsync({ path: { id: sid }, body: { parts: [{ type: 'text', text: core.HANDOFF_FULL_PROMPT }] } })
        await waitIdle(sid, 15 * 60_000).catch(() => {})
        const after2 = await chatMessages(sid)
        text = [...after2].slice(before).reverse().find(m => m.role === 'assistant')?.text ?? ''
      } else {
        // Quick: a fork of this chat asked for the handoff with the built-in prompt; the chat itself is untouched.
        const fork = data(await (client as any).session.fork({ path: { id: sid }, body: {} }))
        side.add(fork.id)
        try {
          const ref = s.model ?? undefined
          const r = data(await (client as any).session.prompt({ path: { id: fork.id }, body: { ...(ref ? { model: ref } : {}), tools: {}, parts: [{ type: 'text', text: core.HANDOFF_PROMPT }] } }))
          text = textOf(r?.parts)
        } finally {
          ;(client as any).session.delete({ path: { id: fork.id } }).catch(() => {})
          setTimeout(() => side.delete(fork.id), 30_000)
        }
      }
      if (!text.trim()) return void toast('The handoff came back empty. Nothing was changed.', 'error')
      const done = await newChatWith(text, after, full ? cfg.handoffSkill || undefined : undefined)
      proof(`handoff ${full ? 'full' : 'quick'} done: ${done}`)
      await toast(done, 'success')
    } catch (e: any) {
      proof(`handoff failed: ${e?.message ?? e}`)
      await toast(`The handoff failed: ${String(e?.message ?? e).slice(0, 100)}`, 'error')
    }
  }

  async function compactNow(sid: string, note: string) {
    const s = st(sid)
    try {
      await modelsMap()
      let ref = s.model
      if (cfg.compactWith === 'small' && smallModel?.includes('/')) ref = { providerID: smallModel.split('/')[0], modelID: smallModel.split('/').slice(1).join('/') }
      if (!ref) return void toast('No model to compact with yet: send a message first.', 'warning')
      if (note.trim()) await (client as any).session.promptAsync({ path: { id: sid }, body: { noReply: true, parts: [{ type: 'text', text: `Keep this in the summary: ${note.trim()}`, synthetic: true }] } }).catch(() => {})
      await (client as any).session.summarize({ path: { id: sid }, body: { providerID: ref.providerID, modelID: ref.modelID } })
      await toast(`Compacted${cfg.compactWith === 'small' && smallModel ? ` with ${smallModel}` : ''}.`, 'success')
    } catch (e: any) {
      await toast(`Compact failed: ${String(e?.message ?? e).slice(0, 100)}`, 'error')
    }
  }

  // --- the judge benchmark ----------------------------------------------------------------------------------------
  async function runBench(sid: string) {
    const s = st(sid)
    const cases: core.BenchCase[] = readJson(BENCH_FILE, { cases: [] }).cases
    if (!cases.length) return `No cases found at ${BENCH_FILE}.`
    const answers: core.BenchAnswer[] = []
    for (const fixed of ['medium', 'high'] as core.Effort[]) for (const c of cases) answers.push({ id: c.id, judge: `always ${fixed}`, effort: fixed, ms: 0, tokens: 0 })
    const judgeName = cfg.judge === 'custom' ? cfg.judgeModel : s.model?.modelID ?? 'judge'
    let next = 0
    const worker = async () => {
      while (next < cases.length) {
        const c = cases[next++]
        // The mod never asks a judge about a short follow-up: it keeps the current effort.
        if (core.keepsEffort(c.message, c.context ?? '')) {
          answers.push({ id: c.id, judge: judgeName, effort: c.current.effort, ms: 0, tokens: 0 })
          continue
        }
        const started = Date.now()
        const asked = core.judgeQuestion(c.message, c.current, c.context ?? '')
        const r = await askModel(s.model, core.JUDGE_SYSTEM, asked)
        const v = 'error' in r ? undefined : core.parseVerdict(r.text)
        answers.push({ id: c.id, judge: judgeName, effort: v?.effort, why: v?.why, sure: v?.sure, ms: Date.now() - started, tokens: 'error' in r ? 0 : r.tokens })
      }
    }
    await Promise.all([worker(), worker()])
    const report = core.benchReport(cases, answers)
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const out = join(directory, `effortless-bench-${stamp}.md`)
    writeFileSync(out, report + '\n')
    writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify({ cases: cases.length, answers }, null, 2))
    return `${report}\n\nSaved to ${out}`
  }

  const postNote = async (sid: string, text: string) => {
    try {
      await (client as any).session.prompt({ path: { id: sid }, body: { noReply: true, parts: [{ type: 'text', text, synthetic: true }] } })
    } catch {
      await toast(text.slice(0, 300), 'info', 15000)
    }
  }

  // --- /effortless -------------------------------------------------------------------------------------------------
  const settingsText = () =>
    [
      'effortless settings (`/effortless set <name> <value>`):',
      `  auto            ${cfg.auto ? 'on' : 'off'}`,
      `  judge           ${cfg.judge}${cfg.judge === 'custom' ? ` → ${cfg.judgeModel} @ ${cfg.judgeUrl}` : ' (the chat\'s own provider, or small_model)'}`,
      `  judgeTimeoutMs  ${cfg.judgeTimeoutMs}`,
      `  bias            ${cfg.bias} (-2 cheaper … 2 smarter)`,
      `  floor / ceiling ${cfg.floor} / ${cfg.ceiling}`,
      `  hide            ${cfg.hide.join(',') || '(nothing)'}   [handoff,timer,reason,swamp,cold,down]`,
      `  swampAt         ${cfg.swampAt}%`,
      `  handoffAfter    ${cfg.handoffAfter}   handoffSkill ${cfg.handoffSkill || '(built in)'}   handoffButton ${cfg.handoffButton}`,
      `  compactWith     ${cfg.compactWith}   helpers ${cfg.helpers}`,
      `  effortModels    ${cfg.effortModels}`,
      `  cacheTtlMinutes ${cfg.cacheTtlMinutes} (0 = no timer; local models have no cache to expire)`,
    ].join('\n')

  async function command(sid: string, args: string): Promise<string> {
    const s = st(sid)
    const [sub = '', ...rest] = args.trim().split(/\s+/)
    const arg = rest.join(' ')
    switch (sub.toLowerCase()) {
      case '':
      case 'help':
        return [
          `effortless: ${cfg.auto ? 'Auto on' : 'Auto off'}, now ${s.paused ? 'paused (this model takes no effort)' : label(s.pick?.effort)}${s.context ? `, context ${Math.round(s.context.percent)}%` : ''}.`,
          'Commands: settings · set <name> <value> · auto [on|off] · save · stats · bench · debug · handoff [full] [continue|confirm|copy] · compact [note] · cold · swamp · down',
        ].join('\n')
      case 'settings':
      case 'setup':
        return settingsText()
      case 'set': {
        const [name, ...v] = rest
        if (!name || !(SETTABLE as readonly string[]).includes(name)) return `Unknown setting. Use one of: ${SETTABLE.join(', ')}.`
        const file = readJson(CONFIG_FILE, {})
        file[name] = v.join(' ')
        const next = core.readConfig({ ...(options ?? {}), ...file })
        cfg = next
        writeJson(CONFIG_FILE, file)
        return `${name} is now ${JSON.stringify((cfg as any)[name])}.\n\n${settingsText()}`
      }
      case 'auto': {
        const want = rest[0]?.toLowerCase()
        const on = want === 'on' ? true : want === 'off' ? false : !cfg.auto
        const file = readJson(CONFIG_FILE, {})
        file.auto = on
        writeJson(CONFIG_FILE, file)
        cfg = core.readConfig({ ...(options ?? {}), ...file })
        if (on && s.pick?.by === 'manual') s.pick = null
        publish(sid)
        return on ? 'Auto on: effort is picked for every prompt.' : 'Auto off: the effort is yours.'
      }
      case 'save':
        saveUntil = saving() ? null : Date.now() + 5 * 3600_000
        persistState()
        publish(sid)
        return saving() ? 'save mode on, Auto stays at medium or below for 5 hours' : 'save mode off'
      case 'stats':
      case 'saved':
        return `Auto, this session:\n${core.savedText(s.spent)}`
      case 'bench':
        void runBench(sid).then(r => postNote(sid, r), e => postNote(sid, `bench failed: ${e?.message ?? e}`))
        return `Running the ${readJson(BENCH_FILE, { cases: [] }).cases.length} labelled prompts through the judge. The report lands in this chat when it is done.`
      case 'debug': {
        const ago = (t: number) => (t ? `${Math.round((Date.now() - t) / 1000)}s ago` : 'never')
        const r = s.lastRequest
        return [
          `loaded ${ago(startedAt)} | auto ${cfg.auto} | pick ${s.pick ? `${s.pick.effort} by ${s.pick.by} (${s.pick.why})` : 'none'} | held ${s.heldPick?.effort ?? 'none'}`,
          `model ${s.model ? `${s.model.providerID}/${s.model.modelID}` : 'unknown'} | takes effort ${s.model ? core.supportsEffort(s.model.providerID, s.model.modelID, cfg) : '?'} | paused ${s.paused}`,
          `context ${s.context ? `${s.context.tokens}/${s.context.window} (${Math.round(s.context.percent)}%)` : 'unknown'} | advice ${s.advice ?? 'none'} | judge down ${s.judgeDown ?? 'no'} | last judge ${s.lastJudge || 'none'}`,
          `hidden ${cfg.hide.join(',') || 'nothing'} | save ${saving()} | side sessions ${side.size}`,
          r ? `last request: ${r.model} at ${r.effort ?? 'none'} (sent ${JSON.stringify(r.sent)}), ${ago(r.at)}` : 'last request: none yet',
          `model used: ${r ? `${r.model} at ${r.effort ?? 'none'}` : 'none yet'}`,
        ].join('\n')
      }
      case 'handoff': {
        const full = rest[0]?.toLowerCase() === 'full'
        const after = (['continue', 'confirm', 'copy'] as const).find(a => rest.includes(a)) ?? lastHandoff.after
        lastHandoff.after = after
        void runHandoff(sid, full, after)
        const then = after === 'copy' ? 'The chat stays and the handoff is copied.' : after === 'confirm' ? 'A new chat opens, says where things stand and waits.' : 'A new chat opens and carries on.'
        return `Writing the ${full ? 'full' : 'quick'} handoff${full && cfg.handoffSkill ? ` with /${cfg.handoffSkill}` : ''}. ${then}`
      }
      case 'compact':
        void compactNow(sid, arg)
        return `Compacting${cfg.compactWith === 'small' && smallModel ? ` with ${smallModel}` : ''}…`
      case 'cold':
        s.forced.cold = true
        s.cacheExpires = Date.now() - 1
        publish(sid)
        void toast('The chat went cold: the next message rereads it at full price. /effortless compact or /effortless handoff.', 'warning', 9000)
        return 'The cache shows as cold now (a test). The next response restarts the countdown.'
      case 'swamp':
        s.forced.swamp = true
        publish(sid)
        void toast('This chat is getting swamped: every message rereads a lot. /effortless compact or /effortless handoff.', 'warning', 9000)
        return 'The swamp alert is showing now (a test). It goes away at the next check unless the chat really is swamped.'
      case 'down':
        warned.delete(sid + 'test')
        warnJudge(sid, 'test')
        return 'The judge-down alert is showing now (a test). It goes away once the judge answers again.'
      case 'hot':
        return 'There is no 5-hour or weekly limit to read from OpenCode, so the running-low alert has nothing to watch. /effortless save still caps Auto at medium.'
      case 'update':
        return 'Updates: this port is not published; see README.md in the effortless-ports folder.'
      default:
        return `Unknown subcommand "${sub}". Try /effortless help.`
    }
  }

  const ECHO = (text: string) => `Reply with exactly the text between the markers, unchanged, in a fenced block. Do not call any tools and add nothing.\n<<<\n${text}\n>>>`

  // --- hooks --------------------------------------------------------------------------------------------------------
  proof(`loaded; auto=${cfg.auto} judge=${cfg.judge}`)

  return {
    config: async c => {
      // Compaction summaries by the small model, when one is set and compaction has no model of its own (Compact with).
      try {
        const small = (c as any).small_model as string | undefined
        const agent = ((c as any).agent ??= {})
        if (cfg.compactWith === 'small' && small && !agent.compaction?.model) agent.compaction = { ...(agent.compaction ?? {}), model: small }
      } catch {}
    },

    'command.execute.before': async (input, output) => {
      try {
        if (input.command !== 'effortless') return
        st(input.sessionID).skipNext = true
        // `opencode run` wraps multi-word arguments in quotes; a person typing /effortless in the TUI never does.
        const text = await command(input.sessionID, (input.arguments ?? '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2'))
        // OpenCode keeps its own reference to this array: mutate it, never reassign output.parts.
        output.parts.splice(0, output.parts.length, { type: 'text', text: ECHO(text) } as any)
      } catch (e: any) {
        output.parts.splice(0, output.parts.length, { type: 'text', text: ECHO(`effortless failed: ${e?.message ?? e}`) } as any)
      }
    },

    'chat.message': async (input, output) => {
      const sid = input.sessionID
      try {
        trace(`chat.message ${sid} enter`)
        if (side.has(sid)) return
        const s = st(sid)
        if (input.model) s.model = { providerID: input.model.providerID, modelID: input.model.modelID }
        if (s.skipNext) {
          s.skipNext = false
          return
        }
        const text = textOf(output.parts)
        if (!text) return
        trace('before sessionInfo')
        const info = await sessionInfo(sid)
        trace(`after sessionInfo parent=${info.parentID}`)
        const model = s.model
        // You always win: a variant chosen in the app after the first one seen turns Auto off.
        const variant = (input as any).variant ?? null
        const firstSeen = s.seenVariant === undefined
        const changedByPerson = !firstSeen && variant !== s.seenVariant && variant !== null
        s.seenVariant = variant
        if (changedByPerson && cfg.auto && !info.parentID) {
          cfg = { ...cfg, auto: false }
          const file = readJson(CONFIG_FILE, {})
          file.auto = false
          writeJson(CONFIG_FILE, file)
          s.pick = { effort: (core.EFFORTS.find(e => e === variant) ?? 'medium') as core.Effort, why: 'your pick in the app', by: 'manual' }
          void toast(`Auto is off. You picked ${variant}; /effortless auto on hands it back.`, 'info')
          publish(sid)
          return
        }
        if (!cfg.auto || !model) return publish(sid)
        if (!(await gate(model.providerID, model.modelID))) {
          s.paused = true
          return publish(sid)
        }
        s.paused = false

        // A turn is running: a message typed now often steers that task, and the judge is told so.
        const midTurn = s.busy && Date.now() - s.busyAt < 10 * 60_000 && s.pick !== null
        s.busy = true
        s.busyAt = Date.now()

        // Helpers (subagents): the judge picks an effort for the task only when helpers=on.
        if (info.parentID) {
          if (cfg.helpers !== 'on') return
          const r = await judge(sid, text, null, '')
          if (r.verdict) {
            const leaned = core.bounded(core.tipped(r.verdict.effort, r.verdict.sure, cfg.bias), core.helperFloor(cfg.floor, cfg.ceiling), cfg.ceiling)
            s.pick = { effort: core.capped(leaned, saving()), why: r.verdict.why, by: 'judge', ...(r.verdict.sure !== undefined ? { sure: r.verdict.sure } : {}) }
            s.spent.helpers.runs[s.pick.effort] = (s.spent.helpers.runs[s.pick.effort] ?? 0) + 1
          }
          return
        }

        const attachments = output.parts.filter((p: any) => p.type === 'file').map((p: any) => ({ type: String(p.mime ?? '').startsWith('image/') ? 'image' : 'file' }))
        trace('before chatMessages')
        const context = core.contextFrom(await chatMessages(sid))
        trace('after chatMessages')
        // The handoff check runs for every message the person types, whatever the effort judge is doing.
        if (!core.isFollowUp(text)) void checkHandoff(sid, text)

        // "go", "ok", "yes" between two steps of work keep the effort Auto already chose; no judge is asked.
        if (s.pick && s.pick.by !== 'manual' && !attachments.length && core.keepsEffort(text, context)) {
          countPrompt(s, s.pick.effort, undefined, 0, 0)
          proof(`follow-up "${text}": keeping ${s.pick.effort}`)
          return publish(sid)
        }
        // "max effort", "effort: low": the person said the level, so it runs, past Min, Max and save mode, no judge.
        const named = core.namedEffort(text)
        if (named) {
          const applied: core.Pick = { effort: named, why: 'you asked for it', by: 'named' }
          if (midTurn && s.pick && core.EFFORTS.indexOf(named) < core.EFFORTS.indexOf(s.pick.effort)) s.heldPick = applied
          else {
            s.heldPick = null
            s.pick = applied
          }
          countPrompt(s, named, undefined, 0, 0)
          proof(`named level ${named}: no judge`)
          return publish(sid)
        }

        s.judging = true
        publish(sid)
        trace('judge start')
        const asked = midTurn ? core.withMidTurn(core.withAttachments(text, attachments), s.pick!.effort) : core.withAttachments(text, attachments)
        try {
          const started = Date.now()
          const r = await judge(sid, asked, s.pick ?? { effort: 'medium', why: '', by: 'manual' }, context)
          countPrompt(s, r.verdict?.effort, r.verdict ? r.name : undefined, Date.now() - started, r.tokens)
          s.lastJudge = r.verdict ? `${r.name} ${Date.now() - started}ms → ${r.verdict.effort} (${r.verdict.why})` : 'no verdict'
          proof(r.verdict ? `judged by ${r.name} in ${Date.now() - started} ms: ${r.verdict.effort} (${r.verdict.why}) for "${text.slice(0, 50)}"` : `no verdict for "${text.slice(0, 50)}"`)
          if (r.verdict) {
            const applied = core.applyVerdict(r.verdict, cfg, saving())
            // Mid-turn, a lower verdict would cut the running task's effort for its remaining steps: it waits for the
            // turn to end. A higher one helps the task, so it applies.
            if (midTurn && s.pick && core.EFFORTS.indexOf(applied.effort) < core.EFFORTS.indexOf(s.pick.effort)) {
              s.heldPick = applied
              proof(`typed mid-turn: ${applied.effort} waits, the running turn keeps ${s.pick.effort}`)
            } else {
              s.heldPick = null
              s.pick = applied
            }
          }
        } finally {
          s.judging = false
          publish(sid)
        }
      } catch (e: any) {
        proof(`chat.message error: ${e?.stack ?? e}`)
      }
    },

    'chat.params': async (input, output) => {
      try {
        const sid = input.sessionID
        if (side.has(sid)) return
        const s = st(sid)
        s.model = { providerID: input.model.providerID, modelID: input.model.id }
        const effort = await requestEffort(sid, s)
        const supported = core.supportsEffort(input.model.providerID, input.model.id, cfg)
        s.paused = !supported
        if (!effort || !supported) {
          s.lastRequest = { model: `${input.model.providerID}/${input.model.id}`, effort: null, sent: 'unchanged', at: Date.now() }
          return
        }
        const opts = core.effortOptions({ id: input.model.providerID, npm: (input.model as any).api?.npm }, input.model.id, effort)
        if (!opts) return
        Object.assign(output.options, opts)
        s.spent.requests++
        persistSession(input.sessionID)
        s.lastRequest = { model: `${input.model.providerID}/${input.model.id}`, effort, sent: opts, at: Date.now() }
        proof(`request (${input.model.providerID}/${input.model.id}): effort ${effort} → ${JSON.stringify(opts)}`)
      } catch (e: any) {
        proof(`chat.params error: ${e?.stack ?? e}`)
      }
    },

    event: async ({ event }: { event: any }) => {
      try {
        if (event.type === 'message.updated') {
          const m = event.properties?.info
          if (!m || m.role !== 'assistant' || !m.time?.completed || side.has(m.sessionID)) return
          const s = st(m.sessionID)
          if (s.counted.has(m.id)) return
          s.counted.add(m.id)
          const t = m.tokens ?? {}
          const usage = { input_tokens: t.input ?? 0, output_tokens: (t.output ?? 0) + (t.reasoning ?? 0), cache_read_input_tokens: t.cache?.read ?? 0, cache_creation_input_tokens: t.cache?.write ?? 0 }
          // Only requests Auto steered count.
          if (s.pick && s.pick.by !== 'manual' && cfg.auto && !(await sessionInfo(m.sessionID)).parentID) {
            const e = s.pick.effort
            const w = core.weighted(usage)
            s.spent.input += usage.input_tokens; s.spent.write += usage.cache_creation_input_tokens; s.spent.read += usage.cache_read_input_tokens; s.spent.out += usage.output_tokens
            s.spent.byEffort[e] = { prompts: s.spent.byEffort[e]?.prompts ?? 0, cost: (s.spent.byEffort[e]?.cost ?? 0) + w }
          }
          const model = await modelOf(m.providerID, m.modelID)
          const window = Number(model?.limit?.context ?? 0)
          const tokens = Number(t.total ?? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens)
          if (window > 0) s.context = { tokens, window, percent: (tokens / window) * 100 }
          if (cfg.cacheTtlMinutes > 0 && (usage.cache_read_input_tokens > 0 || usage.cache_creation_input_tokens > 0)) {
            s.cacheExpires = Date.now() + cfg.cacheTtlMinutes * 60_000
            s.alerted.cold = false
          }
          publish(m.sessionID)
        } else if (event.type === 'session.idle') {
          const sid = event.properties?.sessionID as string
          if (!sid || side.has(sid)) return
          const s = st(sid)
          s.busy = false
          if (s.heldPick) {
            s.pick = s.heldPick
            s.heldPick = null
          }
          waiters.get(sid)?.()
          // Alerts wait for the turn to end: Compact or Handoff mid-turn would cut the reply off.
          const over = (s.context?.percent ?? 0) >= cfg.swampAt || !!s.forced.swamp
          if (over && !s.alerted.swamp && !hidden('swamp')) {
            s.alerted.swamp = true
            void toast(`This chat is getting swamped (${Math.round(s.context?.percent ?? 0)}%): every message rereads a lot. /effortless compact or /effortless handoff`, 'warning', 10000)
          }
          if (!over) s.alerted.swamp = false
          s.forced.swamp = false
          if (cfg.cacheTtlMinutes > 0 && s.cacheExpires > 0 && core.minutesLeft(s.cacheExpires, Date.now()) === 0 && (s.context?.tokens ?? 0) >= core.COLD_MIN_TOKENS && !s.alerted.cold && !hidden('cold')) {
            s.alerted.cold = true
            void toast('This chat went cold: the next message rereads it at full price. /effortless compact', 'warning', 10000)
          }
          publish(sid)
        } else if (event.type === 'session.compacted') {
          const sid = event.properties?.sessionID as string
          if (sid) {
            const s = st(sid)
            s.context = null
            s.advice = null
            s.alerted = { swamp: false, cold: false }
            publish(sid)
          }
        }
      } catch (e: any) {
        proof(`event error: ${e?.stack ?? e}`)
      }
    },
  }
}
