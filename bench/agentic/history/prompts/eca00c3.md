You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. `claude plugin test .` runs the tests.

Task: App picker is an input; pins move /model at once (step 17f)

A pick in the desktop app's model picker (PostModelSwitch source sdk) now
pins that tier instead of pausing arne. arne tracks what the picker shows
and, when its /model differs, the band says "Running X · app picker shows Y".
Pins from the band or /arne pin move /model right away; /arne pin waits a
tick because a nested /model inside its own hook is refused.

Checked on this session's transcript: answers followed the engine /model
(Haiku, then Opus) while the picker still showed Sonnet, and the app did
not re-assert its pick, so the main loop stays on the real /model.

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
- a pick in the app picker pins that tier instead of pausing, and band Auto unpins it (17f)
- the band says so when arne runs a model the app picker does not show (17f)
- a pin from the band or /arne pin moves /model at once, before any prompt (17f)

They rely on the exact names and texts below. Use them as written.

Text shown on screen:
- "/app picker shows/"
- "/Running Opus · app picker shows Sonnet/"

Other new values the tests compare against (replies, fields, settings):
- "pinned opus"
- "pin opus high"
- "/model claude-opus-5-5"

Make the change in the source files and finish without asking questions.
