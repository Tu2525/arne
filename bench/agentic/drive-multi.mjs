// Like drive.mjs, but one session with several prompts, sent one after the other: each waits for the previous turn's answer.
// That is how a chat goes, so context grows and arne has to switch models between turns.
// Usage: node drive-multi.mjs PROMPTS.json [claude flags...]   Prints {results:[result events], total_cost_usd} (the session total).
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const [file, ...flags] = process.argv.slice(2)
const prompts = JSON.parse(readFileSync(file, 'utf8'))
const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...flags], { env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } })
const send = (text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
const results = []
// ARNE_PIN=sonnet|opus sends /arne pin first and waits for its result, so every prompt runs pinned.
let pinning = Boolean(process.env.ARNE_PIN)
let buf = ''
p.stdout.on('data', (d) => {
  buf += d
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (pinning && j.type === 'result') { pinning = false; send(prompts[0]); continue }
    // A dropped prompt and a /model end in results of their own, with no model usage: not an answer.
    // Once the session has used a model their modelUsage is the running total, so the text is checked too:
    // arne's switch drops the prompt, then sends it again.
    if (j.type === 'result' && typeof j.result === 'string' && j.result.startsWith('Prompt dropped by a hook')) continue
    if (j.type !== 'result' || !Object.keys(j.modelUsage ?? {}).length) continue
    results.push(j)
    if (results.length < prompts.length) send(prompts[results.length])
    else p.stdin.end()
  }
})
send(pinning ? `/arne pin ${process.env.ARNE_PIN} medium` : prompts[0])
p.on('close', () => {
  console.log(JSON.stringify({ results, total_cost_usd: results.at(-1)?.total_cost_usd, complete: results.length === prompts.length }))
  process.exit(results.length ? 0 : 1)
})
