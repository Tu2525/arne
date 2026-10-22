// Scores multi.sh: five answers per chat (text and file checks), cost of the whole chat, models used per prompt.
// Cost is the session's total_cost_usd, the list-price equivalent. arne's Haiku judge call is not in it: JUDGE_USD each, five per chat.
const fs = require('fs'), path = require('path'), cp = require('child_process')
const B = process.env.ARNE_MULTI_DIR || path.join(process.env.TEMP || '/tmp', 'arnemulti')
const JUDGE_USD = Number(process.env.JUDGE_USD ?? 0.00047)
const pristine = f => fs.readFileSync(path.join(B, 'pristine', f), 'utf8')
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? (['node_modules', '.git', '.claude', '.in_use'].includes(e.name) ? [] : walk(path.join(d, e.name), base))
    : [path.relative(base, path.join(d, e.name)).replace(/\\/g, '/')])
const pristineFiles = new Set(walk(path.join(B, 'pristine')))
const changed = dir => walk(dir).filter(f => !pristineFiles.has(f) || fs.readFileSync(path.join(dir, f), 'utf8') !== pristine(f))
const trueCount = (pristine('tests/effortless.test.ts').match(/(^|[^.\w])test\(/gm) || []).length
const codeLines = s => s.split(/\r?\n/).map(l => l.replace(/\s+/g, '')).filter(l => l && !l.startsWith('/**') && !l.startsWith('*') && !l.startsWith('//'))
const run = dir => { try { return cp.execFileSync('node', ['tools/count-tests.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20000 }) } catch { return 'ERR' } }

const rows = []
for (const f of fs.readdirSync(path.join(B, 'r')).filter(f => f.startsWith('mt-') && f.endsWith('.json'))) {
  const tag = f.replace('.json', ''), [, cond, rep] = tag.split('-')
  let j
  try { j = JSON.parse(fs.readFileSync(path.join(B, 'r', f), 'utf8')) } catch { rows.push({ tag, cond, rep, error: 'no result' }); continue }
  const dir = path.join(B, 'w', tag), ch = changed(dir)
  const t = (j.results || []).map(r => String(r.result || ''))
  const ok = [], why = []
  const check = (name, pass, note) => { ok.push(pass); if (!pass) why.push(`${name}: ${note}`) }
  check('p1', /COLD_MIN_TOKENS|150[_,.]?000|150k/i.test(t[0] || ''), 'no threshold')
  check('p2', [/runUpdate/, /syncRunningCopy|syncPlan/, /reload-plugins|RELOAD_ARGS|--force/].every(r => r.test(t[1] || '')), 'missing function names')
  const theme = fs.existsSync(path.join(dir, 'hooks/theme.ts')) ? fs.readFileSync(path.join(dir, 'hooks/theme.ts'), 'utf8') : ''
  const L = theme.split(/\r?\n/)
  const exp = L.map((l, i) => [l, i]).filter(([l]) => /^export (async )?function |^export const \w+ = (\(|async)/.test(l))
  const documented = exp.every(([, i]) => { let k = i - 1; while (k >= 0 && L[k].trim() === '') k--; return k >= 0 && L[k].trim().endsWith('*/') })
  check('p3', JSON.stringify(codeLines(theme)) === JSON.stringify(codeLines(pristine('hooks/theme.ts'))) && documented, 'theme.ts code changed or exports missed')
  const out = run(dir), n = (out.match(/\d+/) || [])[0]
  check('p4', Number(n) === trueCount && (t[3] || '').includes(String(trueCount)), `script says ${n ?? 'nothing'}, truth ${trueCount}, answer ${(t[3] || '').includes(String(trueCount)) ? 'ok' : 'wrong'}`)
  const first = (fs.existsSync(path.join(dir, 'tools/count-tests.mjs')) ? fs.readFileSync(path.join(dir, 'tools/count-tests.mjs'), 'utf8') : '').split(/\r?\n/).find(l => l.trim() && !l.startsWith('#!')) || ''
  check('p5', /^\s*(\/\/|\/\*)/.test(first) && Number(n) === trueCount && (t[4] || '').includes(String(trueCount)), 'no top comment or wrong count')
  const stray = ch.filter(x => !['hooks/theme.ts', 'tools/count-tests.mjs'].includes(x))
  if (stray.length) why.push('other files: ' + stray.join(','))
  const models = (j.results || []).map(r => Object.keys(r.modelUsage || {}).map(m => m.replace('claude-', '').replace('-5-5', '')).join('+'))
  rows.push({ tag, cond, rep, ok, all: ok.every(Boolean) && !stray.length && j.complete, why, models, cost: (j.total_cost_usd || 0) + (cond === 'arne' || cond === 'arnefloor' ? JUDGE_USD * 5 : 0), ms: (j.results || []).reduce((s, r) => s + (r.duration_ms || 0), 0) })
}
fs.writeFileSync(path.join(B, 'scored.json'), JSON.stringify(rows, null, 1))

const good = rows.filter(r => !r.error)
const sum = (a, k) => a.reduce((t, r) => t + (r[k] || 0), 0)
const label = { opus: 'Opus medium, no mods', sonnet: 'Sonnet medium, no mods', arne: 'arne (starts on Opus)', arnesonnet: 'arne pinned Sonnet', arneopus: 'arne pinned Opus', arnehaiku: 'arne pinned Haiku', arnefloor: 'arne, Sonnet or Opus only', effopus: 'effortless on Opus', effsonnet: 'effortless on Sonnet', eropus: 'effort-router on Opus', ersonnet: 'effort-router on Sonnet' }
console.log('| Setup | Chats | Prompts right | Chats fully right | Avg cost per chat | Cost per right prompt | Avg time |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
for (const c of ['opus', 'sonnet', 'arne', 'arnesonnet', 'arneopus', 'arnehaiku', 'arnefloor', 'effopus', 'effsonnet', 'eropus', 'ersonnet']) {
  const a = good.filter(r => r.cond === c)
  if (!a.length) continue
  const right = a.reduce((t, r) => t + r.ok.filter(Boolean).length, 0), all = a.length * 5
  console.log(`| ${label[c]} | ${a.length} | ${right}/${all} (${Math.round(100 * right / all)}%) | ${a.filter(r => r.all).length}/${a.length} | $${(sum(a, 'cost') / a.length).toFixed(3)} | $${(sum(a, 'cost') / right).toFixed(3)} | ${(sum(a, 'ms') / a.length / 1000).toFixed(0)} s |`)
}
const cost = c => { const a = good.filter(r => r.cond === c); return a.length ? sum(a, 'cost') / a.length : NaN }
for (const c of ['opus', 'sonnet']) if (cost('arne') && cost(c)) console.log(`arne vs ${label[c]}: ${Math.round(100 * (1 - cost('arne') / cost(c)))}% cheaper per chat`)
console.log('\nModel per prompt (arne):')
for (const r of good.filter(r => r.cond.startsWith('arne'))) console.log(' ', r.tag, r.models.join(' > '))
console.log('\nMisses:')
for (const r of rows) for (const w of r.error ? [r.error] : r.why) console.log('-', r.tag + ':', w)
