import { topN } from './rank.mjs'

// Lines for a report: the top three in score order, then every item in the order it was submitted.
export function reportLines(items) {
  const top = topN(items, 3).map(i => `top ${i.name} ${i.score}`)
  const all = items.map(i => `all ${i.name} ${i.score}`)
  return [...top, ...all]
}
