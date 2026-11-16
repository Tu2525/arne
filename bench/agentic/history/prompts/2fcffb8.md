You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. `claude plugin test .` runs the tests.

Task: Retry three times on the same model before a failure moves it up

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
- subagents are routed under a Sonnet ceiling by default
- a model gets three failed attempts before the retry moves one model up, and the next prompts stay there for two turns
- the judge never picks Opus, but a failed attempt on Sonnet goes up to it

They rely on the exact names and texts below. Use them as written.

Other new values the tests compare against (replies, fields, settings):
- "still 199, that is wrong, try again"
- "still wrong, try again"

Make the change in the source files and finish without asking questions.
