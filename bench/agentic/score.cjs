// Adapted from effortless bench/agentic/score.cjs (MIT, see ../LICENSE.effortless). Cost is total_cost_usd: list-price equivalent, not billed.
const fs = require('fs'), path = require('path'), cp = require('child_process')
const B = process.env.ARNE_BENCH_DIR || path.join(process.env.TEMP || '/tmp', 'arnebench')
const pristine = f => fs.readFileSync(path.join(B, 'pristine', f), 'utf8')
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? (['node_modules', '.git', '.claude'].includes(e.name) ? [] : walk(path.join(d, e.name), base))
    : [path.relative(base, path.join(d, e.name)).replace(/\\/g, '/')])
const pristineFiles = new Set(walk(path.join(B, 'pristine')))
const changed = dir => walk(dir).filter(f => !pristineFiles.has(f) || fs.readFileSync(path.join(dir, f), 'utf8') !== pristine(f))
const trueCount = (pristine('tests/effortless.test.ts').match(/(^|[^.\w])test\(/gm) || []).length
const codeLines = s => s.split(/\r?\n/).map(l => l.replace(/\s+/g, '')).filter(l => l && !l.startsWith('/**') && !l.startsWith('*') && !l.startsWith('//'))
const rows = []
for (const f of fs.readdirSync(path.join(B, 'r')).filter(f => f.startsWith('ab3-') && f.endsWith('.json'))) {
  const tag = f.replace('.json', '')
  const [, model, task, cond, rep] = tag.split('-')
  let j
  try { j = JSON.parse(fs.readFileSync(path.join(B, 'r', f), 'utf8')) } catch { rows.push({ tag, model, task, cond, rep, error: 'no result' }); continue }
  const dir = path.join(B, 'w', tag)
  const ch = changed(dir)
  const text = String(j.result || '')
  let ok = false, why = ''
  if (task === 't1') { ok = ch.length === 0 && /COLD_MIN_TOKENS|150[_,.]?000|150k/i.test(text); why = ch.length ? 'changed files' : ok ? '' : 'did not name the threshold' }
  if (task === 't2') {
    const after = fs.existsSync(path.join(dir, 'hooks/theme.ts')) ? fs.readFileSync(path.join(dir, 'hooks/theme.ts'), 'utf8') : ''
    const sameCode = JSON.stringify(codeLines(after)) === JSON.stringify(codeLines(pristine('hooks/theme.ts')))
    const L = after.split(/\r?\n/)
    const exp = L.map((l, i) => [l, i]).filter(([l]) => /^export (async )?function |^export const \w+ = (\(|async)/.test(l))
    const documented = exp.every(([, i]) => { let k = i - 1; while (k >= 0 && L[k].trim() === '') k--; return k >= 0 && L[k].trim().endsWith('*/') })
    const others = ch.filter(x => x !== 'hooks/theme.ts')
    ok = sameCode && documented && others.length === 0 && ch.includes('hooks/theme.ts')
    why = !sameCode ? 'changed code' : !documented ? 'missed exports' : others.length ? 'other files' : !ch.includes('hooks/theme.ts') ? 'no change' : ''
  }
  if (task === 't3') {
    let out = ''
    try { out = cp.execFileSync('node', ['tools/count-tests.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20000 }) } catch { out = 'ERR' }
    const n = (out.match(/\d+/) || [])[0]
    ok = Number(n) === trueCount && text.includes(String(trueCount))
    why = ok ? '' : `script says ${n ?? out.slice(0, 40)}, truth ${trueCount}`
  }
  if (task === 't4') {
    const need = [/runUpdate/, /syncRunningCopy|syncPlan/, /reload-plugins|RELOAD_ARGS|--force/]
    const missing = need.filter(r => !r.test(text)).map(String)
    ok = ch.length === 0 && missing.length === 0
    why = ch.length ? 'changed files' : missing.length ? 'missing ' + missing.join(' ') : ''
  }
  let picked = ''
  try {
    const log = fs.readFileSync(path.join(B, 'r', tag + '.proof.log'), 'utf8')
    picked = [...new Set([...log.matchAll(/effort \w+ -> (\w+)/g)].map(m => m[1]))].join('/')
  } catch {}
  rows.push({ tag, model, task, cond, rep, ok, why, picked, cost: j.total_cost_usd, turns: j.num_turns, ms: j.duration_ms })
}
fs.writeFileSync(path.join(B, 'scored.json'), JSON.stringify(rows, null, 1))

const label = { m: 'medium, no mods', on: 'effortless on (app on medium)', arne: 'arne on (app on medium)' }
const sum = (a, k) => a.reduce((t, r) => t + (r[k] || 0), 0)
const ok = rows.filter(r => !r.error)
for (const model of ['opus']) {
  const mine = ok.filter(r => r.model === model)
  if (!mine.length) continue
  const g = {}; for (const r of mine) (g[r.cond] ??= []).push(r)
  console.log('' + String.fromCharCode(10) + '### ' + model)
  console.log('| Setup | Runs | Correct | API-equivalent cost | Avg API-eq cost/task | Avg requests | Avg time |')
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  for (const c of ['m', 'on', 'arne'].filter(c => g[c])) {
    const a = g[c]
    console.log('| ' + label[c] + ' | ' + a.length + ' | ' + a.filter(r => r.ok).length + ' | $' + sum(a, 'cost').toFixed(2) + ' | $' + (sum(a, 'cost') / a.length).toFixed(3) + ' | ' + (sum(a, 'turns') / a.length).toFixed(1) + ' | ' + (sum(a, 'ms') / a.length / 1000).toFixed(0) + ' s |')
  }
  const t = c => sum(g[c] || [], 'cost')
  if (g.arne) for (const c of ['m', 'on'].filter(c => g[c])) console.log('arne saves vs ' + label[c].split(',')[0] + ': ' + (100 * (1 - (t('arne') / g.arne.length) / (t(c) / g[c].length))).toFixed(0) + '% per task')
  const picks = {}; for (const r of g.on || []) for (const e of (r.picked || '?').split('/')) picks[e] = (picks[e] || 0) + 1
  console.log('effort effortless picked (counts): ' + JSON.stringify(picks))
}
console.log(String.fromCharCode(10) + 'Failures:')
for (const r of rows.filter(r => r.error || !r.ok)) console.log('- ' + r.tag + ': ' + (r.error || r.why))
