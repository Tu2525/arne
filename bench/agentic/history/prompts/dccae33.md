You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. `claude plugin test .` runs the tests.

Task: Jev judge (17s): TypeSafe's hosted System One as a backend next to Laya

- One System One request for laya-serve and Jev (systemOneBody/systemOneVerdict), with the task card in state and a 1.5 s limit
- Verdict by argmax over probabilities: a score is an expectation, not an index (fixes laya too); under 0.5 confidence falls through
- TYPESAFE_API_KEY from the environment only; without it no request is made and the why line says Haiku judged
- /arne backend jev, the Settings note and README say prompts leave the machine; off by default
- Stats counts Jev calls on their own row, in tokens

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
- /arne backend sets the backend that routing reads (17u)
- /arne backend jev sets the backend and says prompts leave the machine (17s)
- Jev with no TYPESAFE_API_KEY makes no request: Haiku judges, and the why line says so (17s)
- laya answers map to a verdict, abstention falls through
- the sample System One response gives tier and effort through argmax (17s)
- a System One answer under 0.5 confidence falls through (17s)

They rely on the exact names and texts below. Use them as written.

New exports (keep the name and the signature):

hooks/backends.ts:
// Pure: System One's answers to a verdict, by argmax over each answer's probabilities. A score is an
// expectation (0.67 between two levels), never an index. An abstained, unsure or missing answer is
// undefined, so the chain falls through to the next judge.
export function systemOneVerdict(answers: any, reason = 'system one'): Verdict | undefined

Text shown on screen:
- "/Jev needs TYPESAFE_API_KEY, Haiku judged/"

Other new values the tests compare against (replies, fields, settings):
- "backend jev"
- "leave this machine"

Make the change in the source files and finish without asking questions.
