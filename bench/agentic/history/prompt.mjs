// The prompt for one history task: what the commit did, in words, plus the names and texts its hidden tests rely on.
// No test code is shown: only test titles, the signatures of new exports (from the commit's source) and new literals.
//   node bench/agentic/history/prompt.mjs <sha>          prints the prompt
//   node bench/agentic/history/prompt.mjs --all          writes prompts/<sha>.md for every row of tasks.tsv
// A prompt file that exists is never overwritten, so a hand-edited one stays.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 })
const isTest = f => /\.test\.tsx?$/.test(f)
const isCode = f => /^(hooks|types|tests|\.claude-plugin)\//.test(f)

export function promptFor(sha) {
  const parent = `${sha}^`
  const files = rev => git('ls-tree', '-r', '--name-only', rev).split('\n').filter(isCode)
  // Everything the parent already has: a name or text found here needs no telling.
  const before = files(parent).map(f => git('show', `${parent}:${f}`)).join('\n')
  const tests = files(sha).filter(isTest)
  const added = git('diff', '-U0', parent, sha, '--', ...tests).split('\n')

  // What the tests check, in their own titles: new tests, and changed ones (git names them in the hunk header).
  const titles = new Set()
  for (const l of added) {
    const m = /^(?:\+|@@.*@@ )test\((['"`])(.*?)\1,/.exec(l)
    if (m) titles.add(m[2])
  }

  // New literals, sorted by what the line does with them.
  const kinds = { key: new Set(), button: new Set(), text: new Set(), other: new Set() }
  for (const l of added) {
    if (!l.startsWith('+') || l.startsWith('+++') || /^\+test\(/.test(l)) continue
    const kind = /press\(|key:/.test(l) ? 'key' : /type: 'Button'/.test(l) ? 'button' : /type: 'Text'/.test(l) ? 'text' : 'other'
    const lits = [...l.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map(m => m[1] ?? m[2] ?? m[3])
    const res = [...l.matchAll(/(?:text:|toMatch\()\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g)].map(m => m[1])
    for (const s of [...lits, ...res]) if (s.length > 1 && !s.startsWith('./') && !before.includes(s)) kinds[kind].add(s)
  }

  // New exports the tests import: the declaration and its comment, from the commit's source, without the body.
  const exportsNew = []
  for (const t of tests) {
    const src = git('show', `${sha}:${t}`)
    for (const m of src.matchAll(/import (?:type )?\{([^}]*)\} from '(\.[^']*)'/g)) {
      const base = join(dirname(t), m[2]).replace(/\\/g, '/')
      const file = files(sha).find(f => f === `${base}.ts` || f === `${base}.tsx`)
      if (!file) continue
      const lines = git('show', `${sha}:${file}`).split('\n')
      for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
        const decl = new RegExp(`^export (?:async )?(?:const|function\\*?|type|class|let) ${name}\\b`)
        if (before.split('\n').some(x => decl.test(x))) continue
        const i = lines.findIndex(x => decl.test(x))
        if (i < 0) continue
        let j = i
        while (j > 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[j - 1])) j--
        // A signature that runs over several lines is taken to its closing parenthesis.
        let sig = lines[i]
        const depth = s => (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length
        for (let k = i + 1; depth(sig) > 0 && k < lines.length; k++) sig += `\n${lines[k]}`
        const head = sig.replace(/\s*=>.*$/, '').replace(/\s*\{\s*$/, '').replace(/^(export const \w+(?::[^=]+)?) = (?!\(|async).*$/, '$1')
        exportsNew.push(`${file}:\n${[...lines.slice(j, i), head].join('\n')}`)
      }
    }
  }

  const list = (title, set) => (set.size ? `\n${title}\n${[...set].map(s => `- ${JSON.stringify(s)}`).join('\n')}\n` : '')
  return `You are working in the source of arne, a Claude Code plugin. The hooks module is hooks/register.tsx; its helpers and tests sit beside it. \`claude plugin test .\` runs the tests.

Task: ${git('log', '-1', '--format=%B', sha).trim()}

Hidden tests will check the change. They replace the test files when you finish, so edits to tests do not count. They check that:
${[...titles].map(t => `- ${t}`).join('\n')}

They rely on the exact names and texts below. Use them as written.
${exportsNew.length ? `\nNew exports (keep the name and the signature):\n${exportsNew.map(e => `\n${e}\n`).join('')}` : ''}${list('Keys of buttons the tests press, or of other values they read:', kinds.key)}${list('Button labels:', kinds.button)}${list('Text shown on screen:', kinds.text)}${list('Other new values the tests compare against (replies, fields, settings):', kinds.other)}
Make the change in the source files and finish without asking questions.
`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2]
  if (arg !== '--all') process.stdout.write(promptFor(arg))
  else {
    mkdirSync(join(here, 'prompts'), { recursive: true })
    for (const row of readFileSync(join(here, 'tasks.tsv'), 'utf8').trim().split('\n').slice(1)) {
      const sha = row.split('\t')[0]
      const out = join(here, 'prompts', `${sha}.md`)
      if (!existsSync(out)) writeFileSync(out, promptFor(sha))
    }
  }
}
