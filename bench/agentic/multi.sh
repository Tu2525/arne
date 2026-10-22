#!/usr/bin/env bash
# One chat of five prompts on effortless's source (lookup, explanation, JSDoc edit, script, follow-up edit), run as
# opus (no mods), sonnet (no mods), and arne starting on opus. Same setup as run.sh, separate bench folder.
# Usage: bash bench/agentic/multi.sh [reps]   Then: node bench/agentic/score-multi.cjs
set -euo pipefail
ARNE="$(cd "$(dirname "$0")/../.." && pwd)"
EFFORTLESS="${EFFORTLESS_DIR:-$HOME/.claude/plugins/cache/effortless/effortless/1.71.0}"
REPS="${1:-3}"
export B="${ARNE_MULTI_DIR:-${TEMP:-/tmp}/arnemulti}"
mkdir -p "$B/r" "$B/w" "$B/pristine"
mkdir "$B/lock" 2>/dev/null || { echo "another run holds $B/lock" >&2; exit 1; }
trap 'rmdir "$B/lock"' EXIT
BM="$(cygpath -m "$B" 2>/dev/null || echo "$B")"
(cd "$EFFORTLESS" && tar --force-local -cf "$B/src.tar" --exclude=node_modules --exclude=.git --exclude=.in_use .)
[ -f "$B/pristine/hooks/register.tsx" ] || (cd "$B/pristine" && tar --force-local -xf ../src.tar)
rm -rf "$B/arne-plugin" && mkdir -p "$B/arne-plugin"
cp -r "$ARNE/.claude-plugin" "$ARNE/hooks" "$ARNE/types" "$B/arne-plugin/"
rm -f "$B/arne-plugin/hooks/"*.test.ts
sed -i -E "s#^const LOG_FILE = '[^']*'#const LOG_FILE = '$BM/arne-decisions.jsonl'#; s#^const SETTINGS_FILE = '[^']*'#const SETTINGS_FILE = '$BM/no-settings.json'#" "$B/arne-plugin/hooks/register.tsx"
sed -i "s#e.origin.kind === 'bridge'#e.origin.kind === 'bridge' || e.origin.kind === 'sdk'#" "$B/arne-plugin/hooks/register.tsx"
# Same arne with Sonnet as its cheapest model: it can only switch between Sonnet and Opus.
rm -rf "$B/arne-floor" && cp -r "$B/arne-plugin" "$B/arne-floor" && sed -i "s#modelFloor: 'haiku',#modelFloor: 'sonnet',#" "$B/arne-floor/hooks/register.tsx"
sed -i -E '/"modelFloor"/ s#"default": "haiku"#"default": "sonnet"#' "$B/arne-floor/.claude-plugin/plugin.json"
grep -q "modelFloor: 'sonnet'," "$B/arne-floor/hooks/register.tsx" && grep -q '"modelFloor".*"default": "sonnet"' "$B/arne-floor/.claude-plugin/plugin.json" || { echo "floor patch failed" >&2; exit 1; }
grep -q "origin.kind === 'sdk'" "$B/arne-plugin/hooks/register.tsx" && grep -q "$BM/arne-decisions.jsonl" "$B/arne-plugin/hooks/register.tsx" || { echo "arne patch failed" >&2; exit 1; }

cat > "$B/prompts.json" <<'JSON'
["Find where the threshold for showing the cold-cache band is defined and explain in three sentences how it is used. Do not change any files.",
 "Explain the full flow when a person presses the Update button in the update card, from the click until the new version runs in the chat. Name every function it goes through, in order, and say what each one does. Do not change any files.",
 "In hooks/theme.ts, add a one-line JSDoc comment above every exported function that does not have one. Change nothing else.",
 "Write tools/count-tests.mjs: it prints how many test(...) calls tests/effortless.test.ts contains. Run it with node and tell me the number.",
 "Add a one-line comment at the top of tools/count-tests.mjs saying what it does, then run it again and tell me the number."]
JSON

one() {
  local cond=$1 rep=$2 model flags=() tag="mt-$1-$2" dir="$B/w/mt-$1-$2"
  [ -s "$B/r/$tag.json" ] && { echo "$tag cached"; return 0; }
  rm -rf "$dir"; mkdir -p "$dir" && (cd "$dir" && tar --force-local -xf ../../src.tar)
  [ "$(find "$dir" -type f | wc -l)" -eq "$(find "$B/pristine" -type f | wc -l)" ] || { echo "$tag skipped: workspace not fresh"; return 0; }
  local pin=
  case $cond in opus) model=opus;; sonnet) model=sonnet;; arne) model=opus; flags=(--plugin-dir "$B/arne-plugin");;
    arnesonnet) model=opus; pin=sonnet; flags=(--plugin-dir "$B/arne-plugin");; arneopus) model=opus; pin=opus; flags=(--plugin-dir "$B/arne-plugin");;
    arnehaiku) model=opus; pin=haiku; flags=(--plugin-dir "$B/arne-plugin");; arnefloor) model=opus; flags=(--plugin-dir "$B/arne-floor");;
    effopus) model=opus; flags=(--plugin-dir "$EFFORTLESS");; effsonnet) model=sonnet; flags=(--plugin-dir "$EFFORTLESS");;
    # Rivals, from a checkout in RIVALS_DIR (git clone https://github.com/cfitzgerald-pd/effort-router).
    eropus) model=opus; flags=(--plugin-dir "$RIVALS_DIR/effort-router");; ersonnet) model=sonnet; flags=(--plugin-dir "$RIVALS_DIR/effort-router");; esac
  ( cd "$dir" && ARNE_PIN=$pin timeout 1800 node "$ARNE/bench/agentic/drive-multi.mjs" "$BM/prompts.json" --model "$model" --effort medium "${flags[@]}" --setting-sources project \
      --strict-mcp-config --no-session-persistence --permission-mode acceptEdits \
      --allowedTools "Read Edit Write Grep Glob Bash(node:*) Bash(ls:*) Bash(cat:*) PowerShell(node:*) PowerShell(ls:*) PowerShell(cat:*)" \
      < /dev/null > "$B/r/$tag.json" 2> "$B/r/$tag.err" ) || echo "$tag failed"
  echo "$tag done"
}
for rep in $(seq 1 "$REPS"); do for c in ${CONDS:-opus sonnet arne arnesonnet arneopus arnehaiku arnefloor effopus effsonnet}; do one "$c" "$rep"; done; done
echo "all runs done: node $ARNE/bench/agentic/score-multi.cjs"
