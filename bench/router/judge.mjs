// Run arne's Haiku judge (the real SYSTEM prompt and parseVerdict) over test cases.
//   node --experimental-strip-types --no-warnings bench/router/judge.mjs CASES.jsonl OUT.jsonl [N] [CONCURRENCY]
// Takes N test cases (a fixed shuffle, so reruns pick the same ones), skips ids already in OUT, appends as it goes.
// Each line: {id, tier, effort, usd, ms, input, out}. usd is claude's total_cost_usd, the list-price cost of the call.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { SYSTEM, parseVerdict } from '../../hooks/backends.ts'

const [casesFile, outFile, n = '100', conc = '4'] = process.argv.slice(2)
const rows = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const done = new Set(existsSync(outFile) ? rows(outFile).map((r) => r.id) : [])
// A cheap deterministic shuffle: sort by a hash of the id.
const h = (s) => [...s].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) | 0, 7)
const todo = rows(casesFile).filter((c) => c.split === 'test').sort((a, b) => h(a.id) - h(b.id)).slice(0, Number(n)).filter((c) => !done.has(c.id))

function ask(text) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    // Run from the temp dir with project settings only, so no user plugin (arne itself included) or CLAUDE.md joins the call.
    const p = spawn('claude', ['-p', '--model', 'haiku', '--system-prompt', SYSTEM, '--tools', '', '--setting-sources', 'project',
      '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'], { cwd: tmpdir() })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => {
      try { resolve({ ...JSON.parse(out), ms: Date.now() - t0 }) } catch { resolve({ ms: Date.now() - t0, error: out.slice(0, 200) }) }
    })
    p.stdin.end(text.slice(0, 4000))
  })
}

let next = 0
await Promise.all(Array.from({ length: Number(conc) }, async () => {
  while (next < todo.length) {
    const c = todo[next++]
    const r = await ask(c.prompt)
    const v = parseVerdict(r.result ?? '')
    // No verdict falls through arne's chain to the default, M: score it as that.
    appendFileSync(outFile, JSON.stringify({ id: c.id, tier: v?.tier ?? 'M', effort: v?.effort ?? 'medium', fallback: !v || undefined, usd: r.total_cost_usd, ms: r.ms, input: r.usage?.input_tokens, read: r.usage?.cache_read_input_tokens, write: r.usage?.cache_creation_input_tokens, out: r.usage?.output_tokens }) + '\n')
  }
}))
console.log('done', todo.length)
