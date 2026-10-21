// Score routers on a cases file. Usage: node bench/router/score.mjs CASES.jsonl [PREDS.jsonl ...] [--fail 0.01]
// A preds file is one {id, tier} per line (tier S|M|L). Only test-split cases that every preds file answers are scored.
// Cases with pass/cost: loss = cost + (1 - pass) * FAIL, regret = loss - the oracle's loss. FAIL is what a wrong answer
//   costs in dollars (the retry plus the person's time), so routing too low is punished and routing too high only costs money.
// Cases with a label (human difficulty): accuracy and which way the misses lean.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const fi = args.indexOf('--fail')
const FAIL = fi >= 0 ? Number(args.splice(fi, 2)[1]) : 0.01
const [casesFile, ...predFiles] = args
const rows = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const preds = predFiles.map((f) => [basename(f, '.jsonl').replace(/^preds-/, ''), new Map(rows(f).map((r) => [r.id, r.tier]))])
const cases = rows(casesFile).filter((c) => c.split === 'test' && preds.every(([, m]) => m.has(c.id)))
const RANK = { S: 0, M: 1, L: 2 }
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
console.log(`${cases.length} test cases from ${basename(casesFile)}; FAIL = $${FAIL}\n`)

if (cases[0]?.label) {
  const fixed = ['S', 'M', 'L'].map((t) => [`always-${t}`, { get: () => t, has: () => true }])
  for (const [name, m] of [...fixed, ...preds]) {
    const d = cases.map((c) => [c.label, m.get(c.id)])
    const hit = d.filter(([a, b]) => a === b).length
    const under = d.filter(([a, b]) => RANK[b] < RANK[a]).length
    const over = d.filter(([a, b]) => RANK[b] > RANK[a]).length
    const conf = {}
    for (const [a, b] of d) conf[`${a}->${b}`] = (conf[`${a}->${b}`] ?? 0) + 1
    console.log(`${name.padEnd(14)} acc ${(100 * hit / d.length).toFixed(1)}%  under ${under}  over ${over}`, conf)
  }
  console.log('label mix', cases.reduce((o, c) => ((o[c.label] = (o[c.label] ?? 0) + 1), o), {}))
} else {
  const T = ['S', 'M', 'L']
  const loss = (c, t) => c.cost[t] + (1 - c.pass[t]) * FAIL
  const best = (c) => T.reduce((a, t) => (loss(c, t) < loss(c, a) ? t : a))
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const routers = [
    ...T.map((t) => [`always-${t}`, () => t]),
    ['random', () => T[Math.floor(rnd() * 3)]],
    ['oracle', best],
    ...preds.map(([n, m]) => [n, (c) => m.get(c.id)]),
  ]
  const pick = Object.fromEntries(routers.map(([n, f]) => [n, cases.map((c) => f(c))]))
  const cost = (n) => mean(cases.map((c, i) => c.cost[pick[n][i]]))
  const qual = (n) => mean(cases.map((c, i) => c.pass[pick[n][i]]))
  const L = (n) => mean(cases.map((c, i) => loss(c, pick[n][i])))
  const oracle = L('oracle')
  console.log('router'.padEnd(14), 'cost/req   quality  vs-L cost  vs-L qual  regret/req  S/M/L share')
  for (const [n] of routers) {
    const share = T.map((t) => Math.round(100 * pick[n].filter((x) => x === t).length / cases.length)).join('/')
    console.log(n.padEnd(14), `$${cost(n).toFixed(5)}`.padEnd(10), qual(n).toFixed(3).padEnd(8), `${(100 * cost(n) / cost('always-L')).toFixed(0)}%`.padStart(8), `${(100 * qual(n) / qual('always-L')).toFixed(0)}%`.padStart(10), `$${(L(n) - oracle).toFixed(5)}`.padStart(12), ' ', share)
  }
}
