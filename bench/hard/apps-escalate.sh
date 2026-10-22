#!/usr/bin/env bash
# Failure escalation on an APPS task Haiku fails and Sonnet passes. Two prompts: write the solution, then "that did not work".
# Usage: [FAILS=n] ARNE_SRC=path/to/arne TASKS=D:/.../apps-tasks TASK=apps-2140 OUT=... bash bench/hard/apps-escalate.sh [reps]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$HERE/../agentic"
ARNE_SRC="${ARNE_SRC:?}"; TASKS="${TASKS:?}"; TASK="${TASK:-apps-2140}"; REPS="${1:-3}"
OUT="${OUT:-${TEMP:-/tmp}/arneappsesc}"; mkdir -p "$OUT/r" "$OUT/w"
OM="$(cygpath -m "$OUT" 2>/dev/null || echo "$OUT")"
mk() {
  rm -rf "$1" && mkdir -p "$1" && cp -r "$ARNE_SRC/.claude-plugin" "$ARNE_SRC/hooks" "$ARNE_SRC/types" "$1/" && rm -f "$1/hooks/"*.test.ts
  sed -i -E "s#^const LOG_FILE = '[^']*'#const LOG_FILE = '$OM/arne-decisions.jsonl'#; s#^const SETTINGS_FILE = '[^']*'#const SETTINGS_FILE = '$OM/no-settings.json'#" "$1/hooks/register.tsx"
  sed -i "s#e.origin.kind === 'bridge'#e.origin.kind === 'bridge' || e.origin.kind === 'sdk'#" "$1/hooks/register.tsx"
  grep -q "origin.kind === .sdk." "$1/hooks/register.tsx" || { echo "patch failed for $1" >&2; exit 1; }
}
mk "$OUT/arnesw"
# FAILS "that did not work" prompts follow the first (default 1); arne should retry 3 times on one model, then go up.
node -e 'const n=+process.argv[1];console.log(JSON.stringify(["Read problem.md. Write solution.mjs, a Node.js program that reads the input from stdin and prints the answer to stdout. Test it against the examples in the problem by running it with node before you finish.",...Array.from({length:n},(_,i)=>i?"Still wrong on some of the tests. Fix it.":"That did not work, the solution is wrong on some of the tests. Fix it.")]))' "${FAILS:-1}" > "$OUT/prompts.json"
for rep in $(seq 1 "$REPS"); do for c in ${CONDS:-haiku sonnet arnesw}; do
  tag="ae-$c-$rep"; d="$OUT/w/$tag"; [ -s "$OUT/r/$tag.json" ] && { echo "$tag cached"; continue; }
  rm -rf "$d"; mkdir -p "$d"; cp "$TASKS/$TASK/problem.md" "$d/"
  case $c in haiku) m=haiku; f=();; sonnet) m=sonnet; f=();; arnesw) m=haiku; f=(--plugin-dir "$OM/arnesw");;  esac
  ( cd "$d" && timeout 1500 node "$BENCH/drive-multi.mjs" "$OM/prompts.json" --model "$m" --effort medium "${f[@]}" --setting-sources project \
      --strict-mcp-config --no-session-persistence --permission-mode acceptEdits \
      --allowedTools "Read Edit Write Grep Glob Agent Task Bash(node:*) Bash(ls:*) Bash(cat:*) PowerShell(node:*) PowerShell(ls:*) PowerShell(cat:*)" \
      < /dev/null > "$OUT/r/$tag.json" 2> "$OUT/r/$tag.err" ) || echo "$tag failed"
  echo "$tag done"
done; done
OUT="$OUT" TESTS="$TASKS/$TASK/tests.json" node "$HERE/score-apps-escalate.cjs"
