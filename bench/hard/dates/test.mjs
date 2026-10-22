import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// The date cases run in a child process set to Pacific/Auckland (UTC+13), so a UTC-versus-local mix-up shows.
test('cases.mjs passes in the Pacific/Auckland timezone', () => {
  const env = { ...process.env, TZ: 'Pacific/Auckland' }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['cases.mjs'], { env, encoding: 'utf8', timeout: 15000 })
  assert.equal(r.status, 0, `cases.mjs failed or hung (status ${r.status}):\n${(r.stdout || '').slice(-1500)}`)
})
