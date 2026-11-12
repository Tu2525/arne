# arne audit

Audited 2026-11-10 at `50349e8` (branch `failure-escalation`, 0.4.3). Covers the code in `hooks/`, the bench in `bench/`, `README.md`, `PLAN.md` and `arne-handoff.md`.

What was run:

- `claude plugin test`: 90 pass, 0 fail.
- `claude plugin validate .`: **fails** with 4 errors (item 2).
- A throwaway test for the Opus hold: fails (item 1). It was deleted afterwards.
- `bench/router/real-savings.mjs` on the local `decisions.jsonl` (item 3).

Nothing in the repo was changed except adding this file.

## The short version

1. The engineering is careful. The claims are ahead of the evidence.
2. The bench does not show that routing works. It shows that Haiku is cheap. Pinning Haiku beat arne on both cost and pass rate in arne's own results.
3. Real usage shows about 45% saved against all-Opus, not the 80–96% in FINDINGS or the 53% in the README, and that 45% is itself overstated.
4. There is one confirmed logic bug (the hold after an escalation to Opus), one release blocker (validation), and a retry detector that fires on ordinary sentences.
5. `PLAN.md` spends its effort on the cheapest part of the system (the judge call) before fixing the thing that blocks every conclusion (no tasks that Haiku fails).

## Fix first

### 1. The hold after an escalation to Opus does not hold (confirmed bug)

`hooks/register.tsx:656-657`. After a failed attempt on Sonnet, arne moves to Opus. The next prompt is meant to stay on Opus for `HOLD_TURNS = 2`. It doesn't: the hold raises the tier to L, then `clampTier` cuts it back to `modelCeiling` (Sonnet by default), because only `source === 'escalate'` is allowed past the ceiling.

Probe: start on Sonnet, send a task, send "still wrong, try again", then send a new task. Commands run: `/model claude-opus-5-5`, then `/model claude-sonnet-5-5`. So the person pays an Opus cache write, then a Sonnet one, and lands back on the model that failed.

The existing test (`register.test.ts:1062`) only covers Haiku → Sonnet, which is under the ceiling, so it passes.

Fix: let a held tier pass the ceiling too.

```ts
const held = hold && hold.left-- > 0 && RANK[r.tier] < RANK[hold.tier]
if (held) r = { ...r, tier: hold!.tier, reason: `${r.reason}; held after a failure` }
const top = r.source === 'escalate' || held ? 'L' : live.modelCeiling
```

The continuation path has the same problem: "ok continue" after an escalation returns `prev` with source `prev`, and is clamped to Sonnet. Carry a flag on the decision (for example `above: true`) rather than reading `source`. Add the Sonnet → Opus case to the test.

### 2. `claude plugin validate` fails

`types/index.d.ts:21` uses `import('../hooks/route')` and `import('../hooks/stats')`. The validator requires the types contract to be self-contained. This is the check a marketplace install runs against, so treat it as a release blocker until proven otherwise.

Fix: inline the three types (`Decision`, `Tier`, `Summary`) into `types/index.d.ts`. While there, add `capped` to the `subCount` type; the code writes it (`register.tsx:90`) but the contract doesn't list it.

Two warnings from the same run: no marketplace description, no `author` in `plugin.json`.

### 3. The savings claims do not match each other or the data

| Source | Claim |
| --- | --- |
| README line 7 | 53% less per task than Opus, 35% less than effortless |
| README line 94 | $0.047 vs $0.228 per task (79% less) |
| FINDINGS finding 1 | 80–96% less |
| Local `decisions.jsonl`, 1,018 turns over 3 weeks | 45% less than all-Opus ($351.51 vs $640.41) |
| Local backup log, 189 turns | 11% less |

Problems:

- The README headline (53%) is from the first run: 2 reps per setup, arne 6/8 correct against Opus 8/8. It is quoted with no mention of the lower pass rate.
- All bench numbers predate 0.4.x. Since then the ceiling became Sonnet, escalation was added and `attempts` changed. FINDINGS itself says to rerun everything when arne changes.
- In the multi-prompt bench, arne unpinned scored 13/15 at $0.021. Pinned Haiku scored 15/15 at $0.017. On this bench, the router is worse than no router.
- FINDINGS already says the tasks are too easy to test routing (finding 6). The README does not carry that caveat.

Fix: replace the README headline with the real-usage number and its caveats, link FINDINGS for the bench, and put "Haiku passes every task, so this bench cannot show that arne picks a bigger model when it should" next to any bench figure.

### 4. Stats overstates what arne saved

`hooks/stats.ts`, `summarize`:

