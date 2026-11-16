#!/usr/bin/env bash
# History bench: each task is a past arne commit that changed tests. The model gets the parent commit's source and
# the task's prompt (prompts/<sha>.md); when it finishes, the commit's own test files replace the workspace's and
# `claude plugin test` decides pass or fail. A task counts only where the parent fails those tests and the commit passes.
# Runs on the logged-in Claude plan; cost is total_cost_usd, the list-price equivalent.
# Usage: bash bench/agentic/history/run.sh MODEL [REP] [sha...]     e.g.  JOBS=3 bash bench/agentic/history/run.sh haiku
#        MODEL arne = the chat starts on Sonnet with arne loaded (a patched copy, as ../run.sh makes) and arne picks.
#        no sha = every row of tasks.tsv. Results: one line per run in $B/results.tsv (a finished run is not repeated).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ARNE="$(cd "$HERE/../../.." && pwd)"
MODEL="${1:?model: haiku, sonnet, opus or arne}"; REP="${2:-1}"; shift; shift 2>/dev/null || true
export B="${ARNE_BENCH_DIR:-${TEMP:-/tmp}/arnebench}/history"
mkdir -p "$B/w" "$B/r"; touch "$B/results.tsv"; rm -f "$B/stop"
# On Windows the model's shell is PowerShell: without these it cannot run the tests it is asked to pass.
export PS="PowerShell(claude plugin test:*) PowerShell(claude plugin validate:*) PowerShell(node:*) PowerShell(Select-Object:*) PowerShell(Select-String:*) PowerShell(Get-Content:*) PowerShell(Get-ChildItem:*) PowerShell(Where-Object:*) PowerShell(Out-String:*)"
if [ "$MODEL" = arne ]; then
  # arne under test: this tree's code, with its log and settings paths inside the bench folder (same patches as ../run.sh).
  BM="$(cygpath -m "$B" 2>/dev/null || echo "$B")"
  rm -rf "$B/arne-plugin" && mkdir -p "$B/arne-plugin" && cp -r "$ARNE/.claude-plugin" "$ARNE/hooks" "$ARNE/types" "$B/arne-plugin/"
  rm -f "$B/arne-plugin/hooks/"*.test.ts
  sed -i -E "s#^const LOG_DIR = '[^']*'#const LOG_DIR = '$BM/arne-log'#; s#^const LEGACY_LOG = '[^']*'#const LEGACY_LOG = '$BM/arne-decisions.jsonl'#; s#^const SETTINGS_FILE = '[^']*'#const SETTINGS_FILE = '$BM/no-settings.json'#; s#e.origin.kind === 'bridge'#e.origin.kind === 'bridge' || e.origin.kind === 'sdk'#" "$B/arne-plugin/hooks/register.tsx"
  [ "$(grep -cE "$BM/(arne-log|arne-decisions.jsonl|no-settings.json)'|origin.kind === 'sdk'" "$B/arne-plugin/hooks/register.tsx")" -ge 4 ] || { echo "arne patch failed" >&2; exit 1; }
fi
[ $# -gt 0 ] && TASKS="$*" || TASKS="$(tail -n +2 "$HERE/tasks.tsv" | cut -f1)"

one() {
  local sha=$1 tag="$MODEL-$1-$REP" dir="$B/w/$MODEL-$1-$REP"
  [ -e "$B/stop" ] && return 0
  grep -q "^$tag	" "$B/results.tsv" && { echo "$tag cached"; return 0; }
  [ -f "$HERE/prompts/$sha.md" ] || { echo "$tag skipped: no prompt"; return 0; }
  rm -rf "$dir"; mkdir -p "$dir"
  # cd, not tar -C: GNU tar reads a Windows path's drive letter as a remote host.
  git -C "$ARNE" archive "$sha^" | (cd "$dir" && tar -x --exclude=demo --exclude=bench)
  # An empty workspace would score the model on nothing: skip the run, rerun it later.
  [ -d "$dir/hooks" ] || { echo "$tag skipped: workspace not made"; return 0; }
  # arne needs the composer's path (drive.mjs): it drops the prompt, runs the real /model, and takes the re-sent one.
  local cmd=(claude -p "$(cat "$HERE/prompts/$sha.md")" --model "$MODEL" --output-format json)
  [ "$MODEL" = arne ] && cmd=(node "$ARNE/bench/agentic/drive.mjs" "$(cat "$HERE/prompts/$sha.md")" --model sonnet --plugin-dir "$B/arne-plugin")
  ( cd "$dir" && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 timeout 1800 "${cmd[@]}" --effort medium \
      --setting-sources project --strict-mcp-config --no-session-persistence --permission-mode acceptEdits \
      --allowedTools "Read Edit Write Grep Glob Bash(claude plugin test:*) Bash(claude plugin validate:*) Bash(node:*) Bash(ls:*) Bash(cat:*) Bash(grep:*) Bash(tail:*) Bash(head:*) $PS" \
      < /dev/null > "$B/r/$tag.json" 2> "$B/r/$tag.err" )
  local ran=$?
  # A run the plan's usage limit (or any API error) cut off says nothing about the model: record nothing, so it
  # reruns next time, and start no more runs.
  if grep -q '"terminal_reason":"api_error"' "$B/r/$tag.json"; then touch "$B/stop"; echo "$tag not counted: $(grep -oE "hit your [^\"]*" "$B/r/$tag.json" | head -1)"; return 0; fi
  # The commit's test files, every one of them: an edit the model made to a test does not count.
  git -C "$ARNE" archive "$sha" $(git -C "$ARNE" ls-tree -r --name-only "$sha" | grep -E '\.test\.tsx?$') | (cd "$dir" && tar -x)
  ( cd "$dir" && timeout 300 claude plugin test . ) > "$B/r/$tag.test" 2>&1
  local pass fail verdict
  pass=$(grep -oE '^ *[0-9]+ pass' "$B/r/$tag.test" | grep -oE '[0-9]+' | tail -1); fail=$(grep -oE '^ *[0-9]+ fail' "$B/r/$tag.test" | grep -oE '[0-9]+' | tail -1)
  [ "${fail:-x}" = 0 ] && [ "${pass:-0}" -gt 0 ] && verdict=pass || verdict=fail
  [ $ran -eq 0 ] || verdict="$verdict(run exit $ran)"
  node -e 'const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{};console.log([process.argv[2],process.argv[3],process.argv[4]||"?",process.argv[5]||"?",(j.total_cost_usd??0).toFixed(4),j.num_turns??"?",Math.round((j.duration_ms??0)/1000),Object.keys(j.modelUsage??{}).map(m=>m.replace(/^claude-|-\d.*$/g,"")).join("+")].join("\t"))' \
    "$B/r/$tag.json" "$tag" "$verdict" "$pass" "$fail" >> "$B/results.tsv"
  echo "$tag $verdict"
}
export -f one; export MODEL REP HERE ARNE
printf '%s\n' $TASKS | xargs -P "${JOBS:-3}" -I{} bash -c 'one {}'
echo "tag	verdict	pass	fail	cost	turns	seconds	models"; grep "^$MODEL-" "$B/results.tsv" | sort
echo "$MODEL: $(grep "^$MODEL-" "$B/results.tsv" | cut -f2 | grep -c '^pass$') passed of $(grep -c "^$MODEL-" "$B/results.tsv")"
[ -e "$B/stop" ] && echo "STOPPED EARLY: usage limit. Rerun the same command to finish the rest."
