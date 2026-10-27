#!/usr/bin/env bash
# End-to-end test of the OpenCode port against a mock OpenAI-compatible server. No GPU model needed, and the real
# ~/.config/opencode is never touched: everything runs under a throwaway HOME with a persistent `opencode serve`
# (so the plugin's per-process state survives from one prompt to the next, as it does in the TUI).
#
#   opencode/test/e2e.sh                       # judge decided by keyword inside the mock
#   MOCK_JUDGE_FORWARD=http://127.0.0.1:8080/v1 opencode/test/e2e.sh   # judge forwarded to a real local model
set -u
REAL_HOME="$HOME"
R="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d /tmp/effortless-e2e.XXXXXX)"
PORT_SERVE=14097; PORT_MOCK=18099
export HOME="$T/home"
mkdir -p "$HOME/.config/opencode/plugins" "$HOME/.config/opencode/commands" "$HOME/.cache" "$T/work"
ln -s "$R/opencode/effortless.ts" "$HOME/.config/opencode/plugins/effortless.ts"
cp "$R/opencode/command/effortless.md" "$HOME/.config/opencode/commands/effortless.md"
ln -s "$REAL_HOME/.cache/opencode" "$HOME/.cache/opencode"
cat > "$HOME/.config/opencode/opencode.json" <<JSON
{ "\$schema": "https://opencode.ai/config.json", "model": "mock/gpt-oss-mock", "small_model": "mock/plain-mock", "autoupdate": false, "share": "disabled",
  "provider": { "mock": { "npm": "@ai-sdk/openai-compatible", "name": "mock", "options": { "baseURL": "http://127.0.0.1:$PORT_MOCK/v1", "apiKey": "x" },
    "models": { "gpt-oss-mock": { "name": "gpt-oss-mock", "tool_call": true, "reasoning": true, "limit": { "context": 8000, "output": 1000 } },
                "plain-mock": { "name": "plain-mock", "tool_call": true, "limit": { "context": 8000, "output": 1000 } } } } } }
