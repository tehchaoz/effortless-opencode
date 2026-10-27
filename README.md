# effortless for OpenCode and local models

A port of [HeyCubit/effortless](https://github.com/HeyCubit/effortless) (a Claude Code mod, MIT, v1.72.0) to
[OpenCode](https://opencode.ai). It decides **how hard the model should think** for every prompt, so a one-word
follow-up doesn't burn a deep-reasoning budget and a hard refactor doesn't get a lazy one.

It is a port, not a rewrite: the judge prompt, parsing, clamps, handoff and compact prompts follow the original, and
the pure logic is checked against the original's own recorded answers (see [Parity](#parity)).

## What it does

- **Auto effort.** A small judge model reads each prompt (and the end of the last reply) and answers
  `low / medium / high / xhigh / max`. The pick is applied to every request of that turn.
- **Follow-ups keep the effort.** "ok", "go", "yes" reuse the last pick without calling the judge.
- **Named levels win.** "use max effort" runs as said, no judge.
- **You always win.** Choosing a model variant yourself turns Auto off at your next message.
- **Shaping.** An effort slider (bias -2..2), Min/Max floor and ceiling, and *save mode* (caps at medium for 5 hours).
- **Context care.** Warns when a chat is swamped (default 70% of the window), advises a handoff when a fresh chat
  would pay off, writes Quick or Full handoffs, and compacts with the small model.
- **Stats.** What Auto-steered prompts cost (tokens weighted by price) and what the judge itself used, per chat,
  saved to disk so they survive restarts.
- **Judge benchmark.** `/effortless bench` scores any judge model on the original's 75 labelled prompts.

## Local models

The judge runs on **the chat's own provider and model** (or OpenCode's `small_model`), so a fully local setup
(llama.cpp, Ollama, LM Studio, vLLM behind an OpenAI-compatible URL) needs no extra service and no API key.
You can also point it at a different judge (`judge custom`, `judgeUrl`, `judgeModel`, `judgeKeyEnv`).

Measured on the original's 75 labelled prompts, with **Qwen3-Coder-Next (UD-Q4_K_M) as the judge** on llama.cpp:

| Judge | Right | Median latency |
| --- | --- | --- |
| always medium | 45% | n/a |
| always high | 52% | n/a |
| Qwen3-Coder-Next | **97%** (96% on the prompts the prompt was tuned on, 100% on 20 held out) | 1.2 s |

Full table and the two misses: [`parity/results/`](parity/results/). Your hardware and model will differ; run
`/effortless bench` to score yours.

**Honest limits for local models.**
- Effort is sent as `reasoningEffort` (OpenAI-compatible providers, gpt-oss, GPT-5/o-series, DeepSeek V4) or
  `effort` (Claude). A local model only *changes behaviour* if its chat template honours `reasoning_effort`
  (gpt-oss does; many others ignore it). For those the plugin is harmless but the effort has no effect, and the judge
  call is pure overhead, so turn Auto off there or keep them out of `effortModels`.
- By default only models matching `effortModels` are steered; others show "Paused". Add your local model's name to
  that regex to opt in (below).
- Gemini is recognised but not mapped yet, so nothing is sent for it. Anthropic/Google mappings are untested here.
- There is no prompt-cache countdown (local models have no cache); the timer is off (`cacheTtlMinutes 0`).
- The original's model switching and 5-hour/weekly limit features are not ported.
- OpenCode's plugin API has no status-bar slot, so you get toasts and `/effortless`, not an always-visible band.
  The plugin writes `status-<session>.json` for anything that wants to draw one.

## Install

Requires OpenCode 1.19+ and Node 22+ (only for the tests and bench).

```bash
git clone https://github.com/tehchaoz/effortless-opencode
cd effortless-opencode
bash opencode/install.sh        # symlinks plugin, command and skill into ~/.config/opencode
# restart OpenCode, then:
#   /effortless help
```

`bash opencode/install.sh --uninstall` removes the links. Nothing in your `opencode.json` is edited.
The plugin imports `@opencode-ai/plugin` types only, which OpenCode provides.

## Use

```
/effortless settings            show everything
/effortless set <name> <value>  change a setting (stored in ~/.config/effortless/opencode.json)
/effortless auto [on|off]       toggle Auto
/effortless save                save mode on/off
/effortless stats               what this chat's Auto-steered prompts cost
/effortless bench               score the judge on the 75 labelled prompts
/effortless handoff [full]      write a handoff and start a fresh chat with it
/effortless compact             summarize the chat with the small model
/effortless debug               what was sent on the last request, and the last judge answer
```

Opting a local model in, in `~/.config/effortless/opencode.json`:

```json
{ "effortModels": "gpt-oss|qwen3-coder-next", "judgeTimeoutMs": 30000 }
```

(`effortModels` is a regex matched against `provider/model`. Slow local judges need a longer `judgeTimeoutMs`;
the default is 8000.) Settings can also be passed as plugin options in `opencode.json`.

**Files.** Settings: `~/.config/effortless/opencode.json`. State: `~/.local/state/effortless/opencode/`
(`state.json` save mode, `session-<id>.json` per-chat stats, `status-<id>.json`, `debug.log`). Prompts are sent only
to the judge model you already use or configure; nothing goes to any other service.

## Parity

```bash
npm test          # 30 tests: the port's pure functions vs. the original's recorded outputs (parity/vectors.json)
npm run e2e       # 24 checks on a real `opencode serve` with a mock model, in a throwaway HOME
npm run bench -- --url http://127.0.0.1:8080/v1 --model <your-model>
```

`parity/extract-vectors.mjs` regenerates `vectors.json` from a checkout of the original
(`node --experimental-strip-types parity/extract-vectors.mjs <path-to>/hooks/register.tsx`).

## Gotchas learned building it

`opencode` is a Node launcher that spawns the real binary, so kill servers by port, not PID;
`command.execute.before` ignores a reassigned `output.parts`, mutate the array in place; `model.api.url` is empty for
providers declared in `opencode.json`, read `provider.options.baseURL`; `opencode run` wraps multi-word arguments in quotes.
An always-on MCP server with ~170 tools can alone overflow a 128k local context: disable heavy MCPs for local models.

## Credit and license

All the ideas, the judge design and the prompts come from **[HeyCubit/effortless](https://github.com/HeyCubit/effortless)**
(MIT). This repo keeps that copyright in [LICENSE](LICENSE) and [parity/ORIGINAL-LICENSE-MIT](parity/ORIGINAL-LICENSE-MIT).
Not affiliated with HeyCubit, OpenCode or Anthropic. MIT.
