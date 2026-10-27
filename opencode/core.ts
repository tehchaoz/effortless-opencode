// effortless for OpenCode: the pure logic, ported from HeyCubit/effortless (MIT) v1.72.0.
//
// Everything here is a function of its arguments: no OpenCode, no network, no files. The plugin (effortless.ts) does
// the I/O and calls these. parity/vectors.json holds what the original answered for the same inputs, and
// core.test.ts checks this file against it, so a port that drifts from the original fails a test.
//
// Written in erasable TypeScript (no enums, no parameter properties) so Node 22 runs it with --experimental-strip-types.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const EFFORT_LABELS: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }

// What one token costs relative to an uncached input token (the original's measured ratios).
export const WEIGHT = { input: 1, write: 1.25, read: 0.1, out: 5 }

/** What the next turn runs with, and who decided it. */
export type Pick = {
  effort: Effort
  /** A few words on why. */
  why: string
  /** judge: the judge model picked it. named: the person said the level ("max effort"). manual: the person set it in the app. */
  by: 'judge' | 'named' | 'manual'
  /** How sure the judge was of the effort, 0-1, when it said. */
  sure?: number
  /** Why a handoff would suit now (a few words), when the judge said it would. */
  handoff?: string
}

export type HandoffAfter = 'continue' | 'confirm' | 'copy'

// ---------------------------------------------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------------------------------------------

// The original's judge prompt picks a Claude model AND an effort. OpenCode runs whatever model the person chose and
// this port does not switch models (the original's "cheaper model when it can" is experimental and off by default,
// and rests on Anthropic's per-model prompt caches), so the model tiers and the model-relative paragraph are gone.
// Every other paragraph is the original's, word for word.
export const JUDGE_SYSTEM = `You choose which reasoning effort an agentic assistant (it reads files, runs tools and edits things, not only code) should use for the user's next message. Pick the cheapest effort that will still do the job well.

Effort: low for quick answers, medium for normal work, high for hard problems, xhigh or max only for very hard ones.

Effort is relative to the model in use ("Current" names it): a stronger model needs less effort for the same job.

Judge the SCOPE and the amount of work, not whether it is code. A short message can ask for a lot: "go through my whole drive and clean it up", "review the entire repo", "migrate everything" are big, multi-step, tool-heavy jobs where mistakes are costly: never low, usually high. Low is only for answers that need no tools and no planning.

If the message answers a question in the assistant's last reply (picks an option, says which one, confirms a plan), judge only the work that answer starts, as the reply describes it, not the length of the answer and not the work done before the question: "B" can mean "build the complicated section B" (high), while "yes" or "no" to one small action ("should I archive this?", "delete the old ones too?") is low, and picking a value for one setting (a log level, a colour, a font) is low. But picking which way to build something ("option 1", "the same shapes", "B") starts that build: judge the build. Approving a whole plan or several steps takes the effort of that plan. A plain "yes", "ok" or "do it" after "Is that OK? Then I'll build X" or "Should I build X?" approves building X: judge X, not the word.

A message that pushes back on, corrects or adds to a plan or claim under discussion continues that work: keep at least the effort that work had, never drop to low for it. Thanks, praise or a closing remark with no new request is low. A question about how to do something, or about effort itself, that needs no tools is low.

If the person asks for deep thought ("think hard", "ultrathink", "be thorough"), pick at least high; if they ask for a quick answer, pick low.

If the message is a short follow-up to ongoing work ("yes", "go", "ok", "continue", or the same in any language), keep the current effort.

Reply with JSON only: {"effort":"low|medium|high|xhigh|max","sure":0.0-1.0 how sure you are of the effort,"why":"at most 6 words, in the user's language"}`

export type Verdict = { model?: string; effort: Effort; why: string; sure?: number; handoff?: string }

/** Reads `{ effort, why, sure }` out of a reply, or nothing when it doesn't hold one. A `model` field is carried if present. */
export function parseVerdict(text: string): Verdict | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { model, effort, why, sure, handoff } = raw as Record<string, unknown>
  if (!EFFORTS.includes(effort as Effort)) return undefined
  const how = typeof sure === 'number' && sure >= 0 && sure <= 1 ? { sure } : {}
  // Only a reason counts: "handoff":"" or false is no advice.
  const advice = typeof handoff === 'string' && handoff.trim() ? { handoff: handoff.trim().slice(0, 70) } : {}
  const named = typeof model === 'string' && model ? { model } : {}
  return { ...named, effort: effort as Effort, why: typeof why === 'string' ? why.slice(0, 60) : '', ...how, ...advice }
}

