import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { LAYA_URL, layaBody, layaVerdict, parseVerdict, SYSTEM } from './backends'
import { CACHE_TTL, contextOf, mmss, nextTtl, planSwitch, tierOf } from './econ'
import { MODEL, route } from './route'
import type { Backend, Decision, Tier } from './route'
import type { Cache, Row } from '../types'

const LOG_FILE = 'C:/Users/tarek/.claude/arne/decisions.jsonl' // local only, never shared
const PANE = 'arne-log'
const TIER_OF: Record<string, Tier> = { haiku: 'S', sonnet: 'M', opus: 'L' }

const last = atom({ plugin: 'arne', key: 'last' } as const, null)
const log = atom({ plugin: 'arne', key: 'log' } as const, [])
const cache = atom({ plugin: 'arne', key: 'cache' } as const, null)
const clockNow = atom({ plugin: 'arne', key: 'now' } as const, 0)

// Module state. Reset on a reload, like every module variable.
let current: Decision | undefined
let prev: Decision | undefined
let baseline: string | undefined // the session model arne last saw
let paused = false
let lastResponseAt: number | undefined
let pendingSwitch: string | undefined // the model arne's own /model run is moving to
let afterCompact = false // a compact just ran: the next prompt is a cache boundary
let switchAfterTurn: string | undefined // the real /model to run once the turn is done
// Subagent decisions, by agentId, so each step of a run uses its turn's choice.
const agents = new Map<string, Decision | undefined>()

type Pin = { tier: Tier; effort: Decision['effort'] }
type Settings = { enabled: boolean; pin: Pin | null; backend: string }

async function settings($: any): Promise<Settings> {
  return {
    enabled: ((await $.store.get('enabled')) ?? true) as boolean,
    pin: ((await $.store.get('pin')) ?? null) as Pin | null,
    backend: ((await $.store.get('backend')) ?? 'haiku') as string,
  }
}

// laya-serve is started once per session when it is not already answering.
// Sessions share the one server on 127.0.0.1:8000; a second start just fails to bind.
let layaUp = false
let layaStarting = false

async function layaHealthy($: any): Promise<boolean> {
  try {
    const r = await $.http.fetch(`${LAYA_URL}/health`, { method: 'GET' })
    return r.ok
  } catch {
    return false
  }
}

// Not awaited: a spawn streams for as long as the server runs. Without laya-serve
// on PATH the spawn errors and the chain falls back to haiku.
async function startLaya($: any) {
  if (layaStarting) return
  layaStarting = true
  try {
    for await (const _ of $.process.spawn({ argv: ['laya-serve'] })) {
      // output is not read; the server logs go to its own console
    }
  } catch {
    // laya not installed, or the server exited
  } finally {
    layaStarting = false
  }
}

// $.fs has no append: read, then write the whole file. ponytail: O(n) per turn, fine below ~10k rows.
async function appendLog($: any, row: Row & { text: string; agent?: string; decided?: string }) {
  try {
    const old: string = await $.fs.read(LOG_FILE).catch(() => '')
    await $.fs.write(LOG_FILE, old + JSON.stringify(row) + '\n')
  } catch {
    // no log this time
  }
}

