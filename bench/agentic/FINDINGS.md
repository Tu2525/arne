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