/** The assistant's last reply, or nothing. */
function lastAssistantText(messages: readonly { role: string; text: string }[]): string {
  return [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim())?.text ?? ''
}

/** The context text from the conversation so far: the last user message, short, and the assistant's last reply's end. */
export function contextFrom(messages: readonly { role: string; text: string }[]): string {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const lastAssistant = lastAssistantText(messages)
  return [lastUser ? `user: ${lastUser.text.slice(0, 400)}` : '', lastAssistant ? `assistant: ${lastAssistant.slice(-2000)}` : '']
    .filter(Boolean)
    .join('\n')
}

const LEVEL_WORD = '(low|medium|high|xhigh|x-high|extra[- ]high|max|maximum)'
const NAMED_LEVEL = new RegExp(`\\b${LEVEL_WORD}\\s+effort\\b|\\beffort(?:\\s+level)?\\s*(?:[:=]|to|at|of|on)?\\s*${LEVEL_WORD}\\b|\\bxhigh\\b`, 'gi')
const LEVEL_OF: Record<string, Effort> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', 'x-high': 'xhigh', 'extra high': 'xhigh', 'extra-high': 'xhigh', max: 'max', maximum: 'max' }

/**
 * The level a prompt asks for by name ("max effort", "effort: high", "xhigh"), or nothing. The word effort must sit
 * beside the level, so "a medium sized image" names nothing, and "don't use max effort" is a no. A named level runs
 * without the judge.
 */
