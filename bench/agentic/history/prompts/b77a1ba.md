You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. `claude plugin test .` runs the tests.

Task: Add cache clock: per-tier warmUntil, TTL detection, band countdown, /arne debug

Step 11 (live check pending). TTL detection ported from effortless (MIT).

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
- routeWorth: warm 80k Opus to cold Haiku does not pay
- cache clock helpers

They rely on the exact names and texts below. Use them as written.

New exports (keep the name and the signature):

hooks/econ.ts:
/** The cache lifetime a response's writes got, when it says. */
export function cacheTtlOf(usage: unknown): Ttl | undefined

hooks/econ.ts:
/** Context size C: everything the request sent. */
export const contextOf = (usage: unknown)

hooks/econ.ts:
export const mmss = (ms: number)

hooks/econ.ts:
/**
 * The TTL after a response. A read back after more than 5 minutes proves 1h; once 1h is seen,
 * a short 5m tail write never pulls it back down.
 */
export function nextTtl(prev: Ttl, usage: unknown, sinceLastMs: number | undefined): Ttl

hooks/econ.ts:
export const tierOf = (model: string): Tier | undefined

Other new values the tests compare against (replies, fields, settings):
- "5m"
- "60:00"
- "1:02"

Make the change in the source files and finish without asking questions.