- **The Haiku judge is not counted.** Only Jev's calls are logged (`register.tsx:614`). The Haiku judge runs on every new task with up to 8,000 characters of task card plus 2,500 of README or CLAUDE.md (`register.tsx:556`, `:545`, `:586`). That is roughly 3k input tokens a call, several times the $0.00047 measured in `bench/router` on bare prompts. The bench scorers also add the flat $0.00047.
- **The baseline is always Opus.** A person who would have used Sonnet anyway sees savings they never had. With the default ceiling now at Sonnet, this is most people.
- **Subagents are priced as Opus in the baseline** (`opus += priceOn(r, 'L')` for `agent` rows). Explore runs on Haiku without arne. Subagents are 17% of local spend ($59 of $351), so this moves the number.
- **Prices are hardcoded ratios** taken from effortless: Haiku 1/3, Sonnet 1, Opus 2, Sonnet input at $3 per million (`econ.ts:5`, `:64`). I could not confirm these against current Claude 5.5 list prices. Check them; every dollar figure in the band, the alerts and Stats depends on them.

Fix:

1. Log a `judge` usage row from `r.usage` in the Haiku backend, and count it under "Switches and summaries" (or its own line).
2. Record the session's starting model and use it as the baseline. Keep "against Opus" as a second figure.
3. Price `agent` rows in the baseline at the model they would have run on (the row already has `from`).
4. Put the prices in one table with a date and a source link.

### 5. The retry detector fires on ordinary prompts

`RETRY` in `hooks/route.ts:46` matches "still not \w+", "not working", "that's wrong". Checked:

- "I am still not sure about the naming" → counted as a failed attempt.
- "explain why login is not working in prod" → counted as a failed attempt.
- "that's wrong on purpose, keep it" → counted as a failed attempt.

With `attempts: 1` (the default), one match moves the chat one tier up, and an escalation switches even on a warm cache (`register.tsx:673`). On a 150k chat that is a full cache write on the dearer model. Then item 1 sends it back down.

Fix, cheapest first:

1. Only treat a `RETRY` match as a failure when the prompt is short (it already has `FOLLOW_MAX = 80` for the same idea) and the previous turn used an edit tool or ran a command.
2. Drop `not working` and `still not \w+` from the regex; keep the phrases that only make sense as a complaint ("try again", "same error", "didn't work").
3. Log each escalation with the text that triggered it, then tune from the log.

## Fix next

### 6. The log: lost rows, unbounded growth, plaintext prompts

`appendLog` (`register.tsx:728`) and `feedback` (`:476`) read the whole file and write it back. Consequences:

- Two chats open at once can each overwrite the other's rows. Stats then undercounts. No test covers this.
- Each turn rewrites the file two or three times. The local log is 795 KB after three weeks.
- Every prompt is stored in full, in plaintext, forever (`text: e.text`, `:1339`), with no switch to turn it off and no rotation. Pasted secrets end up there.

Fix: one file per session or per day (`decisions-2026-11-10.jsonl`), which removes most contention and bounds the rewrite. Truncate stored prompt text (the judge only reads 4,000 characters anyway) and add a `logPrompts` option. Say in the README that prompts are stored locally in plaintext.

### 7. The privacy text for Jev is narrower than what is sent

The README, `plugin.json` and the Settings note say "your prompts leave this machine". The request also carries the task card: the first prompt, the last ten messages and the paths of files touched (`register.tsx:596`, `taskCard`). The `/arne backend jev` reply says this correctly. Make the other three match it.

### 8. Words in the UI and README that the code does not back

| Where | Says | Actually |
| --- | --- | --- |
| README, Subagents | "off by default" | Default is `sonnet` (on, capped) in `plugin.json` and `DEFAULTS` |
| README line 15 | "a design question goes to Opus · high" | The judge stops at Sonnet; Opus only after a failed attempt |
| README, Judges | `heuristic`: "locally, with no model call" | `backendsOf` returns no backend. It is "keep the last tier, else Sonnet medium". Call it that |
| Settings note (`register.tsx:834`) | "Laya runs on this machine and learns from your ratings" | Shown for every judge except Jev, including Haiku. Nothing trains from ratings yet |
| Panel (`:1712`) | "Saved for Laya's training." | Same: no training exists |
| README, Screenshots | "Screenshots" | Rendered from an HTML mock (`frame.html`, per `arne-handoff.md`), which is not in the repo |
| README `/arne` list | no `debug`, `show` | Both exist |

### 9. No CI, and the type check cannot run from a clone

- No workflow runs `claude plugin test` or `claude plugin validate`. Item 2 would have been caught.
- `tsconfig.json` is git-ignored and extends `.claude-plugin/types/`, which is not tracked. `node_modules` is empty. A fresh clone cannot type-check.
- Nearly every function takes `$: any`, so the types that exist check little.

Fix: a GitHub Action that runs test and validate. Commit `tsconfig.json`, or document how to generate it.

### 10. The bench tests a patched copy

`run.sh` and `multi.sh` copy the plugin and `sed` it to accept origin `sdk` and to move the log path. FINDINGS says so, which is good. It still means the shipped file is never the one benchmarked, and a `sed` that stops matching would fail quietly if the grep check drifts.

Fix: read both from the environment in the shipped code (for example `ARNE_LOG_FILE`, `ARNE_ACCEPT_SDK`), and run the bench on the real file.

Also open from FINDINGS and still not done: the count task fails right answers (199), and `ab3-opus-t3-m-2` was never checked.

## Smaller things