export function namedEffort(text: string): Effort | undefined {
  for (const m of text.matchAll(NAMED_LEVEL)) {
    const before = text.slice(Math.max(0, m.index - 20), m.index).toLowerCase()
    if (/\b(not|no|don'?t|never|without|instead of)\b/.test(before)) continue
    return LEVEL_OF[(m[1] ?? m[2] ?? 'xhigh').toLowerCase().replace(/\s+/, ' ')]
  }
  return undefined
}

/** A short follow-up such as "go", "ok", "yes", "continue": two words and a dozen characters at most. */
export function isFollowUp(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && t.length <= 12 && t.split(/\s+/).length <= 2
}

/**
 * Whether the assistant's last reply ended on a question ("Should I archive it?", "A, B or C?"). A short message
 * after one answers it, and the answer can start a small or a big job, so it goes to the judge instead of keeping
 * the effort.
 */
export function endsOnQuestion(context: string): boolean {
  const reply = context.split('\nassistant: ').pop() ?? ''
  return context.includes('assistant: ') && reply.slice(-400).includes('?')
}

/** The message as the judge reads it: images and files it carries are named, since the judge sees only text. */
export function withAttachments(text: string, attachments?: readonly { type: string }[]): string {
  if (!attachments?.length) return text
  const counts = new Map<string, number>()
  for (const a of attachments) counts.set(a.type, (counts.get(a.type) ?? 0) + 1)
  const said = [...counts].map(([type, n]) => `${n} ${type}${n > 1 ? 's' : ''}`).join(', ')
  return `${text}

[The message comes with ${said} to look at.]`
}

/** The message as the judge reads it when it was typed while a task was still running. */
export function withMidTurn(text: string, effort: Effort): string {
  return `${text}

[Sent while the assistant was still working on the last task at ${effort} effort. If it adds to, corrects or steers that task, keep ${effort}; judge it on its own only if it is a separate new request.]`
}

/** A short follow-up that keeps the current effort: "go" between two steps, not an answer to a question. */
export function keepsEffort(message: string, context: string): boolean {
  return isFollowUp(message) && !endsOnQuestion(context)
}

/** The text the judge reads: the current effort, the last turns and the next message. */
export function judgeQuestion(prompt: string, current: { model?: string; effort: Effort } | null, context: string): string {
  return [
    current ? `Current: ${current.model ?? 'model'} / ${current.effort}` : 'Current: none',
    context ? `Recent conversation:\n${context}` : '',
    `Next message:\n${prompt.slice(0, 2000)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ---------------------------------------------------------------------------------------------------------------
// What happens to a verdict
// ---------------------------------------------------------------------------------------------------------------

export const REDO_STAY_PROMPTS = 4
const REDO_RE = /^(no|nope|nah)(?![a-z'])(?! +(problem|worries|thanks|thank|need|rush|hurry))|^(that'?s |this is |it'?s )?(wrong|incorrect|not (right|correct|what i))|^(it |that |this )?(still )?(doesn'?t|didn'?t|isn'?t|does not|did not|is not) (work|fix|help|change|run|compile|pass)|^still (not|broken|wrong|failing|fails|the same|happening|doesn'?t)|^(not working|try again|do it again|redo|you missed|you forgot|you broke)|^(fel|inte rätt|funkar inte|fungerar inte|försök igen|gör om|det är fel)(?![a-zåäö])|(still (broken|wrong|failing)|try again|funkar fortfarande inte)/i
/** A message that says the last answer was wrong. (The original uses it to undo a cheaper-model switch; kept for parity and for the stats line.) */
export function looksLikeRedo(text: string): boolean {
  return REDO_RE.test(text.trim().replace(/^["'“ ]+/, ''))
}

/**
 * The effort slider tips close calls only: a verdict the judge was unsure of moves one step toward cheaper or smarter.
 * The outer stops count more calls as close. A sure verdict, or one without a confidence, stays as it is.
 */
export function tipped(effort: Effort, sure: number | undefined, bias: number): Effort {
  if (!bias || sure === undefined || sure >= (Math.abs(bias) === 1 ? 0.65 : 0.85)) return effort
  const i = Math.max(0, Math.min(EFFORTS.length - 1, EFFORTS.indexOf(effort) + Math.sign(bias)))
  return EFFORTS[i]
}

/** Floor and ceiling from the settings: what Auto picks stays between them. */
export function bounded(effort: Effort, floor: Effort, ceiling: Effort): Effort {
  const lo = EFFORTS.indexOf(floor)
  const hi = Math.max(lo, EFFORTS.indexOf(ceiling))
  return EFFORTS[Math.max(lo, Math.min(hi, EFFORTS.indexOf(effort)))]
}

/** Save mode caps what Auto picks at medium; a higher pick comes down to it. */
export function capped(effort: Effort, saving: boolean): Effort {
  return saving && EFFORTS.indexOf(effort) > EFFORTS.indexOf('medium') ? 'medium' : effort
}

/** The lowest effort a helper (subagent) gets: medium, or the person's Min when higher, never above their Max. */
export function helperFloor(floor: Effort, ceiling: Effort): Effort {
  const i = Math.min(Math.max(EFFORTS.indexOf(floor), EFFORTS.indexOf('medium')), EFFORTS.indexOf(ceiling))
  return EFFORTS[i]
}

/** The whole path from a verdict to the effort that runs: slider, then Min/Max, then save mode. */
export function applyVerdict(verdict: Verdict, cfg: { bias: number; floor: Effort; ceiling: Effort }, saving: boolean): Pick {
  const leaned = bounded(tipped(verdict.effort, verdict.sure, cfg.bias), cfg.floor, cfg.ceiling)
  const effort = capped(leaned, saving)
  const why = effort !== leaned ? 'save mode' : leaned !== verdict.effort ? 'your settings' : verdict.why
  return { effort, why, by: 'judge', ...(verdict.sure !== undefined ? { sure: verdict.sure } : {}), ...(verdict.handoff ? { handoff: verdict.handoff } : {}) }
}

// ---------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------

/** The swamp thresholds the settings offer, in percent of the context window. */
export const SWAMP_STEPS = [10, 20, 30, 40, 50, 60, 70, 80] as const
/** The parts a person can switch off: the handoff button/advice, the cache timer, the judge's reason, and the alerts. */
export const HIDEABLE = ['handoff', 'timer', 'reason', 'swamp', 'cold', 'down'] as const
export type Hideable = (typeof HIDEABLE)[number]

export type Config = {
  /** Auto: the judge picks the effort for every prompt. */
  auto: boolean
  /** auto: the judge runs on the chat's own provider (or small_model); custom: judgeUrl/judgeModel. */
  judge: 'auto' | 'custom'
  judgeUrl: string
  judgeModel: string
  /** Name of an env var holding the judge's API key (never the key itself). */
  judgeKeyEnv: string
  judgeTimeoutMs: number
  /** The effort slider, -2 (cheaper) to 2 (smarter): tips the judge's close calls that way. */
  bias: number
  floor: Effort
  ceiling: Effort
  hide: Hideable[]
  swampAt: number
  /** A skill or slash command that writes the Full handoff, e.g. "session-handoff". Empty: effortless writes it itself. */
  handoffSkill: string
  handoffAfter: HandoffAfter
  handoffButton: 'advised' | 'always'
  /** small: the judge/small model writes a compaction's summary; session: the chat's own model. */
  compactWith: 'small' | 'session'
  /** on: every subagent the chat sends off gets an effort picked by the judge before it starts. */
  helpers: 'on' | 'off'
  /** Models effort is applied to (regex source, matched against "provider/model"). Others show Paused. */
  effortModels: string
  /** Minutes the provider's prompt cache stays warm after a response; 0 hides the cache timer (local models have none). */
  cacheTtlMinutes: number
}

/** gpt-oss and OpenAI reasoning models, Claude Opus/Sonnet, Gemini thinking models: the ones that take an effort. */
export const DEFAULT_EFFORT_MODELS = 'gpt-oss|gpt-5|(^|[/-])o[134]([-:.]|$)|claude-(opus|sonnet)|claude.*(opus|sonnet)|gemini-(2\\.5|3)'

export const DEFAULTS: Config = {
  auto: true,
  judge: 'auto',
  judgeUrl: '',
  judgeModel: '',
  judgeKeyEnv: '',
  judgeTimeoutMs: 8000,
  bias: 0,
  floor: 'low',
  ceiling: 'max',
  hide: ['reason'],
  swampAt: 70,
  handoffSkill: '',
  handoffAfter: 'continue',
  handoffButton: 'advised',
  compactWith: 'small',
  helpers: 'off',
  effortModels: DEFAULT_EFFORT_MODELS,
  cacheTtlMinutes: 0,
}

/** The settings as stored or passed (loose types), cleaned to the shape the plugin reads. Same clamps as the original. */
export function readConfig(options: unknown): Config {
  const o = (options ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
  const pickOf = <T extends string>(v: unknown, choices: readonly T[], dflt: T): T => (choices.find(c => c === str(v)) ?? dflt)
  const num = (v: unknown, dflt: number) => (Number.isFinite(Number(str(v))) && str(v) !== '' ? Number(str(v)) : dflt)
  return {
    auto: o.auto === undefined ? true : !(o.auto === false || str(o.auto) === 'false' || str(o.auto) === 'off'),
    judge: str(o.judge) === 'custom' ? 'custom' : 'auto',
    judgeUrl: str(o.judgeUrl).replace(/\/+$/, ''),
    judgeModel: str(o.judgeModel),
    judgeKeyEnv: str(o.judgeKeyEnv),
    judgeTimeoutMs: Math.max(1000, Math.min(60000, Math.round(num(o.judgeTimeoutMs, DEFAULTS.judgeTimeoutMs)))),
    bias: Math.max(-2, Math.min(2, Math.round(Number(str(o.bias ?? o.effortBias)) || 0))),
    floor: pickOf(o.floor ?? o.effortFloor, EFFORTS, 'low'),
    ceiling: pickOf(o.ceiling ?? o.effortCeiling, EFFORTS, 'max'),
    swampAt: SWAMP_STEPS.includes(Number(str(o.swampAt)) as (typeof SWAMP_STEPS)[number]) ? Number(str(o.swampAt)) : 70,
    handoffSkill: str(o.handoffSkill).replace(/^\//, ''),
    handoffAfter: pickOf(o.handoffAfter, ['continue', 'confirm', 'copy'] as const, 'continue'),
    handoffButton: str(o.handoffButton) === 'always' ? 'always' : 'advised',
    compactWith: str(o.compactWith) === 'session' ? 'session' : 'small',
    helpers: str(o.helpers) === 'on' ? 'on' : 'off',
    effortModels: str(o.effortModels) || DEFAULT_EFFORT_MODELS,
    cacheTtlMinutes: Math.max(0, Math.min(1440, Math.round(num(o.cacheTtlMinutes, 0)))),
    // The judge's line is off until switched on; an empty string saved from the panel means everything shows.
    hide: (o.hide === undefined ? 'reason' : Array.isArray(o.hide) ? o.hide.join(',') : str(o.hide))
      .split(',')
      .map(part => part.trim())
      .filter((part): part is Hideable => (HIDEABLE as readonly string[]).includes(part)),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Which model takes an effort, and how it is sent
// ---------------------------------------------------------------------------------------------------------------

/** Whether effort is applied to this model. Anything else shows Paused and runs as the app set it. */
export function supportsEffort(providerID: string, modelID: string, cfg: Pick2<Config, 'effortModels'>): boolean {
  try {
    return new RegExp(cfg.effortModels, 'i').test(`${providerID}/${modelID}`)
  } catch {
    return false
  }
}
type Pick2<T, K extends keyof T> = { [P in K]: T[P] }

/**
 * The provider options that carry an effort to this model. The names are those OpenCode forwards to the AI SDK
 * provider; the levels are clamped to what the model takes (gpt-oss has low/medium/high only). Nothing for a
 * model this does not know how to steer.
 */
export function effortOptions(provider: { id?: string; npm?: string }, modelID: string, effort: Effort): Record<string, unknown> | undefined {
  const npm = provider.npm ?? ''
  const id = `${provider.id ?? ''}/${modelID}`.toLowerCase()
  const three = (e: Effort) => (e === 'low' || e === 'medium' ? e : 'high')
  if (/claude|anthropic/.test(id) || /anthropic/.test(npm)) return { effort: e4(effort) }
  if (/gemini|google/.test(id) || /google/.test(npm)) return undefined
  if (/gpt-oss/.test(id)) return { reasoningEffort: three(effort) }
  // OpenAI's own reasoning models take xhigh on the newest ones; the rest stop at high.
  if (/gpt-5\.[2-9]|codex-max/.test(id)) return { reasoningEffort: effort === 'max' ? 'xhigh' : effort }
  if (/gpt-5|(^|[/-])o[134]([-:.]|$)/.test(id) || /openai/.test(npm)) return { reasoningEffort: three(effort) }
  // DeepSeek V4.x on opencode/opencode-go: models.dev declares effort values low|high|max only
  // (no medium), so medium folds up to high and xhigh folds to max. Verified against
  // https://models.dev/api.json (reasoning_options: type effort, values low/high/max).
  if (/deepseek-v4/.test(id)) return { reasoningEffort: effort === 'low' ? 'low' : effort === 'xhigh' || effort === 'max' ? 'max' : 'high' }
  return undefined
}
const e4 = (e: Effort) => (e === 'xhigh' ? 'high' : e)

// ---------------------------------------------------------------------------------------------------------------
// Handoff and compact
// ---------------------------------------------------------------------------------------------------------------

export const HANDOFF_CHECK_FROM = 30
export const HANDOFF_CHECK_EVERY = 2
export const HANDOFF_SYSTEM = `You decide whether the person should hand off now: start a fresh chat that carries over a short summary, instead of carrying on in this one. You are shown what the chat was for, the trail of what the person asked, the last turns, the next message, how full the context is and whether the cache is cold.

Say yes only for a clear reason: the task just finished and the next message is something else, the topic has changed so the old context is dead weight, the chat keeps going in circles on the same problem, or a long chat now holds so much unrelated history that a clean start would be sharper. A normal next step of the same work is never a reason, a long chat by itself is not one, and neither is a high context share when the work is going well. When unsure, say no: a wrong yes costs the person more than a missed one.

Reply with JSON only: {"handoff":"reason of at most 8 words, in the person's language"} for yes, or {"handoff":null} for no.`

/** What the handoff check reads: the chat's purpose, a trail of the person's messages, the last reply's end. */
export function handoffEvidence(messages: readonly { role: string; text: string }[], next: string, percent: number, cold: boolean): string {
  const asked = messages.filter(m => m.role === 'user' && m.text.trim())
  const first = asked[0]?.text.slice(0, 500) ?? ''
  const trail = asked.slice(-8, -1).map(m => `- ${m.text.slice(0, 160).replace(/\s+/g, ' ')}`)
  const reply = lastAssistantText(messages).slice(-700)
  return [
    first ? `What the chat was for (first message):\n${first}` : '',
    trail.length ? `Trail of earlier messages:\n${trail.join('\n')}` : '',
    reply ? `The assistant's last reply (its end):\n${reply}` : '',
    `Next message:\n${next.slice(0, 600)}`,
    `Context used: ${Math.round(percent)}% of the window; ${asked.length} messages so far; the cache is ${cold ? 'cold' : 'warm'}.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Reads the judge's answer: a reason, or null for no (anything unreadable is no). */
export function parseHandoffAnswer(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const { handoff } = JSON.parse(match[0]) as { handoff?: unknown }
    return typeof handoff === 'string' && handoff.trim() ? handoff.trim().slice(0, 70) : null
  } catch {
    return null
  }
}

export const HANDOFF_PROMPT = [
  'Write a handoff so this work can continue in a fresh chat that has no other context.',
  '',
  'Start with the project, its folder and the branch. Then:',
  '- Goal: one or two lines.',
  '- Done: what changed, with file paths, and how each change was checked. Never present something planned, skipped or untested as done.',
  '- Not done: what is half done, and the concrete blocker (a failed check, a missing approval, an open question).',
  '- Git: local changes, local commits, pushed commits and open PRs, as last seen in this chat. You cannot check now, so say "as of last check".',
  '- Next steps in priority order. Make the first one runnable: a file path, a command or a specific decision. Mark every step that needs the user with "needs user".',
  '- To resume: the start command, the preview URL, and the limits on what is allowed (what needs the user\'s approval, test vs production).',
  '- Do not redo: decisions made and why, approaches that failed.',
  '',
  'Give only the final state of anything that changed during the chat. Point to specs, plans and files instead of ' +
    'copying them. Leave out what is finished and no longer matters. Never include secrets, environment values or raw ' +
    'logs. Write in the language the user writes in. Short bullets, at most about 40 lines. Do not use tools. Reply ' +
    'with the handoff only, no preamble or farewell.',
].join('\n')

/** The full handoff when no skill of the person's is picked: a turn that may check git and save the handoff, then replies with it. */
export const HANDOFF_FULL_PROMPT = [
  'Write a handoff so this work can continue in a fresh chat that has no other context. You may use tools for this.',
  '',
  '1. Check the real state: git status, the last few commits, whether the branch is pushed, open PRs if gh is set up.',
  '2. Rewrite HANDOFF.md in the project root from scratch (keep it under 80 lines): branch and open PRs, what is half done,',
  '   next steps with the first one runnable, what only the user can do, and pointers to specs, plans and files.',
  '   Never put secrets or environment values in it.',
  '3. Reply with the handoff itself, in the same shape:',
  '',
  HANDOFF_PROMPT.split('\n').slice(2).join('\n').replace('Do not use tools. ', ''),
].join('\n')

/** The first message of the fresh chat: the handoff, then what to do with it. */
export function handoffMessage(handoff: string, after: HandoffAfter, skill?: string): string {
  const ask =
    after === 'confirm'
      ? 'Read this, say in two lines where things stand and what is next, then wait for me.'
      : 'Continue with the next step. If it is marked "needs user", say what you need and wait.'
  // A full handoff is the person's own skill: it saves the handoff (a file, memories), and its last words in the chat
  // are often only a note that it did. The new chat is told to read what the skill saved before anything else.
  if (skill)
    return (
      `Handoff from the previous chat: it ran /${skill}, which saved the handoff. Its last words there:\n\n${handoff.trim()}\n\n` +
      `First read the handoff /${skill} saved: the files named above, or HANDOFF.md in the project if none is named. ${ask}`
    )
  return `Handoff from the previous chat:\n\n${handoff.trim()}\n\n${ask}`
}

/** A transcript of a chat for the quick handoff's side call: oldest dropped first when it is long. */
export function transcriptOf(messages: readonly { role: string; text: string }[], maxChars = 60_000): string {
  const lines = messages.filter(m => m.text.trim()).map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text.trim()}`)
  let out = lines.join('\n\n')
  if (out.length > maxChars) out = '[earlier part of the chat left out]\n\n' + out.slice(out.length - maxChars)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Cache timer (only for providers whose prompt cache expires: cacheTtlMinutes > 0)
// ---------------------------------------------------------------------------------------------------------------

const CACHE_YELLOW_MIN = 20
const CACHE_RED_MIN = 5
const ICE = '#7cc4ff'
const YELLOW = '#e0a33a'
const RED = '#e5534b'

/** The countdown's colour for whole minutes left (rounded up): none (grey), yellow or red. */
export function cacheColor(minutesLeft: number): string | undefined {
  const shown = minutesLeft - 1
  if (minutesLeft <= 0) return ICE
  if (shown > CACHE_YELLOW_MIN) return undefined
  return shown <= CACHE_RED_MIN ? RED : YELLOW
}

/** The words for the time left: "58m", "<1m", or "Cold". */
export function cacheLabel(minutesLeft: number): string {
  if (minutesLeft <= 0) return '❄ Cold'
  if (minutesLeft === 1) return '<1m'
  return `${minutesLeft - 1}m`
}

/** The countdown to the second: "58:41", or "Cold" once it ran out. */
export function cacheClock(msLeft: number): string {
  if (msLeft <= 0) return '❄ Cold'
  const s = Math.ceil(msLeft / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Whole minutes left (rounded up) for an expiry; 0 once it passed or when no cache was written yet. */
export function minutesLeft(expires: number, now: number): number {
  return expires > 0 ? Math.max(0, Math.ceil((expires - now) / 60_000)) : 0
}

/** Below this a cold cache costs too little to warn about (the original's figure, in tokens). */
export const COLD_MIN_TOKENS = 400_000

// ---------------------------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------------------------

export type Spent = {
  prompts: number
  requests: number
  input: number
  write: number
  read: number
  out: number
  byEffort: Partial<Record<Effort, { prompts: number; cost: number }>>
  /** How often each judge decided (by name), the time it took in all (ms), and its tokens. */
  judge: { counts: Record<string, number>; ms: number; tokens: number }
  moved: number
  redone: number
  helpers: { runs: Partial<Record<Effort, number>>; requests: number; cost: number }
}

export function emptySpent(): Spent {
  return { prompts: 0, requests: 0, input: 0, write: 0, read: 0, out: 0, byEffort: {}, judge: { counts: {}, ms: 0, tokens: 0 }, moved: 0, redone: 0, helpers: { runs: {}, requests: 0, cost: 0 } }
}

export function asSpent(t: unknown): Spent {
  const v = (t ?? {}) as Partial<Spent>
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  const judged = (v.judge ?? {}) as Partial<Spent['judge']>
  const counts: Record<string, number> = {}
  for (const [k, n] of Object.entries(judged.counts ?? {})) counts[k] = num(n)
  return {
    prompts: num(v.prompts),
    requests: num(v.requests),
    input: num(v.input),
    write: num(v.write),
    read: num(v.read),
    out: num(v.out),
    byEffort: v.byEffort && typeof v.byEffort === 'object' ? v.byEffort : {},
    judge: { counts, ms: num(judged.ms), tokens: num(judged.tokens) },
    moved: num(v.moved),
    redone: num(v.redone),
    helpers: {
      runs: v.helpers?.runs && typeof v.helpers.runs === 'object' ? v.helpers.runs : {},
      requests: num(v.helpers?.requests),
      cost: num(v.helpers?.cost),
    },
  }
}

/** A request's tokens weighted by price, in input-token terms (see WEIGHT). */
export function weighted(usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  return (
    (usage.input_tokens ?? 0) * WEIGHT.input +
    (usage.cache_creation_input_tokens ?? 0) * WEIGHT.write +
    (usage.cache_read_input_tokens ?? 0) * WEIGHT.read +
    (usage.output_tokens ?? 0) * WEIGHT.out
  )
}

function tokens(n: number): string {
  const v = Math.abs(n)
  const text = v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
  return n < 0 ? `-${text}` : text
}
const share = (part: number, whole: number) => `${Math.round((part / whole) * 100)} %`

/**
 * What /effortless stats answers: what the prompts Auto steered cost, measured, split by effort, and what the judge
 * took. No "saved" figure: what a prompt would have cost at another effort is not known, since effort mostly changes
 * how many tool calls it makes. Cost is in tokens weighted as priced (WEIGHT).
 */
export function savedText(raw: Spent): string {
  const t = asSpent(raw)
  const judgeCalls = Object.values(t.judge.counts).reduce((n, c) => n + c, 0)
  const helperRuns = EFFORTS.reduce((n, e) => n + (t.helpers.runs[e] ?? 0), 0)
  if (t.prompts === 0 && judgeCalls === 0 && t.moved === 0 && helperRuns === 0) return 'nothing measured yet'
  const input = t.input * WEIGHT.input
  const write = t.write * WEIGHT.write
  const cached = t.read * WEIGHT.read
  const out = t.out * WEIGHT.out
  const total = input + write + cached + out
  const lines = [
    `${t.prompts} prompts, ${t.requests} requests, cost about ${tokens(Math.round(total))} tokens weighted by price` +
      (total > 0 ? ` (cache reads ${share(cached, total)}, cache writes ${share(write, total)}, output ${share(out, total)})` : ''),
  ]
  const per = EFFORTS.filter(e => t.byEffort[e]?.prompts).map(e => {
    const b = t.byEffort[e]!
    return `${EFFORT_LABELS[e]} ${b.prompts}, average ${tokens(Math.round(b.cost / b.prompts))}`
  })
  if (per.length) lines.push(`Per prompt: ${per.join('; ')}`)
  if (t.moved) {
    lines.push(`Cheaper model: ${t.moved} prompt${t.moved === 1 ? '' : 's'} moved down, ${t.redone} redone (${share(t.redone, t.moved)})`)
  }
  if (helperRuns) {
    const per = EFFORTS.filter(e => t.helpers.runs[e]).map(e => `${EFFORT_LABELS[e]} ${t.helpers.runs[e]}`)
    lines.push(`Helpers: ${helperRuns} subagent${helperRuns === 1 ? '' : 's'} (${per.join(', ')}), ${t.helpers.requests} requests, cost about ${tokens(Math.round(t.helpers.cost))} tokens`)
  }
  if (judgeCalls) {
    const who = Object.entries(t.judge.counts).map(([name, n]) => `${name} ${n}`).join(', ')
    lines.push(`Judge: ${who}, average ${Math.round(t.judge.ms / judgeCalls)} ms, ${tokens(t.judge.tokens)} tokens in all`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------------------
// The judge benchmark (/effortless bench)
// ---------------------------------------------------------------------------------------------------------------

export type BenchCase = { id: string; kind: string; holdout?: boolean; current: { model?: string; effort: Effort }; context?: string; message: string; ok: Effort[] }
export type BenchAnswer = { id: string; judge: string; effort?: Effort; why?: string; sure?: number; ms: number; tokens: number }

/** Where an answer lands against the labels: right, too low (risks quality), too high (wastes), or no answer. */
export function benchGrade(c: { ok: Effort[] }, effort: Effort | undefined): 'hit' | 'under' | 'over' | 'none' {
  if (!effort) return 'none'
  if (c.ok.includes(effort)) return 'hit'
  const rank = EFFORTS.indexOf(effort)
  return rank < Math.min(...c.ok.map(e => EFFORTS.indexOf(e))) ? 'under' : 'over'
}

/** The benchmark's table: per judge the share it got right, how it missed, and how fast it was; then per set and kind. */
export function benchReport(cases: BenchCase[], answers: BenchAnswer[]): string {
  const byId = new Map(cases.map(c => [c.id, c]))
  const judges = [...new Set(answers.map(a => a.judge))]
  const kinds = [...new Set(cases.map(c => c.kind))]
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '-')
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length ? s[Math.floor(s.length / 2)] : 0
  }
  const lines = ['| Judge | Right | Too low | Too high | No answer | Median ms |', '| --- | --- | --- | --- | --- | --- |']
  for (const j of judges) {
    const mine = answers.filter(a => a.judge === j)
    const g = mine.map(a => benchGrade(byId.get(a.id)!, a.effort))
    const n = (k: string) => g.filter(x => x === k).length
    const asked = mine.filter(a => a.ms > 0).map(a => a.ms)
    lines.push(`| ${j} | ${pct(n('hit'), g.length)} | ${n('under')} | ${n('over')} | ${n('none')} | ${asked.length ? median(asked) : '-'} |`)
  }
  const sets = [
    ['tuned on', cases.filter(c => !c.holdout)],
    ['held out', cases.filter(c => c.holdout)],
  ] as const
  lines.push('', `| Set (cases) | ${judges.join(' | ')} |`, `| --- | ${judges.map(() => '---').join(' | ')} |`)
  for (const [name, set] of sets) {
    if (!set.length) continue
    const ids = set.map(c => c.id)
    const cells = judges.map(j => {
      const mine = answers.filter(a => a.judge === j && ids.includes(a.id))
      return pct(mine.filter(a => benchGrade(byId.get(a.id)!, a.effort) === 'hit').length, mine.length)
    })
    lines.push(`| ${name} (${set.length}) | ${cells.join(' | ')} |`)
  }
  lines.push('', `| Kind (cases) | ${judges.join(' | ')} |`, `| --- | ${judges.map(() => '---').join(' | ')} |`)
  for (const k of kinds) {
    const ids = cases.filter(c => c.kind === k).map(c => c.id)
    const cells = judges.map(j => {
      const mine = answers.filter(a => a.judge === j && ids.includes(a.id))
      return pct(mine.filter(a => benchGrade(byId.get(a.id)!, a.effort) === 'hit').length, mine.length)
    })
    lines.push(`| ${k} (${ids.length}) | ${cells.join(' | ')} |`)
  }
  const misses = answers
    .filter(a => !a.judge.startsWith('always') && benchGrade(byId.get(a.id)!, a.effort) !== 'hit')
    .map(a => `- ${a.judge} ${a.id}: said ${a.effort ?? 'nothing'}${a.why ? ` (${a.why})` : ''}, wanted ${byId.get(a.id)!.ok.join('/')}: "${byId.get(a.id)!.message.slice(0, 60)}"`)
  return [...lines, '', 'Misses:', ...(misses.length ? misses : ['- none'])].join('\n')
}
