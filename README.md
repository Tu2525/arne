# arne

A Claude Code plugin that sends each prompt and each subagent run to the cheapest model and effort that can handle it (Haiku 5.5, Sonnet 5.5 or Opus 5.5). It manages the cache, compaction and model switches around that choice. Every choice shows in the band above the prompt and is logged with its cost to `~/.claude/arne/decisions.jsonl`, which stays on your machine. `/arne` overrides it.

arne replaces effortless by HeyCubit (MIT). Its cost ratios and the bench below come from effortless. Turn effortless off while arne is on.

## Bench vs effortless

effortless's own `bench/agentic` tasks (MIT): four real coding tasks on effortless's source. They find a threshold, add JSDoc to one file without touching code, write and run a test-counting script, and explain the update flow. The app was on Opus · medium every time, set up three ways:

- **no mods:** no plugin loaded
- **effortless:** effortless loaded
- **arne:** arne loaded, with its log and settings paths pointed into the bench folder so the real log is never touched

Each setup ran 2 times per task, one after another, through `claude -p --setting-sources project`, which keeps user plugins and hooks out. Run it again with `bash bench/agentic/run.sh 2`, then `node bench/agentic/score.cjs`.

| Setup | Runs | Correct | Correct, harness denials excluded | API-equivalent cost | Per task | Avg requests | Avg time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Opus medium, no mods | 8 | 8 | 8 | $1.71 | $0.214 | 7.4 | 30 s |
| effortless | 8 | 6 | 8 | $1.23 | $0.153 | 7.1 | 28 s |
| arne | 8 | 6 | 7 | $0.80 | $0.100 | 7.9 | 29 s |

arne costs 53% less per task than no mods and 35% less than effortless.

**About the cost.** The runs used a logged-in Claude plan. The costs are `total_cost_usd` from each run, which is the list-price equivalent, not what the plan was billed.

**Harness denials.** In 3 runs (effortless 2, arne 1), the session refused `node tools/count-tests.mjs` even though `Bash(node:*)` was allowed, so the agent wrote the script but couldn't run it. That's the bench harness, not the model.

**Where arne missed.** Step 17's pass condition is "correct on everything", and arne missed it on one run. arne sent the JSDoc task (t2) to Haiku · low in both reps, and Haiku skipped one export once. Raising the floor for multi-edit tasks, or tuning Laya on these rows, should close it.

**Fewer reps than planned.** PLAN.md asks for 3 runs per setup. This bench ran 2 to save plan limits.