- `register.tsx` is 1,831 lines and the `AbovePrompt` render is about 430 of them. Splitting the views into their own file would make the next change safer. Low priority; the tests are good.
- Module state (`prev`, `hold`, `failures`, `planned`, `agents`) is wiped by every settings change, because a config write reloads the plugin. After changing a setting, "continue" routes to the default.
- `planned` and `agents` are never pruned. A prompt that is dropped and never reaches `turn.start` stays in `planned`.
- `planSwitch` returns `real: false` for a "worth" switch, but `switchTarget` runs `/model` anyway (`:676`). Either the field or the comment at `econ.ts:120` is out of date.
- `startLaya` spawns `laya-serve` and never stops it.
- The version lives in three files (`plugin.json`, `marketplace.json`, `hooks/version.ts`). A test that reads all three and compares them would stop a missed bump.
- The Haiku judge has a 3 s timeout. `PLAN.md` measured 8 s per call through `claude -p`. That includes process start, so it may be fine in-app, but the in-app latency and timeout rate are not measured. Log `ms` and the fallback source per decision.
- Branches: `failure-escalation` is 3 commits ahead of `main` and 15 behind it. `dev` and `bump-0.3.1` are stale. Rebase before merging, and delete the dead branches.
- Untracked in the working tree: `bench/router/real-savings.mjs` (hardcoded `F:/` and `C:/Users/` paths), `bench/router/ts-resolve.mjs`, `graphify-out/`, `942e7568-…/`. Add the last two to `.gitignore`; parametrize the first before committing it.

## PLAN.md (train laya as the local judge)

The plan is well organised: it has a gate at step 2, a held-out set, and an honest risks section. The problems are in what it chooses to do first.

1. **It optimises the cheapest part.** The judge costs about $0.0005–0.003 a prompt. Replacing it locally saves around a dollar per thousand prompts. A wrong tier costs far more: the local log shows $27 on switches and summaries alone. The plan's own numbers say the judge agrees with human labels 53% of the time against 52% for always-M. Accuracy is the problem, not the judge's price.
2. **The success test is circular.** "Matches Sonnet's labels better than Haiku does" measures agreement with a teacher whose labels are opinions from the same rubric. A student that copies the teacher perfectly is still unvalidated.
3. **The step that unblocks everything is last.** "Add harder bench tasks so under-routing is visible" is in step 6, "keep improving". Without tasks that Haiku fails, step 5's re-bench cannot show any difference between judges. Make it step 1.
4. **The proxy labels do not measure the target.** APPS difficulty and SWE-bench fix time are not "the cheapest model that passes". Step 2's gate checks the teacher against these proxies, so passing the gate proves little.
5. **Train and serve differ.** Training uses the prompt alone. In production the judge also gets the task card (`systemOneBody` puts it in `state.task`). Either train with a card or serve without one.
6. **Effort has no ground truth at all.** Nothing in the plan checks that low/medium/high labels mean anything.
7. **Distribution is missing.** A fine-tuned 1.7 GB checkpoint plus Python and torch is a large ask of a plugin user. The plan does not say where the weights live or who would install them.
8. **141 real prompts.** That is the only in-distribution data, and it is the user's own.

Suggested order instead:

1. Build 20–30 tasks with scripted checks where Haiku fails and Sonnet or Opus passes (multi-file refactor, a bug across files, a hidden test). Run each on all three tiers, 5+ reps. This gives outcome labels: the cheapest tier that passes.
2. Score the current Haiku judge, always-Haiku, always-Sonnet and the "heuristic" backend on those tasks with `score.mjs` (it already has the regret maths). If the judge does not beat always-Sonnet, fix the rubric. That is a prompt change, not a model.
3. Log judge latency and fallbacks in real use for a week.
4. Only then decide on laya: if latency or privacy turns out to matter, train it on outcome labels plus the real prompts with their cards.

## arne-handoff.md

A leftover from an earlier chat (it is git-ignored, so harmless). Its one useful fact is that the README images come from an HTML mock; see item 8. Its open questions were never answered. Delete it once they are.

## What is good

- 90 tests that drive the real hooks through a fake engine, including double presses, reloads and refused writes.
- The cost model is pure, small and tested (`econ.ts`).
- Shortcuts are marked in the code with their ceiling (`ponytail:` comments).
- FINDINGS is honest about its limits. The README should be as honest as FINDINGS.
- Careful handling of the TypeSafe key: secure storage, never logged, tested.

## Suggested order of work

| # | Item | Size |
| --- | --- | --- |
| 1 | Fix the Opus hold and add the test (item 1) | Small |
| 2 | Make validation pass (item 2) | Small |
| 3 | Tighten `RETRY` (item 5) | Small |
| 4 | Correct the README and UI wording (items 3, 7, 8) | Small |
| 5 | Log the judge's usage; baseline on the starting model (item 4) | Medium |
| 6 | CI for test and validate (item 9) | Small |
| 7 | Per-day log files, prompt truncation (item 6) | Medium |
| 8 | Harder bench tasks, then rerun everything on 0.4.x (item 3, PLAN) | Large |
| 9 | Revisit the laya plan with outcome labels | After 8 |
