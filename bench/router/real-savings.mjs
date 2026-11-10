// What arne saved on real use, from the local log: the legacy decisions.jsonl and the per-chat day files in log/.
//   node --import ./bench/router/ts-resolve.mjs --experimental-strip-types bench/router/real-savings.mjs [ARNE_DIR]
// ARNE_DIR defaults to ~/.claude/arne. Any other *.jsonl directly in it (a backup) is summarized on its own.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseUsage, summarize } from '../../hooks/stats.ts'

const dir = (process.argv[2] ?? `${homedir()}/.claude/arne`).replace(/\\/g, '/').replace(/\/$/, '')
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const logDir = `${dir}/log`
const days = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).map((f) => `${logDir}/${f}`) : []
const sets = [
  ...readdirSync(dir).filter((f) => f.endsWith('.jsonl') && f !== 'decisions.jsonl').map((f) => [f, read(`${dir}/${f}`)]),
  ['decisions.jsonl + log/', [`${dir}/decisions.jsonl`, ...days].map(read).join('\n')],
]
for (const [name, text] of sets) {
  const rows = parseUsage(text)
  const s = summarize(rows, 0)
  const ds = [...new Set(rows.map((r) => new Date(r.at).toISOString().slice(0, 10)))]
  console.log(name, rows.length, 'usage rows, days', ds.join(','))
  console.log(' turns', s.turns, 'spent $' + s.spent.toFixed(2), 'all-Opus $' + s.opus.toFixed(2), 'saved ' + (100 * (1 - s.spent / s.opus)).toFixed(0) + '%')
  for (const l of s.lines) console.log('  ', l.label.padEnd(24), String(l.count).padStart(4), '$' + l.cost.toFixed(2))
}
