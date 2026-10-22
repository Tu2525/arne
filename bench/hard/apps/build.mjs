// Builds runnable tasks from the Sonnet-labelled APPS prompts: problem.md for the model, tests.json kept apart for scoring.
// Usage: node build.mjs <apps train.jsonl> <labels dir> <out dir> [tier=L]
import { createReadStream, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [train, labelsDir, out, tier = 'L'] = process.argv.slice(2)
const jl = f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const labelled = new Map(jl(`${labelsDir}/sonnet-labels.jsonl`).map(l => [l.id, l]))
const want = new Set(jl(`${labelsDir}/subset1500.jsonl`).filter(j => j.id.startsWith('apps-') && labelled.get(j.id)?.tier === tier).map(j => Number(j.id.slice(5))))
const rl = createInterface({ input: createReadStream(train) })
let made = 0
for await (const line of rl) {
  const m = /^\{"id": (\d+),/.exec(line)
  if (!m || !want.has(Number(m[1]))) continue
  const j = JSON.parse(line)
  let io
  try { io = JSON.parse(j.input_output) } catch { continue }
  if (!io.inputs?.length || io.fn_name) continue // stdin/stdout problems only
  const tests = io.inputs.map((input, i) => ({ input, output: io.outputs[i] })).filter(t => t.input.length < 20000)
  if (!tests.length) continue
  const dir = `${out}/apps-${j.id}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/problem.md`, `${j.question}\n`)
  writeFileSync(`${dir}/tests.json`, JSON.stringify({ difficulty: j.difficulty, url: j.url, tests: tests.slice(0, 25) }))
  made++
}
console.log(`${made} of ${want.size} problems written to ${out}`)
