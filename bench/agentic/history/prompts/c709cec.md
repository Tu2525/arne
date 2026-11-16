You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. `claude plugin test .` runs the tests.

Task: Settings fits the band: Routing and Limits side by side from 90 columns

- The app caps the band at half the window and scrolls past it, which cut off Limits; at 100 columns Settings now draws in 12 rows, as the main panel with its costs table does
- Below 90 columns the cards stay stacked
- One judge note, on one line: Laya's, or Jev's while Jev is the judge; Also in /config. keeps its own line

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
- Settings fits the band: side by side from 90 columns in at most 12 rows, stacked at 50, one line per note

They rely on the exact names and texts below. Use them as written.

Keys of buttons the tests press, or of other values they read:
- "settings-cards"

Text shown on screen:
- "Laya runs on this machine and learns from your ratings."
- "/^Jev is hosted/"
- "Jev is hosted: prompts leave this machine (needs TYPESAFE_API_KEY)."

Other new values the tests compare against (replies, fields, settings):
- "s label and a gap, and two for the picked segment"

Make the change in the source files and finish without asking questions.
