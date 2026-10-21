// Runs one prompt through `claude -p` the way the desktop composer would, so arne's prompt.submit hook can drop the
// prompt, run the real /model, and take the re-sent one. Plain `claude -p "prompt"` gives the hook no such chance:
// the session ends at the first result, the dropped prompt's. This holds stdin open until the turn that did real work.
// Usage: node drive.mjs "prompt" [claude flags...]   Prints the final result event as JSON, like --output-format json.
import { spawn } from 'node:child_process'

const [prompt, ...flags] = process.argv.slice(2)
const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...flags], { env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } })
let buf = ''
let last
p.stdout.on('data', (d) => {
  buf += d
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    let j
    try { j = JSON.parse(line) } catch { continue }
    // A dropped prompt and a /model both end in a result of their own, with no model usage: not the answer.
    if (j.type === 'result' && Object.keys(j.modelUsage ?? {}).length) { last = j; p.stdin.end() }
  }
})
p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
p.on('close', () => { if (last) console.log(JSON.stringify(last)); process.exit(last ? 0 : 1) })
