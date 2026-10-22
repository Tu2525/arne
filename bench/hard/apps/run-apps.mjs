// Runs one model on each built APPS task: it writes solution.mjs in a fresh workspace, then the hidden tests score it.
// Usage: MODEL=haiku node run-apps.mjs <tasks dir> <out dir> [reps=1] [ids...]   Prints one line per run and appends to <out>/<model>.tsv.
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'

const [tasksDir, outDir, repsArg = '1', ...only] = process.argv.slice(2)
const model = process.env.MODEL ?? 'haiku'
const text = s => (Array.isArray(s) ? s.join('\n') : String(s))
const norm = s => text(s).trim().split(/\s+/).join(' ')
mkdirSync(outDir, { recursive: true })

for (const id of readdirSync(tasksDir).filter(d => !only.length || only.includes(d))) {
  const { tests } = JSON.parse(readFileSync(`${tasksDir}/${id}/tests.json`, 'utf8'))
  for (let rep = 1; rep <= Number(repsArg); rep++) {
    const dir = `${outDir}/w/${model}-${id}-${rep}`
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    cpSync(`${tasksDir}/${id}/problem.md`, `${dir}/problem.md`)
    const prompt = 'Read problem.md. Write solution.mjs, a Node.js program that reads the input from stdin and prints the answer to stdout. ' +
      'Test it against the examples in the problem by running it with node before you finish.'
    const r = spawnSync('claude', ['-p', prompt, '--model', model, '--effort', 'medium', '--setting-sources', 'project', '--strict-mcp-config',
      '--no-session-persistence', '--permission-mode', 'acceptEdits', '--output-format', 'json',
      '--allowedTools', 'Read Edit Write Grep Glob Bash(node:*) Bash(ls:*) Bash(cat:*) PowerShell(node:*) PowerShell(ls:*) PowerShell(cat:*)'],
      { cwd: dir, encoding: 'utf8', timeout: 900_000, input: '' })
    let cost = 0
    try { cost = JSON.parse(r.stdout).total_cost_usd ?? 0 } catch {}
    let passed = 0
    if (existsSync(`${dir}/solution.mjs`)) {
      for (const t of tests) {
        const s = spawnSync('node', ['solution.mjs'], { cwd: dir, input: text(t.input), encoding: 'utf8', timeout: 10_000, maxBuffer: 50_000_000 })
        if (s.status === 0 && norm(s.stdout) === norm(t.output)) passed++
      }
    }
    const ok = passed === tests.length ? 1 : 0
    const row = `${id}\t${rep}\t${ok}\t${passed}/${tests.length}\t${cost.toFixed(4)}`
    console.log(`${model}\t${row}`)
    appendFileSync(`${outDir}/${model}.tsv`, row + '\n')
  }
}
