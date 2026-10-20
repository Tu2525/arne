# arne

A Claude Code plugin that sends each prompt and each subagent run to the cheapest model and effort that can handle it (Haiku 5.5, Sonnet 5.5 or Opus 5.5). It manages the cache, compaction and model switches around that choice. Every choice shows in the band above the prompt and is logged with its cost to `~/.claude/arne/decisions.jsonl`, which stays on your machine. `/arne` overrides it.

arne replaces effortless by HeyCubit (MIT). Its cost ratios and the bench below come from effortless. Turn effortless off while arne is on.

## Install

```
/plugin marketplace add tu2525/arne
/plugin install arne@arne
```

Then disable effortless if you have it, and restart.

## Use

The band above the prompt is the control: **● Auto** turns routing on or off (or resumes it after you pick a model yourself), the model and effort pickers pin a choice (Auto unpins), **why** shows the last decision with 👍/👎, **cache** shows what a cold cache will cost, and **⚙** opens the settings. The same settings live in `/config`.

`/arne` covers the same ground from the prompt: `on`, `off`, `pin haiku|sonnet|opus [low|medium|high]`, `unpin`, `handoff`, `subagents on|off`, `why`, `log`, `stats`, `backend haiku|heuristic|laya`, `settings`. A pin belongs to its chat: a new chat starts on Auto.

**Stats** (Settings → Stats, or `/arne stats`) shows what arne saved today, over 7 days and in all. It is an estimate, never an exact figure: each turn's real tokens are priced again as if the turn ran on Opus or Sonnet at medium effort. A different model would have written a different answer, so the real difference can't be known. Model switches and summaries count against arne, and turns logged before Stats existed are skipped.

**Handoff** (the band's panel, the cold and heavy alerts, or `/arne handoff [haiku|sonnet|opus]`) has Haiku summarize the chat into `arne-handoff.md` and the clipboard, runs `/clear`, moves to the tier you picked and sends the summary as the new chat's first message. The old chat stays in history; plugins can't archive a chat, so archiving it from the sidebar is your click. When a cheaper model fits but switching on a warm cache costs more than it saves, the panel prices staying, switching and a handoff side by side.

**Subagents** get their model when they start, never one dearer than the chat that sent them, at medium effort or more. A subagent the call asked a model for ("use haiku to write this") runs on it, and so do forks, teammates and workflow agents. When arne moves one, it says so on the Agent call. The band's panel counts this chat's subagents and has a **Route subagents** switch (also in Settings and `/arne subagents on|off`).

**Plugins can't move the app's model menu.** arne switches with the real `/model`, but the desktop app's model menu keeps showing your last pick there; the band says so when they differ.

## Credits

effortless by HeyCubit is MIT-licensed. arne reuses its cost formulas and its bench tasks; its licence is in [bench/LICENSE.effortless](bench/LICENSE.effortless).

## License

MIT, see [LICENSE](LICENSE).

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
