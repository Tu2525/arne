#!/usr/bin/env bash
# Adapted from effortless bench/agentic/run.sh (MIT, see ../LICENSE.effortless).
# Opus on real coding tasks, three setups, run one after another on the logged-in Claude plan:
#   m    = app at medium, no mods loaded
#   on   = app at medium, effortless loaded
#   arne = app at medium, arne loaded (a patched copy: its log and settings paths point into the bench folder)
# --setting-sources project keeps your user plugins and hooks out, so each setup is only what it says.
# Cost in the results is total_cost_usd: the list-price equivalent, not what the plan was billed.
# Usage: bash bench/agentic/run.sh [reps] [only-task]   e.g. bash bench/agentic/run.sh 2
# Then:  node bench/agentic/score.cjs
set -euo pipefail
ARNE="$(cd "$(dirname "$0")/../.." && pwd)"
EFFORTLESS="${EFFORTLESS_DIR:-$HOME/.claude/plugins/cache/effortless/effortless/1.71.0}"
REPS="${1:-2}"; ONLY="${2:-}"
export B="${ARNE_BENCH_DIR:-${TEMP:-/tmp}/arnebench}"
mkdir -p "$B/r" "$B/w" "$B/pristine" "$B/arne-plugin"
# Two runners at once wipe each other's workspaces (it happened once): one at a time.
mkdir "$B/lock" 2>/dev/null || { echo "another bench run holds $B/lock; remove it if none is running" >&2; exit 1; }
trap 'rmdir "$B/lock"' EXIT
BM="$(cygpath -m "$B" 2>/dev/null || echo "$B")"

# The task repo is effortless's own source: the tasks and the scorer know its files.
(cd "$EFFORTLESS" && tar --force-local -cf "$B/src.tar" --exclude=node_modules --exclude=.git .)
[ -f "$B/pristine/hooks/register.tsx" ] || (cd "$B/pristine" && tar --force-local -xf ../src.tar)

# arne under test: same code, but it may not touch the real decision log, and it must not see effortless as enabled.
rm -rf "$B/arne-plugin" && mkdir -p "$B/arne-plugin"
cp -r "$ARNE/.claude-plugin" "$ARNE/hooks" "$ARNE/types" "$B/arne-plugin/"
rm -f "$B/arne-plugin/hooks/"*.test.ts
sed -i -E "s#^const LOG_FILE = '[^']*'#const LOG_FILE = '$BM/arne-decisions.jsonl'#; s#^const SETTINGS_FILE = '[^']*'#const SETTINGS_FILE = '$BM/no-settings.json'#" "$B/arne-plugin/hooks/register.tsx"
grep -q "$BM/arne-decisions.jsonl" "$B/arne-plugin/hooks/register.tsx" || { echo "arne log path patch failed" >&2; exit 1; }
grep -q "$BM/no-settings.json" "$B/arne-plugin/hooks/register.tsx" || { echo "arne settings path patch failed" >&2; exit 1; }

one() {
  local id=$1 cond=$2 rep=$3 P PL=()
  local tag="ab3-opus-$id-$cond-$rep" dir="$B/w/ab3-opus-$id-$cond-$rep"
  [ -f "$B/r/$tag.json" ] && [ -s "$B/r/$tag.json" ] && { echo "$tag cached"; return 0; }
  rm -rf "$dir"; mkdir -p "$dir" && (cd "$dir" && tar --force-local -xf ../../src.tar)
  # A workspace that could not be reset would score the wrong files: skip the run, rerun it later.
  [ -f "$dir/hooks/register.tsx" ] && [ "$(find "$dir" -type f | wc -l)" -eq "$(find "$B/pristine" -type f | wc -l)" ] \
    || { echo "$tag skipped: workspace not fresh"; rm -f "$B/r/$tag.json"; return 0; }
  case $id in
    t1) P="Find where the threshold for showing the cold-cache band is defined and explain in three sentences how it is used. Do not change any files.";;
    t2) P="In hooks/theme.ts, add a one-line JSDoc comment above every exported function that does not have one. Change nothing else.";;
    t3) P="Write tools/count-tests.mjs: it prints how many test(...) calls tests/effortless.test.ts contains. Run it with node and tell me the number.";;
    t4) P="Explain the full flow when a person presses the Update button in the update card, from the click until the new version runs in the chat. Name every function it goes through, in order, and say what each one does. Do not change any files.";;
  esac
  case $cond in
    on) PL=(--plugin-dir "$EFFORTLESS");;
    arne) PL=(--plugin-dir "$B/arne-plugin");;
  esac
  (
    export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 EFFORTLESS_LOG="$B/r/$tag.proof.log"
    cd "$dir" && timeout 900 claude -p "$P" --model opus --effort medium "${PL[@]}" --setting-sources project \
      --disable-slash-commands --strict-mcp-config --no-session-persistence \
      --permission-mode acceptEdits --allowedTools "Read Edit Write Grep Glob Bash(node:*) Bash(ls:*) Bash(cat:*)" \
      --output-format json < /dev/null > "$B/r/$tag.json" 2> "$B/r/$tag.err"
  ) || echo "$tag failed"
  echo "$tag done"
}

for rep in $(seq 1 "$REPS"); do for t in t1 t2 t3 t4; do for c in m on arne; do
  [ -z "$ONLY" ] || [ "$ONLY" = "$t" ] || continue
  one "$t" "$c" "$rep"
done; done; done
echo "all runs done: node $ARNE/bench/agentic/score.cjs"
