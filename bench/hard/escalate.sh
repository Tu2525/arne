#!/usr/bin/env bash
# Failure escalation, two ways, on the dates task. A chat of two prompts: the first forbids the real fix (only holidays.mjs may
# change, so the tests cannot pass), the second says it did not work. Conditions (all start the chat on Haiku):
#   haiku, sonnet, opus : no mods
#   arnesw  : arne, a failed attempt moves the chat up a tier (escalateVia switch)
#   arnesub : arne, a failed attempt leaves the chat on Haiku and hands the retry to a subagent one tier up (escalateVia subagent)
# Usage: ARNE_SRC=path/to/arne bash bench/hard/escalate.sh [reps]    Results and scores land in $OUT (default $TEMP/arneesc).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$HERE/../agentic"
ARNE_SRC="${ARNE_SRC:?set ARNE_SRC to the arne checkout under test}"; REPS="${1:-3}"
OUT="${OUT:-${TEMP:-/tmp}/arneesc}"; mkdir -p "$OUT/r" "$OUT/w"
OM="$(cygpath -m "$OUT" 2>/dev/null || echo "$OUT")"
mk() { # mk <dir> <escalateVia>
  rm -rf "$1" && mkdir -p "$1" && cp -r "$ARNE_SRC/.claude-plugin" "$ARNE_SRC/hooks" "$ARNE_SRC/types" "$1/" && rm -f "$1/hooks/"*.test.ts
  sed -i -E "s#^const LOG_FILE = '[^']*'#const LOG_FILE = '$OM/arne-decisions.jsonl'#; s#^const SETTINGS_FILE = '[^']*'#const SETTINGS_FILE = '$OM/no-settings.json'#" "$1/hooks/register.tsx"
  sed -i "s#e.origin.kind === 'bridge'#e.origin.kind === 'bridge' || e.origin.kind === 'sdk'#" "$1/hooks/register.tsx"
  sed -i -E "/\"escalateVia\"/ s#\"default\": \"[a-z]*\"#\"default\": \"$2\"#" "$1/.claude-plugin/plugin.json"
  grep -q "origin.kind === 'sdk'" "$1/hooks/register.tsx" && grep -q "\"default\": \"$2\"" <(grep escalateVia "$1/.claude-plugin/plugin.json") || { echo "patch failed for $1" >&2; exit 1; }
}
mk "$OUT/arnesw" switch; mk "$OUT/arnesub" subagent
cat > "$OUT/prompts.json" <<'JSON'
["The tests in this directory fail (node --test). Make them pass, but you may only edit holidays.mjs: do not touch any other file.",
 "That did not work, the tests still fail. You may edit any file now. Fix it properly."]
JSON
for rep in $(seq 1 "$REPS"); do for c in ${CONDS:-haiku sonnet opus arnesw arnesub}; do
  tag="esc-$c-$rep"; d="$OUT/w/$tag"; [ -s "$OUT/r/$tag.json" ] && { echo "$tag cached"; continue; }
  rm -rf "$d"; mkdir -p "$d"; cp "$HERE/dates/"* "$d/"
  case $c in haiku) m=haiku; f=();; sonnet) m=sonnet; f=();; opus) m=opus; f=();; arnesw) m=haiku; f=(--plugin-dir "$OM/arnesw");; arnesub) m=haiku; f=(--plugin-dir "$OM/arnesub");; esac
  ( cd "$d" && timeout 1200 node "$BENCH/drive-multi.mjs" "$OM/prompts.json" --model "$m" --effort medium "${f[@]}" --setting-sources project \
      --strict-mcp-config --no-session-persistence --permission-mode acceptEdits \
      --allowedTools "Read Edit Write Grep Glob Agent Task Bash(node:*) Bash(ls:*) Bash(cat:*) PowerShell(node:*) PowerShell(ls:*) PowerShell(cat:*)" \
      < /dev/null > "$OUT/r/$tag.json" 2> "$OUT/r/$tag.err" ) || echo "$tag failed"
  echo "$tag done"
done; done
OUT="$OUT" node "$HERE/score-escalate.cjs"
