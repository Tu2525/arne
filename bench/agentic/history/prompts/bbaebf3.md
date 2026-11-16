You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. `claude plugin test .` runs the tests.

Task: Subagent ceiling (17y): Off · Haiku · Sonnet · Opus, default Sonnet, caps named models too

- Subagents is now the dearest model a subagent may run on; the old boolean reads true as Sonnet, false as Off
- A routed subagent takes the cheapest of the judge's clamped pick, the parent's tier and the ceiling
- A named model dearer than the ceiling runs on the ceiling at medium, says "arne: Sonnet (capped from Opus)" on the call, counts as capped in the panel and is logged with source capped and from/to
- /arne subagents off|haiku|sonnet|opus, with on as Sonnet
- Forks, teammates, workflow agents, resumed runs, arne off and Off stay untouched; a pin no longer skips this

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
- the Subagents ceiling caps a named model and the judge, under any parent or pin; Opus lets Opus through; Off, a fork and a cheaper named model are untouched (17y)
- the old Subagents On/Off reads as a ceiling: true is Sonnet, false is off (17y)
- one press on each settings choice in the panel writes that setting
- Subagents reads its ceiling in Settings, not in the panel; no Esc hint, since no key closes the band (fixes 2, 3)

They rely on the exact names and texts below. Use them as written.

Keys of buttons the tests press, or of other values they read:
- "subagents-off"
- "subagents-sonnet"

Text shown on screen:
- "3 subagents routed: 1 Sonnet, 1 as asked, 1 capped"

Other new values the tests compare against (replies, fields, settings):
- "arne routes subagents, Sonnet at most."
- "{\"tier\":\"L\",\"effort\":\"high\",\"reason\":\"a design\"}"
- "arne: Sonnet (capped from Opus)"
- "t5"
- "subagents opus"
- "arne routes subagents, Opus at most."
- "t6"
- "t7"
- "t8"
- "t9"
- "subagents max"
- "Usage: /arne subagents off|haiku|sonnet|opus"

Make the change in the source files and finish without asking questions.