JSON
LOG="$T/mock.jsonl"; : > "$LOG"
# `opencode` is a Node launcher that spawns opencode.exe: killing the launcher orphans the server, so kill by port.
kill_port() { local pid; pid=$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$pid" ] && kill "$pid" 2>/dev/null; return 0; }
kill_port $PORT_SERVE; kill_port $PORT_MOCK; sleep 0.5
if ss -ltn | grep -qE ":($PORT_SERVE|$PORT_MOCK) "; then echo "ports $PORT_SERVE/$PORT_MOCK are busy; stop whatever holds them first" >&2; exit 2; fi
MOCK_PORT=$PORT_MOCK MOCK_LOG="$LOG" node "$R/opencode/test/mock-llm.mjs" > "$T/mock.out" 2>&1 &
MOCK_PID=$!
( cd "$T/work" && exec opencode serve --port $PORT_SERVE > "$T/serve.out" 2>&1 ) &
SERVE_PID=$!
trap 'kill $MOCK_PID $SERVE_PID 2>/dev/null; kill_port $PORT_SERVE; kill_port $PORT_MOCK' EXIT
# Wait until the server has bootstrapped the instance AND loaded the plugin: a prompt that races the bootstrap wedges.
for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT_SERVE/session?directory=$T/work" && break; sleep 0.5; done
for i in $(seq 1 60); do grep -q "loaded;" "$HOME/.local/state/effortless/opencode/debug.log" 2>/dev/null && break; sleep 0.5; done
sleep 3

pass=0; fail=0
check() { # name got want
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %s\n' "$1"; else fail=$((fail+1)); printf '  FAIL %s\n         got:  %s\n         want: %s\n' "$1" "$2" "$3"; fi
}
run() { ( cd "$T/work" && timeout 120 opencode run --attach "http://127.0.0.1:$PORT_SERVE" "$@" 2>&1 ); }
mark() { wc -l < "$LOG"; }
since() { tail -n +"$(( $1 + 1 ))" "$LOG"; }                     # mock lines after a mark
efforts() { since "$1" | jq -r 'select(.kind=="chat" and .model=="'"$2"'") | (.reasoning_effort // "none")' | tr '\n' ',' | sed 's/,$//'; }
judges() { since "$1" | jq -r 'select(.kind=="judge") | .kind' | wc -l | tr -d ' '; }
status() { jq -r "$1" "$HOME/.local/state/effortless/opencode/status-$SID.json" 2>/dev/null; }
has() { [ "$(said "$1" "$2")" -ge 1 ] && echo yes || echo no; }
said() { since "$1" | jq -r "select(.user|test(\"$2\")) | .kind" | wc -l | tr -d ' '; }   # requests whose text matches

echo "== 1. a big prompt is judged high and every request of the turn carries it"
m=$(mark); run -m mock/gpt-oss-mock "go through my whole repo and migrate everything from jest to vitest" > "$T/o1.txt"
check "one judge call"                     "$(judges $m)" "1"
check "chat request carries high"          "$(efforts $m gpt-oss-mock)" "high"
SID=$(basename "$(ls "$HOME"/.local/state/effortless/opencode/status-*.json | head -1)" .json | sed 's/^status-//')
check "found the main session"             "${SID:0:4}" "ses_"

echo "== 2. 'ok' is a follow-up: no judge, the effort is kept"
m=$(mark); run -s "$SID" -m mock/gpt-oss-mock "ok" > /dev/null
check "no judge call"                      "$(judges $m)" "0"
check "chat request still high"            "$(efforts $m gpt-oss-mock)" "high"

echo "== 3. a trivial question drops to low"
m=$(mark); run -s "$SID" -m mock/gpt-oss-mock "what does the -r flag do in cp?" > /dev/null
check "one judge call"                     "$(judges $m)" "1"
check "chat request carries low"           "$(efforts $m gpt-oss-mock)" "low"

echo "== 4. a named level runs without the judge (max is clamped to high for gpt-oss)"
m=$(mark); run -s "$SID" -m mock/gpt-oss-mock "use max effort for this one" > /dev/null
check "no judge call"                      "$(judges $m)" "0"
check "chat request carries high"          "$(efforts $m gpt-oss-mock)" "high"
check "status says named"                  "$(status .by)" "named"
check "status effort is max (not clamped)" "$(status .effort)" "max"

echo "== 5. a model that takes no effort is left alone (Paused)"
m=$(mark); run -m mock/plain-mock "migrate everything to vitest" > /dev/null
check "no judge call"                      "$(judges $m)" "0"
check "no reasoning_effort sent"           "$(efforts $m plain-mock | tr -d '\n' | sed 's/none,*//g')" ""

echo "== 6. /effortless stats answers without a judge call"
m=$(mark); run -s "$SID" -m mock/gpt-oss-mock --command effortless "stats" > /dev/null
check "the model was handed the stats"      "$(has $m 'Per prompt')" "yes"
check "no judge call"                      "$(judges $m)" "0"

echo "== 7. /effortless set floor medium: a low verdict is raised to medium"
run -s "$SID" -m mock/gpt-oss-mock --command effortless "set floor medium" > /dev/null
m=$(mark); run -s "$SID" -m mock/gpt-oss-mock "what does ls do?" > /dev/null
check "chat request carries medium"        "$(efforts $m gpt-oss-mock)" "medium"
run -s "$SID" -m mock/gpt-oss-mock --command effortless "set floor low" > /dev/null

echo "== 8. choosing a variant yourself turns Auto off; the next request is yours"
m=$(mark); run -s "$SID" -m mock/gpt-oss-mock --variant low "migrate the entire codebase" > /dev/null
check "no judge call (Auto went off)"      "$(judges $m)" "0"
check "Auto is off in the status file"     "$(status .auto)" "false"
run -s "$SID" -m mock/gpt-oss-mock --command effortless "auto on" > /dev/null
check "/effortless auto on turns it back"  "$(status .auto)" "true"

echo "== 9. save mode caps a high verdict at medium"
run -s "$SID" -m mock/gpt-oss-mock --command effortless "save" > /dev/null
m=$(mark); run -s "$SID" -m mock/gpt-oss-mock "migrate the whole monorepo to bun" > /dev/null
check "chat request carries medium"        "$(efforts $m gpt-oss-mock)" "medium"
run -s "$SID" -m mock/gpt-oss-mock --command effortless "save" > /dev/null

echo "== 10. /effortless handoff: a fork writes it, a fresh chat starts with it"
m=$(mark); run -s "$SID" -m mock/gpt-oss-mock --command effortless "handoff" > /dev/null; sleep 6
check "a fork was asked for the handoff"   "$(has $m 'Reply with the handoff only')" "yes"
check "a new chat got the handoff message" "$(has $m 'Handoff from the previous chat')" "yes"

echo "== 11. /effortless compact summarizes with the small model"
m=$(mark); run -s "$SID" -m mock/gpt-oss-mock --command effortless "compact" > /dev/null; sleep 5
check "small model got a summarize request" "$([ "$(since $m | jq -r 'select(.kind=="chat" and .model=="plain-mock" and (.user|test("summar|continu";"i"))) | .kind' | wc -l)" -ge 1 ] && echo yes || echo no)" "yes"

echo "== 12. handoff advice: from 30% context the judge may say a fresh chat would pay off"
run -s "$SID" -m mock/gpt-oss-mock "SWITCH TOPIC: write a poem about cats" > /dev/null
run -s "$SID" -m mock/gpt-oss-mock "SWITCH TOPIC: now plan a trip to Peru" > /dev/null; sleep 2
check "status carries the advice"          "$(status .advice)" "topic changed"

echo
echo "passed $pass, failed $fail   (logs in $T)"
[ "$fail" -eq 0 ]
