#!/usr/bin/env bash
# Screens the hard tasks: one model, no mods, N reps per task. A run passes when test.mjs is untouched
# and `node --test` passes. Usage: MODEL=haiku bash bench/hard/run-hard.sh [reps] [tasks...]
# Results: $OUT/<model>.tsv (task, rep, pass, cost). Plain claude -p: no arne here, this only checks task difficulty.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODEL="${MODEL:-haiku}"; REPS="${1:-3}"; shift || true
TASKS=("$@"); [ ${#TASKS[@]} -gt 0 ] || TASKS=(dates)
OUT="${HARD_OUT:-${TEMP:-/tmp}/arnehard}"; mkdir -p "$OUT"
for t in "${TASKS[@]}"; do for r in $(seq 1 "$REPS"); do
  d="$OUT/w/$MODEL-$t-$r"; rm -rf "$d"; mkdir -p "$d"; cp "$HERE/$t/"* "$d/"
  sum=$(cat "$d/test.mjs" "$d/cases.mjs" 2>/dev/null | sha1sum | cut -d' ' -f1)
  P="Tests in this directory fail. Make node --test pass by fixing or implementing the code (not test.mjs). Run it to check."
  ( cd "$d" && timeout 600 claude -p "$P" --model "$MODEL" --effort medium --setting-sources project --strict-mcp-config \
      --no-session-persistence --permission-mode acceptEdits --output-format json \
      --allowedTools "Read Edit Write Grep Glob Bash(node:*) Bash(ls:*) Bash(cat:*) PowerShell(node:*) PowerShell(ls:*) PowerShell(cat:*)" < /dev/null > "$d/out.json" 2> "$d/err.txt" )
  ok=0; [ "$(cat "$d/test.mjs" "$d/cases.mjs" 2>/dev/null | sha1sum | cut -d' ' -f1)" = "$sum" ] && (cd "$d" && timeout 30 node --test >/dev/null 2>&1) && ok=1
  cost=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$d/out.json','utf8')).total_cost_usd??0)}catch{console.log(0)}")
  printf '%s\t%s\t%s\t%s\n' "$t" "$r" "$ok" "$cost" | tee -a "$OUT/$MODEL.tsv"
done; done
