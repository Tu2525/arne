const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
function parse(v) {
  const m = RE.exec(v)
  if (!m) throw new Error('bad version: ' + v)
  return { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] }
}
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) return +p < +q ? -1 : 1
    if (pn) return -1
    if (qn) return 1
    return p < q ? -1 : 1
  }
  return 0
}
const str = n => n.join('.')
function expand(tok) {
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(tok)
  const op = m[1] || '=', v = m[2], p = parse(v), [M, mi, pa] = p.n
  if (op === '~') return [['>=', v], ['<', str([M, mi + 1, 0])]]
  if (op === '^') return [['>=', v], ['<', M > 0 ? str([M + 1, 0, 0]) : mi > 0 ? str([0, mi + 1, 0]) : str([0, 0, pa + 1])]]
  return [[op, v]]
}
const test = (op, r) => ({ '=': r === 0, '>': r > 0, '>=': r >= 0, '<': r < 0, '<=': r <= 0 })[op]
export function satisfies(version, range) {
  const v = parse(version)
  return range.split('||').some(part => {
    const toks = part.trim().split(/\s+/).filter(Boolean)
    const comps = toks.flatMap(expand)
    if (!comps.every(([op, cv]) => test(op, compareVersions(version, cv)))) return false
    if (!v.pre.length) return true
    return toks.some(t => { const m = /^(?:\^|~|>=|<=|>|<|=)?(.+)$/.exec(t), p = parse(m[1]); return p.pre.length && str(p.n) === str(v.n) })
  })
}
