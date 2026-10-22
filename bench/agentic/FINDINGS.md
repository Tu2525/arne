# arne bench: findings and method

Run on 2026-10-21, logged-in Claude plan. Costs are the session's `total_cost_usd` (list-price equivalent), plus arne's Haiku judge at about $0.00047 per prompt it routes.

## How we bench

| What | How |
| --- | --- |
| Task repo | effortless's own source (v1.71.0), copied fresh into a new folder for every run. The tasks and checks know its files. |
| Driving Claude | `claude -p` with stream-json input (`drive.mjs`, `drive-multi.mjs`). Plain `claude -p` sends origin `sdk`, which arne ignores, so the bench's copy of arne also accepts `sdk`. The shipped hook is unchanged. |
| Model switching | Real `/model` switches, made by arne inside the session, the same way it works in the app. |
| Pins | The driver sends `/arne pin <model> medium` before the first prompt. |
| "Sonnet or Opus only" | A bench copy of arne whose cheapest model is Sonnet, set in both `register.tsx` and `plugin.json` (the manifest default wins over the code default). |
| Scoring | Each answer is checked by script, not by a model: text checks for the lookup and explanation prompts, unchanged code and full JSDoc coverage for the edit, and running the written script and comparing its count. |
| Reported | Pass rate (95% interval on the single-prompt bench), cost per task or chat, cost per correct answer, time. |

### The tests

| Task | Prompt | Passes when |
| --- | --- | --- |
| Lookup (t1, p1) | Find where the threshold for showing the cold-cache band is defined and explain in three sentences how it is used. Do not change any files. | The answer names `COLD_MIN_TOKENS` or the 150,000 value. |
| Explain (t4, p2) | Explain the full flow when a person presses the Update button in the update card, from the click until the new version runs in the chat. Name every function it goes through, in order, and say what each one does. Do not change any files. | The answer names `runUpdate`, `syncRunningCopy`/`syncPlan`, and the plugin reload. |
| JSDoc edit (t2, p3) | In hooks/theme.ts, add a one-line JSDoc comment above every exported function that does not have one. Change nothing else. | Every export has a doc comment and the code lines are unchanged. |
| Script (t3, p4) | Write tools/count-tests.mjs: it prints how many test(...) calls tests/effortless.test.ts contains. Run it with node and tell me the number. | Running the script prints 198 and the answer says 198. |
| Script follow-up (p5, multi only) | Add a one-line comment at the top of tools/count-tests.mjs saying what it does, then run it again and tell me the number. | The script's first line is a comment and it still prints 198. |

Any change to a file the task did not ask for fails the run.

**Single-prompt bench** (`run.sh`, `score.cjs`): 4 tasks × 5 reps, each a fresh session.
**Multi-prompt bench** (`multi.sh`, `score-multi.cjs`): one chat of 5 prompts in order (lookup, explanation, JSDoc edit, write a count script, edit that script), so context grows and arne can switch between prompts. 3 chats per setup. Results in `D:/arne-bench/multi`.

## Multi-prompt results (3 chats × 5 prompts)

| Setup | Prompts right | Chats fully right | Cost per chat | Cost per right prompt | Models used |
| --- | --- | --- | --- | --- | --- |
| Opus medium, no mods | 15/15 | 3/3 | $0.599 | $0.120 | Opus |
| Sonnet medium, no mods | 15/15 | 3/3 | $0.267 | $0.053 | Sonnet |
| effortless on Opus | 15/15 | 3/3 | $0.524 | $0.105 | Opus |
| effortless on Sonnet | 7/15 | 0/3 | $0.274 | $0.118 | Sonnet |
| effort-router on Opus | 15/15 | 3/3 | $0.616 | $0.123 | Opus |
| effort-router on Sonnet | 12/15 | 2/3 | $0.332 | $0.083 | Sonnet |
| **arne, unpinned (starts on Opus)** | 13/15 | 2/3 | **$0.021** | **$0.005** | Haiku on every prompt |
| arne pinned Haiku | 15/15 | 3/3 | $0.017 | $0.003 | Haiku |
| arne pinned Sonnet | 14/15 | 2/3 | $0.261 | $0.056 | Sonnet |
| arne pinned Opus | 15/15 | 3/3 | $0.578 | $0.116 | Opus |
| arne, Sonnet or Opus only | 9/15 | 1/3 | $0.221 | $0.074 | Sonnet on every prompt |

## Single-prompt results (4 tasks × 5 reps)

| Model | Setup | Correct | Pass rate (95% CI) | Cost per task | Cost per correct run |
| --- | --- | --- | --- | --- | --- |
| Haiku | no mods | 20/20 | 100% (84–100) | $0.008 | $0.008 |
| Haiku | effortless | 20/20 | 100% (84–100) | $0.007 | $0.007 |
| Sonnet | no mods | 16/20 | 80% (58–92) | $0.089 | $0.112 |
| Sonnet | effortless | 14/20 | 70% (48–85) | $0.098 | $0.140 |
| Opus | no mods | 19/20 | 95% (76–99) | $0.228 | $0.240 |
| Opus | effortless | 19/19 | 100% (83–100) | $0.216 | $0.216 |
| Opus | **arne** | 19/20 | 95% (76–99) | **$0.047** | **$0.049** |

