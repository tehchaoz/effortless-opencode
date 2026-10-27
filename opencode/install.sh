#!/usr/bin/env bash
# Installs the effortless OpenCode port into ~/.config/opencode as symlinks to this folder (so edits here are live
# after an OpenCode restart). Uninstall: opencode/install.sh --uninstall
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
CFG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
links=("$CFG/plugins/effortless.ts:$HERE/effortless.ts" "$CFG/commands/effortless.md:$HERE/command/effortless.md" "$CFG/skills/effortless:$HERE/skill/effortless")
if [ "${1:-}" = "--uninstall" ]; then
  for l in "${links[@]}"; do t="${l%%:*}"; [ -L "$t" ] && rm "$t" && echo "removed $t"; done; exit 0
fi
for l in "${links[@]}"; do
  t="${l%%:*}"; s="${l#*:}"; mkdir -p "$(dirname "$t")"
  if [ -e "$t" ] && [ ! -L "$t" ]; then echo "refusing to replace $t (not a symlink)" >&2; exit 1; fi
  ln -sfn "$s" "$t"; echo "linked $t -> $s"
done
echo "Restart OpenCode. Try:  /effortless help"
