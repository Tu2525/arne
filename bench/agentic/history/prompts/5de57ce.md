You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. `claude plugin test .` runs the tests.

Task: Settings and Stats move into the band's panel: one press answers; Back returns, closing resets the view, /arne settings and /arne stats open it; the panes point to the band

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
- one press on each settings choice in the panel writes that setting
- Settings, then Stats, then Back twice is the main panel; closing the panel resets the view; /arne settings opens it

They rely on the exact names and texts below. Use them as written.

Keys of buttons the tests press, or of other values they read:
- "${key}-${value}"

Other new values the tests compare against (replies, fields, settings):
- "arne.${key}"

Make the change in the source files and finish without asking questions.
