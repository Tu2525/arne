// Scores escalate.sh: does the chat end with passing tests, which models ran per prompt, what it cost.
const fs = require('fs'), path = require('path'), cp = require('child_process')
const OUT = process.env.OUT, JUDGE_USD = 0.00047
const rows = []
for (const f of fs.readdirSync(path.join(OUT, 'r')).filter(f => f.endsWith('.json'))) {
  const tag = f.replace('.json', ''), cond = tag.split('-')[1], dir = path.join(OUT, 'w', tag)
  let j; try { j = JSON.parse(fs.readFileSync(path.join(OUT, 'r', f), 'utf8')) } catch { rows.push({ tag, cond, error: 'no result' }); continue }
  let pass = false
  try { cp.execFileSync('node', ['--test'], { cwd: dir, timeout: 30000, stdio: 'ignore' }); pass = true } catch {}
  const same = n => fs.readFileSync(path.join(dir, n), 'utf8') === fs.readFileSync(path.join(__dirname, 'dates', n), 'utf8')
  const clean = same('test.mjs') && same('cases.mjs')
  const models = (j.results || []).map(r => Object.keys(r.modelUsage || {}).map(m => m.replace('claude-', '').replace('-5-5', '')).join('+'))
  rows.push({ tag, cond, pass: pass && clean, complete: j.complete, models, cost: (j.total_cost_usd || 0) + (cond.startsWith('arne') ? JUDGE_USD : 0) })
}
rows.sort((a, b) => a.tag.localeCompare(b.tag))
for (const r of rows) console.log(r.error ? `${r.tag} ${r.error}` : `${r.tag}  ${r.pass ? 'PASS' : 'fail'}  ${r.complete ? '' : 'incomplete '} $${r.cost.toFixed(3)}  ${r.models.join(' > ')}`)
console.log('\ncond      passes  avg cost')
for (const c of [...new Set(rows.map(r => r.cond))]) {
  const a = rows.filter(r => r.cond === c && !r.error)
  console.log(`${c.padEnd(9)} ${a.filter(r => r.pass).length}/${a.length}     $${(a.reduce((t, r) => t + r.cost, 0) / (a.length || 1)).toFixed(3)}`)
}
