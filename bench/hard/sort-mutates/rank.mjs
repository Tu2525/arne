// The n highest-scoring items, best first.
export function topN(items, n) {
  return items.sort((a, b) => b.score - a.score).slice(0, n)
}