## Findings

1. **arne cuts cost by 80–96% at the same quality on these tasks.** Single prompt: $0.047 vs $0.228 per task on Opus. Multi-prompt: $0.021 vs $0.599 per chat.
2. **Unpinned, arne sent everything to Haiku, and Haiku was right.** Pinned Haiku went 15/15. The judge cost is about $0.004 per chat on top.
3. **effortless barely moves cost.** On Opus it was 5–13% cheaper at the same quality. On Sonnet it cost slightly more and was less accurate (multi-prompt: 7/15 against 15/15 with no mods, missing the JSDoc edit twice and the count every chat).
4. **Pins work and add no cost.** Pinned Sonnet or Opus costs what that model costs with no mods.
5. **Most "misses" are a test ambiguity, not a model error.** The count task's truth is 198, but `tests/effortless.test.ts:2400` has a regex `.test(t)` call, and counting it gives 199. Every model that said 199 hit this. Fix the prompt or accept both before trusting the pass rates.
6. **These tasks are too easy to test routing.** Haiku passes all of them, so a router that always picks Haiku looks perfect. To show arne picks a bigger model when it should, the bench needs prompts Haiku fails.

## Caveats

- 3 chats per multi-prompt setup and 5 reps per single-prompt task: the intervals are wide.
- The "Sonnet or Opus only" setup never chose Opus, so it measures Sonnet with arne loaded, not switching. Its misses (JSDoc twice, the count twice) are more than Sonnet with no mods got; with 3 chats, that may be noise.
- One single-prompt Opus run (`ab3-opus-t3-m-2`) is marked failed though its script printed 198; not yet checked.

## Rerunning the bench

You need Claude Code logged in, Node 22+, bash (Git Bash on Windows), and effortless installed, since its source is the task repo (`EFFORTLESS_DIR` points elsewhere). Each run uses about 20 MB of workspace; put it on a disk with room.

```bash
# Single-prompt bench: 4 tasks × REPS, on one model. Setups: m (no mods), on (effortless), arne.
bash bench/agentic/run.sh 5
node bench/agentic/score.cjs

# Multi-prompt bench: one 5-prompt chat per run, REPS chats per setup.
ARNE_MULTI_DIR=D:/arne-bench/multi bash bench/agentic/multi.sh 3
ARNE_MULTI_DIR=D:/arne-bench/multi node bench/agentic/score-multi.cjs
```

- `CONDS` picks setups, e.g. `CONDS="arne arnehaiku"`. Multi-prompt setups: `opus`, `sonnet`, `arne`, `arnesonnet`, `arneopus`, `arnehaiku`, `arnefloor`, `effopus`, `effsonnet`.
- Finished runs are cached by result file; delete `r/<tag>.json` to rerun one.
- One run at a time per folder (a `lock` folder guards it). Do not edit `multi.sh` while it runs: bash reads the script as it goes.
- The scorer reads the folder from `ARNE_MULTI_DIR`, not from an argument.
- When effortless or arne changes, rerun everything: cached results from an older version are not comparable.

## How to improve the bench

1. **Fix the count task.** Say whether regex `.test(` calls count, or accept 198 and 199. Today it fails right answers.
2. **Add tasks Haiku fails.** Every task here is easy enough for Haiku, so routing is never tested. Add multi-file refactors, bugs that need reading several files, or tasks with a hidden test to pass.
3. **More reps.** 3 chats per setup cannot separate 13/15 from 15/15. Aim for 10 or more before calling a gap real.
4. **More than one repo.** All tasks use effortless's source. Add a second codebase so the results do not lean on one project.
5. **Longer chats.** Five prompts rarely grow context enough to test cache-aware switching or compaction. Add a 15–20 prompt chat.
6. **Check the odd failure.** `ab3-opus-t3-m-2` failed with a correct script; find out why before the next run.

## Send us your data: open an issue

These results come from one machine, one repo and a few runs. More data is what makes them trustworthy, so if you run the bench or use arne day to day, please share your numbers in an issue at https://github.com/Tu2525/arne/issues/new?template=bench-results.md. Any of these helps:

- **Bench results.** Run either bench (see *Rerunning the bench*) and paste the score table, plus `scored.json` (multi-prompt) or the `r/` folder zipped.
- **Real usage.** Run `/arne stats` after a week or more of normal work and paste what it prints: what you spent, and what the same turns would have cost on Opus.
- **Where it went wrong.** A prompt arne sent to a model that was too small (or too big), with the model it picked and what you expected. `/arne why` shows the reason for the last pick.
- **New tasks.** A prompt, and how to check the answer by script.

Please include your OS, arne's commit, effortless's version, Claude Code's version, and your plan (Pro, Max, API). Leave out anything private: prompts and paths from your own projects are not needed.
