export function allocate(total, weights) {
  if (!Number.isInteger(total)) throw new Error('total must be an integer')
  const W = weights.reduce((a, b) => a + b, 0)
  if (!weights.length || !(W > 0)) throw new Error('weights must have a positive sum')
  const sign = total < 0 ? -1 : 1, t = Math.abs(total)
  const exact = weights.map(w => t * w / W)
  const out = exact.map(Math.floor)
  let left = t - out.reduce((a, b) => a + b, 0)
  const order = exact.map((e, i) => [e - out[i], i, weights[i]]).filter(x => x[2] > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]]++
  return out.map(x => x * sign + 0)
}
