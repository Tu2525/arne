// Scores apps-escalate.sh: hidden tests on the final solution.mjs, models per prompt, cost (arne adds one judge call).
const fs = require('fs'), path = require('path'), cp = require('child_process')
const OUT = process.env.OUT, { tests } = JSON.parse(fs.readFileSync(process.env.TESTS, 'utf8')), JUDGE_USD = 0.00047
const text = s => (Array.isArray(s) ? s.join('\n') : String(s)), norm = s => text(s).trim().split(/\s+/).join(' ')
const rows = []
for (const f of fs.readdirSync(path.join(OUT, 'r')).filter(f => f.endsWith('.json'))) {
  const tag = f.replace('.json', ''), cond = tag.split('-')[1], dir = path.join(OUT, 'w', tag)
  let j; try { j = JSON.parse(fs.readFileSync(path.join(OUT, 'r', f), 'utf8')) } catch { rows.push({ tag, cond, error: 'no result' }); continue }
  let passed = 0
  if (fs.existsSync(path.join(dir, 'solution.mjs'))) for (const t of tests) {
    const s = cp.spawnSync('node', ['solution.mjs'], { cwd: dir, input: text(t.input), encoding: 'utf8', timeout: 10000, maxBuffer: 50e6 })
    if (s.status === 0 && norm(s.stdout) === norm(t.output)) passed++
  }
  const models = (j.results || []).map(r => Object.keys(r.modelUsage || {}).map(m => m.replace('claude-', '').replace('-5-5', '')).join('+'))
  rows.push({ tag, cond, pass: passed === tests.length, passed, n: tests.length, models, cost: (j.total_cost_usd || 0) + (cond.startsWith('arne') ? JUDGE_USD : 0) })
}
rows.sort((a, b) => a.tag.localeCompare(b.tag))
for (const r of rows) console.log(r.error ? `${r.tag} ${r.error}` : `${r.tag}  ${r.pass ? 'PASS' : 'fail'} ${r.passed}/${r.n}  $${r.cost.toFixed(3)}  ${r.models.join(' > ')}`)
console.log('\ncond      passes  avg cost')
for (const c of [...new Set(rows.map(r => r.cond))]) { const a = rows.filter(r => r.cond === c && !r.error); console.log(`${c.padEnd(9)} ${a.filter(r => r.pass).length}/${a.length}     $${(a.reduce((t, r) => t + r.cost, 0) / (a.length || 1)).toFixed(3)}`) }
