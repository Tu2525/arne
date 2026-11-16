You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. `claude plugin test .` runs the tests.

Task: Hold Opus past the ceiling after an escalation; tighten the retry detector; self-contained types

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
- subagents are routed under a Sonnet ceiling by default
- the judge never picks Opus, but a failed attempt on Sonnet goes up to it
- the same retry words typed again still count as another failed attempt
- after Sonnet fails, the hold keeps Opus above the ceiling for two new tasks, then drops back
- "ok continue" after an escalation to Opus stays on Opus
- failedAttempt: retry words count only on a short prompt after an edit or a command

They rely on the exact names and texts below. Use them as written.

Other new values the tests compare against (replies, fields, settings):
- "do the task"
- "ok continue"
- "I am still not sure about the naming"
- "explain why login is not working in prod"
- "that's wrong on purpose, keep it"
- "try again, ${'and this time read every file under hooks first '.repeat(2)}"

Make the change in the source files and finish without asking questions.
