You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. `claude plugin test .` runs the tests.

Task: Mirror routed effort to native /effort before the prompt (step 17c)

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
- an effort change runs the native /effort first, once, and not again while it matches (17c)

They rely on the exact names and texts below. Use them as written.

Other new values the tests compare against (replies, fields, settings):
- "refactor the parser"
- "/effort high"
- "and the lexer"

Make the change in the source files and finish without asking questions.
