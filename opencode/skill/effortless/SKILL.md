---
name: effortless
description: How OpenCode's effortless plugin picks the reasoning effort for every prompt, and how to inspect or change it. Use when the user asks why a prompt ran at a given effort, wants to turn Auto on or off, tune the effort slider, Min/Max or save mode, see what Auto-steered prompts cost, or hand off / compact a heavy chat.
---

# effortless (OpenCode port)

effortless is an OpenCode plugin. It runs on every user message, so there is nothing to invoke for it to work. This
skill is for answering questions about it and for changing its settings. It is a port of HeyCubit/effortless
(MIT), the Claude Code mod of the same name, and it behaves the same way.

## What it does

1. **Picks the effort for every prompt.** A judge model reads the prompt and the end of the last reply and answers
   `low | medium | high | xhigh | max`. The effort is then sent with every request of that turn (`reasoningEffort` for
   gpt-oss and OpenAI models, `effort` for Claude).
2. **Short follow-ups keep it.** "ok", "go", "yes" (two words, twelve characters at most) keep the effort already
   picked, unless the last reply ended on a question: then the judge decides, since the answer may start a big job.
3. **A named level runs as said.** "max effort", "effort: low", "xhigh" skip the judge and win over Min/Max and save mode.
4. **The settings shape the verdict:** the slider (`bias`, -2 cheaper to 2 smarter, only tips calls the judge was
   unsure of), then `floor`/`ceiling`, then save mode (caps at medium).
5. **You always win.** Picking a variant yourself in OpenCode turns Auto off at your next message.
6. **Only on models that take an effort** (`effortModels`, default gpt-oss, OpenAI reasoning models, Claude
   Opus/Sonnet, Gemini thinking models). Others show "Paused" and run as OpenCode set them.
7. **Watches the chat.** Warns when the context passes `swampAt` percent, advises a handoff when a fresh chat would pay
   off (from 30% context), and counts what Auto-steered prompts cost.

## The command

`/effortless` with: `settings`, `set <name> <value>`, `auto [on|off]`, `save`, `stats`, `bench`, `debug`,
`handoff [full] [continue|confirm|copy]`, `compact [note]`, and `cold`, `swamp`, `down` to try an alert.

- Why did a prompt run at this effort? `/effortless debug` (last line: the model and effort the last request ran on)
  and `/effortless stats`.
- Change a setting: `/effortless set floor medium`, `/effortless set bias 1`, `/effortless set hide handoff,timer`.
  Settings live in `~/.config/effortless/opencode.json`.
- Handoff: *Quick* forks the chat and asks for a summary with a fixed prompt (seconds); *Full* runs a turn in the chat
  that checks git and rewrites HANDOFF.md, or runs the skill named in `handoffSkill`. Then a fresh chat starts with it
  (`continue`), starts and waits (`confirm`), or the chat stays and the handoff is copied (`copy`).
- Compact: summarised by the small model (`small_model` in opencode.json) unless `compactWith` is `session`.

## Where the judge runs

`judge: auto` uses the chat's own provider (or `small_model` when set) over plain OpenAI-compatible HTTP, or a
throwaway session on that provider's login when it is not OpenAI-compatible. `judge: custom` uses `judgeUrl` +
`judgeModel` (+ `judgeKeyEnv`, the name of an env var holding the key). If the judge fails or times out, the effort
stays as it was and a warning shows once.

State: `~/.local/state/effortless/opencode/` (`debug.log` records each decision).