// A main-loop response landed: the answering model's cache is warm for one more TTL.
async function cacheTouched($: any, model: string, usage: unknown) {
  const tier = tierOf(model)
  if (!tier) return
  const now: number = await $.clock.now()
  const since = lastResponseAt === undefined ? undefined : now - lastResponseAt
  lastResponseAt = now
  await update($, cache, (c: Cache | null): Cache => {
    const ttl = nextTtl(c?.ttl ?? '5m', usage, since)
    return { ttl, C: contextOf(usage), model: tier, warmUntil: { ...c?.warmUntil, [tier]: now + CACHE_TTL[ttl] } }
  })
  await update($, clockNow, () => now)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'arne',
      description: 'Auto model and effort routing: on, off, pin, unpin, why, log, backend, debug',
    })
    // Drives the band's countdown. ponytail: a 1s state write; slow it down if redraws ever cost.
    $.clock.every(1000, async () => {
      if ((await read($, cache)) === null) return
      const now = await $.clock.now()
      await update($, clockNow, () => now)
    })
    return next(e)
  })

  // arne's own switch lands here as source "command" too, so it is told apart by its target.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    const isOwn = pendingSwitch !== undefined && tierOf(e.to_model) === tierOf(pendingSwitch)
    pendingSwitch = undefined
    if (!isOwn && (e.source === 'command' || e.source === 'picker' || e.source === 'sdk')) paused = true
    baseline = e.to_model
    return r
  })

  // /model waits for an idle session, so it runs from a timer, never inside the turn's own hooks.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const target = switchAfterTurn
    if (e.agentId === undefined && target) {
      switchAfterTurn = undefined
      $.clock.after(0, async () => {
        pendingSwitch = target
        try {
          await $.command.run({ command: 'model', args: target })
        } catch {
          pendingSwitch = undefined
          $.ui.toast(`arne: could not switch /model to ${target}`)
        }
      })
    }
    return r
  })

  on('classic.PostCompact', async ($, e, next) => {
    afterCompact = true
    return next(e)
  })

  on('command.run', { command: 'arne' }, async ($, e) => {
    const [sub, ...rest] = e.args.trim().split(/\s+/)
    const s = await settings($)

    switch (sub) {
      case 'on':
        await $.store.set('enabled', true)
        paused = false
        baseline = await $.session.model()
        return { text: 'arne on.' }
      case 'off':
        await $.store.set('enabled', false)
        return { text: 'arne off. Requests use the session model.' }
      case 'pin': {
        const tier = TIER_OF[rest[0]]
        if (!tier) return { text: 'Usage: /arne pin haiku|sonnet|opus [low|medium|high]' }
        const effort = (rest[1] ?? 'medium') as Decision['effort']
        await $.store.set('pin', { tier, effort })
        return { text: `arne pinned to ${rest[0]} · ${effort}.` }
      }
      case 'unpin':
        await $.store.delete('pin')
        return { text: 'arne unpinned.' }
      case 'backend': {
        const b = rest[0]
        if (b !== 'haiku' && b !== 'heuristic' && b !== 'laya') return { text: 'Backends: haiku, heuristic, laya.' }
        await $.store.set('backend', b)
        if (b === 'laya') {
          return {
            text: 'arne backend: laya. It needs laya-serve on PATH (Python 3.10+, the laya package, torch; git clone https://github.com/NandhaKishorM/laya and pip install -e .). Until it answers, turns fall back to haiku.',
          }
        }
        return { text: `arne backend: ${b}.` }
      }
      case 'why': {
        const l = await read($, last)
        return { text: l ? `${l.model} · ${l.effort}: ${l.reason} (${l.source})` : 'No decision yet.' }
      }
      case 'log':
        await $.ui.open({ id: PANE, title: 'arne log' })
        return { text: 'arne log opened.' }
      case 'debug': {
        const c = await read($, cache)
        const now = await $.clock.now()
        if (!c) return { text: 'arne debug: no main response yet.' }
        const warm = (['S', 'M', 'L'] as Tier[])
          .map(t => `${MODEL[t]} ${(c.warmUntil[t] ?? 0) > now ? `warm ${mmss(c.warmUntil[t]! - now)}` : 'cold'}`)
          .join(', ')
        return { text: `arne debug: ttl ${c.ttl}, C ${c.C} tokens, last ${MODEL[c.model]}. ${warm}. paused ${paused}, switch queued ${switchAfterTurn ?? pendingSwitch ?? "none"}, after compact ${afterCompact}.` }
      }
      default:
        return {
          text: `arne ${s.enabled ? 'on' : 'off'}, backend ${s.backend}${s.pin ? `, pinned ${s.pin.tier}` : ''}. Subcommands: on, off, pin, unpin, why, log, backend, debug.`,
        }
    }
  })

  on('turn.start', async ($, e, next) => {
    const s = await settings($)
    const haiku: Backend = {
      name: 'haiku',
      ask: async text => {
        const r = await $.model.complete(
          { model: 'haiku', prompt: text.slice(0, 4000), system: SYSTEM, effort: 'low' },
          { timeoutMs: 3000 },
        )
        return r.isAnswered ? parseVerdict(r.text) : undefined
      },
    }
    const laya: Backend = {
      name: 'laya',
      ask: async text => {
        const r = await $.http.fetch(`${LAYA_URL}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: layaBody(text),
        })
        return r.ok ? layaVerdict(JSON.parse(r.text).answers) : undefined
      },
    }
    // laya -> haiku -> prev -> default. The chain falls through silently.
    const backends =
      s.backend === 'laya' ? [laya, haiku] : s.backend === 'haiku' ? [haiku] : []
    if (s.backend === 'laya' && e.agentId === undefined && !layaUp) {
      layaUp = await layaHealthy($)
      if (!layaUp) void startLaya($)
    }

    if (e.agentId === undefined) {
      const model = await $.session.model()
      // A model the user set by hand (/model) pauses arne. classic.PostModelSwitch catches it at once;
      // this diff is the fallback, skipped while arne's own switch is still landing.
      if (baseline !== undefined && model !== baseline && !pendingSwitch) paused = true
      baseline ??= model

      const decided = s.enabled
        ? await route(e.text, { prev, paused, pin: s.pin ?? undefined, backends })
        : undefined
      if (decided) prev = decided
      current = decided
      const chat = tierOf(model)
      if (decided && chat) {
        const c = await read($, cache)
        const plan = planSwitch({
          decided: decided.tier,
          chat,
          C: c?.C ?? 0,
          warmUntil: c?.warmUntil ?? {},
          now: await $.clock.now(),
          afterCompact,
        })
        // A pin is the person's call: it skips stickiness, but the real /model still waits for a boundary.
        if (plan.why === 'sticky' && decided.source !== 'pin') {
          current = { ...decided, tier: chat, reason: `${decided.reason}; sticky (cache warm)` }
        }
        // This turn's requests already go to the new tier; the real /model follows once the turn ends.
        if (plan.real) {
          afterCompact = false
          switchAfterTurn = MODEL[decided.tier]
        }
      }
      $.ui.status(!s.enabled ? 'arne off' : paused ? 'arne paused (manual /model)' : undefined)
      if (current) {
        const row: Row = {
          key: e.turnId,
          model: MODEL[current.tier],
          effort: current.effort,
          reason: current.reason,
          source: current.source,
          out: 0,
          cacheRead: 0,
        }
        await update($, last, () => row)
        await update($, log, list => [...list, row].slice(-200))
        await appendLog($, { ...row, text: e.text, decided: decided ? MODEL[decided.tier] : undefined })
      }
    } else {
      const agent = (await $.agent.list()).find(a => a.id === e.agentId)
      const d = await route(e.text, { agentType: agent?.type, backends })
      agents.set(e.agentId, d)
      if (d) {
        const row: Row = { key: `${e.turnId}:${e.agentId}`, model: MODEL[d.tier], effort: d.effort, reason: d.reason, source: d.source, out: 0, cacheRead: 0 }
        await appendLog($, { ...row, text: e.text, agent: agent?.type })
      }
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const decision = isMain ? current : agents.get(e.agentId!)

    // Haiku takes no effort setting.
    const routed = decision
      ? { ...e, model: MODEL[decision.tier], effort: decision.tier === 'S' ? undefined : decision.effort }
      : e
    if (isMain && decision) $.ui.status(`arne ${decision.source} · ${routed.model} · ${routed.effort ?? '-'}`)

    const r = yield* next(routed)
    if (isMain) await cacheTouched($, routed.model, r.usage)
    if (!decision) return r

    const key = isMain ? e.turnId : `${e.turnId}:${e.agentId}`
    const out = r.usage?.output_tokens ?? 0
    const cacheRead = r.usage?.cache_read_input_tokens ?? 0
    const bump = (row: Row): Row =>
      row.key === key ? { ...row, out: row.out + out, cacheRead: row.cacheRead + cacheRead } : row
    await update($, log, list => list.map(bump))
    await update($, last, row => (row ? bump(row) : row))

    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, last)
    const c = await read($, cache)
    if (!l && !c) return next(e)
    const now = await read($, clockNow)
    const left = c ? (c.warmUntil[c.model] ?? 0) - now : 0
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>
          arne: {l ? `${l.model} · ${l.effort} (${l.source})` : 'not routing'}
          {c ? ` · cache ${left > 0 ? mmss(left) : 'cold'} · ${Math.round(c.C / 1000)}k` : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, log)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No decisions yet.</Text>}
        {rows.slice(-room).map(r => (
          <Text key={r.key} dimColor>
            {r.model} · {r.effort} · {r.source} · out {r.out} · cache {r.cacheRead} · {r.reason}
          </Text>
        ))}
      </Box>
    )
  })
}
