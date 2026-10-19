import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { LAYA_URL, layaBody, layaVerdict, parseVerdict, SYSTEM } from './backends'
import { bandText, CACHE_TTL, clampEffort, clampTier, coldAdvice, contextOf, dollars, midTask, mmss, nextTtl, planSwitch, shortModel, summaryPrompt, tierOf } from './econ'
import type { BandState } from './econ'
import { MODEL, route } from './route'
import type { Backend, Decision, Tier } from './route'
import type { Cache, Row } from '../types'

const LOG_FILE = '.claude/arne/decisions.jsonl' // under the home directory; local only, never shared

// A path under the home directory, read at runtime; an absolute path (the bench sets one) stays as it is.
async function homePath($: any, p: string): Promise<string> {
  if (/^([A-Za-z]:)?\//.test(p)) return p
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home ? `${home.replace(/\\/g, '/').replace(/\/$/, '')}/${p}` : p
}

const PANE = 'arne-log'
const SETTINGS = 'arne-settings'

// What each row cycles through in the ⚙ pane: options for a string, a step for a number, a flip for a boolean.
const CHOICES: Partial<Record<keyof Live, unknown[]>> = {
  backend: ['haiku', 'heuristic', 'laya'],
  modelFloor: ['haiku', 'sonnet', 'opus'],
  modelCeiling: ['haiku', 'sonnet', 'opus'],
  effortFloor: ['low', 'medium', 'high'],
  effortCeiling: ['low', 'medium', 'high'],
  compactModel: ['haiku', 'sonnet'],
}
const STEP: Partial<Record<keyof Live, number[]>> = {
  coldTokens: [15_000, 30_000, 60_000],
  heavyTokens: [100_000, 150_000, 200_000],
}
const nextOf = <T,>(list: T[], v: T): T => list[(list.indexOf(v) + 1) % list.length]
const TIER_OF: Record<string, Tier> = { haiku: 'S', sonnet: 'M', opus: 'L' }

const last = atom({ plugin: 'arne', key: 'last' } as const, null)
const log = atom({ plugin: 'arne', key: 'log' } as const, [])
const cache = atom({ plugin: 'arne', key: 'cache' } as const, null)
const clockNow = atom({ plugin: 'arne', key: 'now' } as const, 0)
const coldDismissed = atom({ plugin: 'arne', key: 'coldDismissed' } as const, 0)
const routing = atom({ plugin: 'arne', key: 'routing' } as const, false)
const isOff = atom({ plugin: 'arne', key: 'isOff' } as const, false)
// True after the person picked a model by hand (/model or the picker). One of the two inputs to mode().
const isPaused = atom({ plugin: 'arne', key: 'isPaused' } as const, false)
// The effort the app sends when arne leaves it alone: what the band shows while paused or off.
const appEffort = atom({ plugin: 'arne', key: 'appEffort' } as const, null)
// The session's real model, as state so the band redraws when it changes ($.session.model() alone would not).
const sessionModel = atom({ plugin: 'arne', key: 'sessionModel' } as const, null)
const held = atom({ plugin: 'arne', key: 'held' } as const, null)
// True while effortless is enabled: it writes effort, so arne routes models only.
const effortless = atom({ plugin: 'arne', key: 'effortless' } as const, false)
const EFFORTLESS = 'effortless@effortless'
const SETTINGS_FILE = '.claude/settings.json' // under the home directory, same as LOG_FILE
const shown = atom({ plugin: 'arne', key: 'shown' } as const, null)
// The band's two expandable parts: the last decision's reason (why) and the cache's cold advice.
const whyOpen = atom({ plugin: 'arne', key: 'whyOpen' } as const, false)
const cacheOpen = atom({ plugin: 'arne', key: 'cacheOpen' } as const, false)
const TIER_NAME_OF: Record<Tier, string> = { S: 'haiku', M: 'sonnet', L: 'opus' }
const STATES: BandState[] = ['routing', 'off', 'paused', 'cold', 'heavy', 'normal']

const rowLabel = (row: { action: string; to?: string }) =>
  row.action === 'switch' ? `Switch to ${row.to}` : row.action === 'compact' ? 'Compact (Haiku summary)' : row.action === 'handoff' ? 'Handoff' : 'Continue'

// /compact runs as the app's own command, so the idle wait and the app's own summary path apply.
async function effortlessOn($: any): Promise<boolean> {
  const text: string = await $.fs.read(await homePath($, SETTINGS_FILE)).catch(() => '')
  try {
    return JSON.parse(text).enabledPlugins?.[EFFORTLESS] === true
  } catch {
    return false
  }
}

// The state flips only at the next session start: effortless's hooks stay loaded until then.
async function disableEffortless($: any) {
  const r = await $.process.run(['claude', 'plugin', 'disable', EFFORTLESS], { timeoutMs: 60_000 }).catch(() => undefined)
  $.ui.toast(r?.exitCode === 0 ? 'arne: effortless disabled. Restart to hand effort to arne.' : 'arne: could not disable effortless; disable it from the plugin list.')
}

async function compactNow($: any, note: string): Promise<boolean> {
  try {
    await $.command.run({ command: 'compact', args: note.trim() })
    return true
  } catch {
    $.ui.toast('arne: compact failed; try again when the session is idle')
    return false
  }
}

// --- The held prompt (step 17a) ---
// A prompt typed on a cold, big chat waits here until the person picks Compact & send or Send anyway.
const CONTINUE_TEXT = 'Continue where you left off.'
let compactSending = false // a Compact & send is running: its compaction must not also send "Continue"
let lastReason: string | undefined // how the last main turn ended

// Sends a prompt as the person's own words. A plugin's own $.prompt.submit skips that plugin's
// prompt.submit hooks (seen in the test kit), so it is never held again and never routed there.
async function sendAsUser($: any, text: string) {
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch {
    $.ui.toast('arne: could not send your message; it is back in the prompt box')
    await $.prompt.fill({ text, mode: 'replace' }).catch(() => undefined)
  }
}

async function compactAndSend($: any) {
  const text = await read($, held)
  if (!text || compactSending) return
  await update($, held, () => null) // cleared first: a second click finds nothing to send
  compactSending = true
  const ok = await compactNow($, '').finally(() => (compactSending = false))
  if (ok) await routeAndSend($, text)
  else await update($, held, () => text)
}

async function sendAnyway($: any) {
  const text = await read($, held)
  if (!text) return
  await update($, held, () => null)
  await routeAndSend($, text)
}


// Module state. Reset on a reload, like every module variable.
let current: Decision | undefined
let prev: Decision | undefined
// The session model arne expects: the one it last switched to, or last saw. A switch to another tier is the person's.
let expected: string | undefined
let switching = false // arne's own /model is queued or running: the session model may still be the old one
let lastResponseAt: number | undefined
let afterCompact = false // a compact just ran: the next prompt is a cache boundary
// Decisions made at prompt.submit, by text, for the turn.start of the same prompt.
const planned = new Map<string, Decision>()
// Subagent decisions, by agentId, so each step of a run uses its turn's choice.
const agents = new Map<string, Decision | undefined>()

// The band's pickers pin a tier, an effort, or both; the part left out is arne's to decide.
type Pin = { tier?: Tier; effort?: Decision['effort'] }
type Settings = { enabled: boolean; pin: Pin | null; backend: string }

// The userConfig values, as the engine holds them. /config and the ⚙ pane both write through
// $.config.set, which lands in the config.set hook below and keeps this copy in step.
type Live = {
  auto: boolean
  backend: string
  modelFloor: string
  modelCeiling: string
  effortFloor: string
  effortCeiling: string
  compactModel: string
  coldTokens: number
  heavyTokens: number
  continueAfterCompact: boolean
}
const DEFAULTS: Live = {
  auto: true,
  backend: 'haiku',
  modelFloor: 'haiku',
  modelCeiling: 'opus',
  effortFloor: 'low',
  effortCeiling: 'high',
  compactModel: 'haiku',
  coldTokens: 30_000,
  heavyTokens: 150_000,
  continueAfterCompact: true,
}
let live: Live = { ...DEFAULTS }
const FIELDS = Object.keys(DEFAULTS) as (keyof Live)[]

// The cold offer applies: the chat model's cache is cold, the chat is past coldTokens, and this cold
// spell was not dismissed. Right after a compact the cache numbers are stale, so no offer.
async function coldOffer($: any, now: number) {
  const c: Cache | null = await read($, cache)
  if (!c || afterCompact) return undefined
  const until = c.warmUntil[c.model] ?? 0
  if (until > now || c.C < live.coldTokens) return undefined
  if ((await read($, coldDismissed)) === until) return undefined
  return { c, ...coldAdvice(c.C, c.model, c.warmUntil, now) }
}

// The one on/off answer every surface reads: the /arne reply, the band, the status line and the pane.
type Mode = 'off' | 'paused' | 'on'
// Reads atoms, not `live`, so every surface that asks redraws when the answer changes.
async function modeOf($: any): Promise<Mode> {
  return (await read($, isOff)) ? 'off' : (await read($, isPaused)) ? 'paused' : 'on'
}

// Clears a pause: the session's model is now the one arne expects.
async function resume($: any) {
  await update($, isPaused, () => false)
  expected = await $.session.model()
}

// The band's Auto button: on turns off, off or paused turns on (a pause resumes).
async function toggleAuto($: any) {
  const mode = await modeOf($)
  await $.config.set({ key: 'arne.auto', value: mode !== 'on' })
  if (mode !== 'on') await resume($)
  await showStatus($)
}

// Sets one part of the pin and keeps the other; a pin with neither part left is removed. A pin ends a pause.
async function setPinPart($: any, part: Pin) {
  const next: Pin = { ...((await settings($)).pin ?? {}), ...part }
  if (next.tier === undefined) delete next.tier
  if (next.effort === undefined) delete next.effort
  if (next.tier || next.effort) await $.store.set('pin', next)
  else await $.store.delete('pin')
  await resume($)
  await showStatus($)
}

// The real /model moves now, marked as arne's own so PostModelSwitch does not pause arne.
async function moveModel($: any, target: string) {
  const was = expected
  expected = target
  switching = true
  try {
    await $.command.run({ command: 'model', args: target })
  } catch {
    expected = was
    $.ui.toast(`arne: could not switch /model to ${shortModel(target)}`)
  } finally {
    switching = false
  }
}

// Reason and tokens of the last main decision, for the band's why row and its hover card.
function whyText(l: Row | null, pinned: boolean) {
  if (!l) return 'No decision yet.'
  return `${pinned ? 'You pinned it. ' : ''}${shortModel(l.model)} · ${l.effort}: ${l.reason} (${l.source}) · out ${l.out} tokens`
}

// 👍 / 👎 on the last decision: a correction label for the classifier, written beside the log rows.
async function feedback($: any, verdict: 'up' | 'down') {
  const l = await read($, last)
  if (!l) return
  try {
    const old: string = await $.fs.read(await homePath($, LOG_FILE)).catch(() => '')
    await $.fs.write(await homePath($, LOG_FILE), old + JSON.stringify({ type: 'feedback', key: l.key, verdict, model: l.model, effort: l.effort, reason: l.reason, source: l.source }) + '\n')
    $.ui.toast(`arne: noted ${verdict === 'up' ? '👍' : '👎'} for the last decision`)
  } catch {
    $.ui.toast('arne: could not log that feedback')
  }
}

async function showStatus($: any) {
  $.ui.status(statusOf(await modeOf($), await $.session.model()))
}

// The status line: the footer already names the plugin, so no "arne" here.
const statusOf = (mode: Mode, model: string) =>
  mode === 'on' ? undefined : bandText({ off: mode === 'off', paused: mode === 'paused', routing: false, model, warmLeftMs: 0, C: 0 }).short

async function settings($: any): Promise<Settings> {
  return {
    enabled: live.auto,
    pin: ((await $.store.get('pin')) ?? null) as Pin | null,
    backend: live.backend,
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

// laya -> haiku -> prev -> default. The chain falls through silently.
function backendsOf($: any, backend: string): Backend[] {
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
  return backend === 'laya' ? [laya, haiku] : backend === 'haiku' ? [haiku] : []
}

// The main loop's decision for one prompt, inside the floor and ceiling (pins included).
async function decideMain($: any, text: string): Promise<Decision | undefined> {
  const s = await settings($)
  if (!s.enabled) return undefined
  if (s.backend === 'laya' && !layaUp) {
    layaUp = await layaHealthy($)
    if (!layaUp) void startLaya($)
  }
  // A hard pin (tier and effort) skips routing; a partial pin keeps routing for the part it leaves out.
  const pin = s.pin ?? undefined
  const hard = pin?.tier && pin.effort ? { tier: pin.tier, effort: pin.effort } : undefined
  const r = await route(text, { prev, paused: await read($, isPaused), pin: hard, backends: backendsOf($, s.backend) })
  if (!r) return undefined
  const d = {
    ...r,
    tier: clampTier(pin?.tier ?? r.tier, live.modelFloor, live.modelCeiling),
    effort: clampEffort(pin?.effort ?? r.effort, live.effortFloor, live.effortCeiling),
    // Only a model pin is a pin for switching: it moves the real /model like any pin did.
    source: pin?.tier ? 'pin' : r.source,
  }
  prev = d
  return d
}

// The model the real /model should move to before this prompt, or undefined to stay.
// A pin always moves; otherwise only where planSwitch says moving pays (a cache boundary, or worth it).
async function switchTarget($: any, d: Decision): Promise<string | undefined> {
  const chat = tierOf(await $.session.model())
  if (!chat || d.tier === chat) return undefined
  if (d.source === 'pin') return MODEL[d.tier]
  const c: Cache | null = await read($, cache)
  const plan = planSwitch({ decided: d.tier, chat, C: c?.C ?? 0, warmUntil: c?.warmUntil ?? {}, now: await $.clock.now(), afterCompact })
  return plan.why === 'sticky' ? undefined : MODEL[d.tier]
}

// Runs the real /model, then sends the dropped prompt once, whether or not the switch worked.
async function switchThenSend($: any, target: string, text: string) {
  // The person may have picked a model while this waited: theirs stands.
  if ((await modeOf($)) === 'on') {
    const was = expected
    expected = target
    switching = true
    try {
      await $.command.run({ command: 'model', args: target })
    } catch {
      expected = was
      planned.delete(text) // decided for a model it is not on: turn.start decides again
      $.ui.toast(`arne: could not switch /model to ${shortModel(target)}; sending on the current model`)
    } finally {
      switching = false
    }
  }
  await sendAsUser($, text)
}

// A prompt arne sends for the person (a released hold, a continue) gets the typed prompt's treatment
// here, since prompt.submit will not see it: decided, and the real /model moved first when it should.
async function routeAndSend($: any, text: string) {
  const d = await decideMain($, text)
  if (d) planned.set(text, d)
  const target = d && (await switchTarget($, d))
  if (target) await switchThenSend($, target, text)
  else await sendAsUser($, text)
}

// $.fs has no append: read, then write the whole file. ponytail: O(n) per turn, fine below ~10k rows.
async function appendLog($: any, row: Row & { text: string; agent?: string; decided?: string }) {
  try {
    const old: string = await $.fs.read(await homePath($, LOG_FILE)).catch(() => '')
    await $.fs.write(await homePath($, LOG_FILE), old + JSON.stringify(row) + '\n')
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
  afterCompact = false // the cache numbers below are fresh again
  await update($, cache, (c: Cache | null): Cache => {
    const ttl = nextTtl(c?.ttl ?? '5m', usage, since)
    return { ttl, C: contextOf(usage), model: tier, warmUntil: { ...c?.warmUntil, [tier]: now + CACHE_TTL[ttl] } }
  })
  await update($, clockNow, () => now)
}

export const register: Register = (on, options) => {
  live = { ...DEFAULTS, ...(options as Partial<Live>) }

  // Every write to an arne.* row lands here, from /config or the ⚙ pane alike.
  on('config.set', async ($, e, next) => {
    const r = await next(e)
    const field = e.key.startsWith('arne.') ? (e.key.slice(5) as keyof Live) : undefined
    if (field && FIELDS.includes(field) && !('deny' in r)) {
      ;(live as Record<string, unknown>)[field] = r.value
      if (field === 'auto') {
        await update($, isOff, () => !r.value)
        // Turning it on, from /config, the pane or /arne on, is the person's go-ahead: clear any pause.
        if (r.value) await resume($)
        await showStatus($)
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'arne',
      description: 'Auto model and effort routing: on, off, pin, unpin, why, log, backend, debug',
    })
    const eff = await effortlessOn($)
    await update($, effortless, () => eff)
    await update($, isOff, () => !live.auto)
    // Drives the band's countdown. ponytail: a 1s state write; slow it down if redraws ever cost.
    $.clock.every(1000, async () => {
      if ((await read($, cache)) === null) return
      const now = await $.clock.now()
      await update($, clockNow, () => now)
    })
    return next(e)
  })

  // arne's own switch lands here as source "command" too, so it is told apart by its tier: arne sets
  // `expected` before it runs /model, and a repeat event for the same switch still matches.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    // ponytail: a manual pick of the tier arne already expects reads as arne's own and does not pause;
    // tell them apart by origin if command.run ever carries one for /model.
    const isOwn = expected !== undefined && tierOf(e.to_model) === tierOf(expected)
    const byHand = e.source === 'command' || e.source === 'picker' || e.source === 'sdk'
    if (!isOwn && byHand && !(await read($, isOff))) await update($, isPaused, () => true)
    expected = e.to_model
    await update($, sessionModel, () => e.to_model)
    await showStatus($)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) lastReason = e.reason
    return r
  })

  // Haiku writes the summary for every compaction. If Haiku fails, the engine's own compaction stands.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.messages.length < 4) return next(e)
    try {
      const r = await $.model.complete(
        {
          model: live.compactModel,
          prompt: summaryPrompt(e.messages),
          system: 'Summarize this coding conversation for its next turn: goal, decisions and why, files changed (paths), exact errors, open questions, next step. Plain text, under 1500 words.' + (e.instructions ? ` Keep: ${e.instructions}` : ''),
          effort: 'low',
        },
        { timeoutMs: 120_000 },
      )
      if (!r.isAnswered || !r.text) return next(e)
      const kept = e.messages.slice(-4)
      return {
        messages: [
          { role: 'user', text: `Summary of the conversation so far (written by Haiku for arne):\n\n${r.text}`, toolUses: [] },
          ...kept,
        ],
      }
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  // A plain /compact (or Compact with nothing held) picks the work back up, once, if it stopped mid-task.
  // Compact & send skips this: its own held prompt is the one message that goes.
  on('classic.PostCompact', async ($, e, next) => {
    afterCompact = true
    const r = await next(e)
    if (e.trigger === 'manual' && !compactSending && live.continueAfterCompact && !(await read($, held)) && midTask(lastReason, e.compact_summary)) {
      $.clock.after(0, () => routeAndSend($, CONTINUE_TEXT))
    }
    return r
  }).catch(($, e, next) => next(e))

  // A typed prompt is decided here, before its turn exists. On a cold, big chat it is held (17a). When
  // the decision moves the model, the prompt is dropped, the real /model runs, and the prompt is sent
  // again (17c): Claude's own picker then always shows the model the request runs on.
  on('prompt.submit', async ($, e, next) => {
    const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    // Left alone: commands, prompts typed into a running turn, and attachments (a resubmit would lose them).
    if (!typed || e.command || e.isMeta || e.turnId !== undefined || e.attachments?.length) return next(e)
    if ((await modeOf($)) !== 'on') return next(e)
    if (!(await read($, held)) && (await coldOffer($, await $.clock.now()))) {
      await update($, held, () => e.text)
      return { drop: 'arne is holding your message: the cache is cold. Pick Compact & send or Send anyway above the prompt.' }
    }
    await update($, routing, () => true)
    const d = await decideMain($, e.text).finally(() => update($, routing, () => false))
    if (d) planned.set(e.text, d)
    const target = d && (await switchTarget($, d))
    if (!target) return next(e)
    $.clock.after(0, () => switchThenSend($, target, e.text))
    return { drop: `arne: switching to ${shortModel(target)} first; your message follows.` }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'arne' }, async ($, e) => {
    const [sub, ...rest] = e.args.trim().split(/\s+/)
    const s = await settings($)

    switch (sub) {
      case 'on':
        await $.config.set({ key: 'arne.auto', value: true })
        await resume($)
        await showStatus($)
        return { text: 'arne on.' }
      case 'off':
        await $.config.set({ key: 'arne.auto', value: false })
        await showStatus($)
        return { text: 'arne off. Requests use the session model.' }
      case 'settings':
        await $.ui.open({ id: SETTINGS, title: 'arne settings' })
        return { text: 'arne settings opened. Changes here match /config.' }
      case 'pin': {
        const tier = TIER_OF[rest[0]]
        if (!tier) return { text: 'Usage: /arne pin haiku|sonnet|opus [low|medium|high]' }
        const effort = (rest[1] ?? 'medium') as Decision['effort']
        await $.store.set('pin', { tier, effort })
        // A pin is the person's pick made through arne: it ends a pause, so every surface shows the pin.
        await resume($)
        await showStatus($)
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
      case 'show': {
        // Draws the band in one state for a few seconds, to check each look without a real trigger.
        const state = rest[0] as BandState
        if (rest[0] === 'live') {
          await update($, shown, () => null)
          return { text: 'Band shows the live state.' }
        }
        if (!STATES.includes(state)) return { text: `Usage: /arne show live|${STATES.join('|')}` }
        await update($, shown, () => ({ state, until: 0 }))
        return { text: `Band shows a sample ${state} state. /arne show live goes back.` }
      }
      case 'debug': {
        const c = await read($, cache)
        const now = await $.clock.now()
        if (!c) return { text: 'arne debug: no main response yet.' }
        const warm = (['S', 'M', 'L'] as Tier[])
          .map(t => `${MODEL[t]} ${(c.warmUntil[t] ?? 0) > now ? `warm ${mmss(c.warmUntil[t]! - now)}` : 'cold'}`)
          .join(', ')
        return { text: `arne debug: ${await modeOf($)}, ttl ${c.ttl}, C ${c.C} tokens, last ${MODEL[c.model]}. ${warm}. expected ${expected ?? 'none'}, switching ${switching}, after compact ${afterCompact}.` }
      }
      default: {
        const mode = await modeOf($)
        const state = mode === 'paused' ? 'paused (you picked a model; /arne on resumes)' : mode
        return {
          text: `arne ${state}, backend ${s.backend}${s.pin ? `, pinned ${[s.pin.tier && TIER_NAME_OF[s.pin.tier], s.pin.effort].filter(Boolean).join(' · ')}` : ''}. Subcommands: on, off, pin, unpin, why, log, backend, debug.`,
        }
      }
    }
  })

  on('turn.start', async ($, e, next) => {
    const s = await settings($)
    if (e.agentId === undefined) await update($, isOff, () => !s.enabled)

    if (e.agentId === undefined) {
      const model = await $.session.model()
      // A model the user set by hand (/model) pauses arne. classic.PostModelSwitch catches it at once;
      // this is the fallback. By tier: the same model can come back as an alias or a full id.
      // Skipped while arne's own switch waits: the session is still on the old model then.
      if (expected !== undefined && !switching && tierOf(model) !== tierOf(expected) && s.enabled) await update($, isPaused, () => true)
      expected ??= model
      await update($, sessionModel, () => model)

      // Decided at prompt.submit for a typed prompt; anything else (a notification, a prompt typed
      // mid-turn) is decided here, but its model can no longer move.
      let decided = planned.get(e.text)
      planned.delete(e.text)
      if (!decided) {
        await update($, routing, () => true)
        decided = await decideMain($, e.text).finally(() => update($, routing, () => false))
      }
      // The request runs on the session's model, so the log and band say that model, with the reason.
      const chat = tierOf(model)
      current =
        decided && chat && decided.tier !== chat
          ? { ...decided, tier: chat, reason: `${decided.reason}; stays on ${shortModel(model)} (cache warm, or mid-turn)` }
          : decided
      $.ui.status(statusOf(await modeOf($), model))
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
      const d = await route(e.text, { agentType: agent?.type, backends: backendsOf($, s.backend) })
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

    // Haiku takes no effort setting. While effortless is on, it keeps the effort it set.
    const effortOwned = await read($, effortless)
    // `e` is the app's own request, before arne touches it: its effort is what the native control says.
    if (isMain && (e.effort ?? null) !== (await read($, appEffort))) await update($, appEffort, () => e.effort ?? null)
    // The main loop keeps the session's model (17c: no silent rewrite; the real /model moved it, or it
    // stays). Subagents still get their model per request, since the picker cannot show them.
    const model = decision && !isMain ? MODEL[decision.tier] : e.model
    const routed = decision
      ? { ...e, model, effort: effortOwned ? e.effort : tierOf(model) === 'S' ? undefined : decision.effort }
      : e
    if (isMain && decision) {
      const c = await read($, cache)
      const now = await $.clock.now()
      const tier = tierOf(routed.model)
      const warmLeftMs = tier ? (c?.warmUntil[tier] ?? 0) - now : 0
      $.ui.status(bandText({ off: false, paused: false, routing: false, model: routed.model, effort: decision.effort, warmLeftMs, C: c?.C ?? 0 }).short)
    }

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
    const forced = await read($, shown)
    // The band always draws, so the pickers are there before the first request too.
    const now = await read($, clockNow)
    const tier = c ? c.model : undefined
    const left = c && tier ? (c.warmUntil[tier] ?? 0) - now : 0
    const { Box, Button, Select, Text } = $.ui.resolve(e)
    // A cold chat under coldTokens is cheap to re-warm: no offer. A dismissal lasts until the cache warms again.
    const heldText = await read($, held)
    const pin = (await settings($)).pin
    const whyIsOpen = await read($, whyOpen)
    const cacheIsOpen = await read($, cacheOpen)
    const offer = await coldOffer($, now)
    // The held prompt's two ways out, priced: the compact row and the plain re-warm.
    const priced = (a: 'compact' | 'continue') => {
      const row = offer?.rows.find(x => x.action === a)
      return row ? ` · $${dollars(row.first).toFixed(3)}` : ''
    }
    const effortOn = await read($, effortless)
    const sample: Record<BandState, Parameters<typeof bandText>[0]> = {
      routing: { off: false, paused: false, routing: true, model: 'claude-sonnet-5-5', effort: 'medium', warmLeftMs: 0, C: 0 },
      off: { off: true, paused: false, routing: false, model: 'claude-sonnet-5-5', warmLeftMs: 0, C: 0 },
      paused: { off: false, paused: true, routing: false, model: 'claude-opus-5-5', effort: 'high', warmLeftMs: 0, C: 0 },
      cold: { off: false, paused: false, routing: false, model: 'claude-opus-5-5', effort: 'high', warmLeftMs: 0, C: 120_000 },
      heavy: { off: false, paused: false, routing: false, model: 'claude-opus-5-5', effort: 'high', warmLeftMs: 600_000, C: 160_000 },
      normal: { off: false, paused: false, routing: false, model: 'claude-sonnet-5-5', effort: 'medium', warmLeftMs: 38 * 60_000, C: 80_000 },
    }
    // Paused or off, arne sends nothing of its own: show what the app runs, never the last decision.
    const mode = await modeOf($)
    const appModel = mode === 'on' ? undefined : ((await read($, sessionModel)) ?? undefined)
    const band = forced
      ? bandText(sample[forced.state as BandState])
      : bandText({
          off: mode === 'off',
          paused: mode === 'paused',
          routing: await read($, routing),
          model: appModel ?? (l ? l.model : (c ? MODEL[c.model] : MODEL.M)),
          effort: mode === 'on' ? l?.effort : ((await read($, appEffort)) ?? undefined),
          warmLeftMs: left,
          C: c?.C ?? 0,
          heavyTokens: live.heavyTokens,
        })
    // The resting line: every part clickable. Hover on a picker shows its reason, as a card over the line.
    // The Auto label stays short so the row does not shift between states; a pause explains itself on the alert line above.
    const autoLabel = mode === 'on' ? '● Auto' : mode === 'off' ? '○ Auto' : '⏸ Resume'
    const card = (key: string) => (
      <Box key={`card-${key}`} position="absolute" top={1} left={0} display="none" hover={{ display: 'flex', scope: 'arne-pick' }}>
        <Text>{whyText(l, Boolean(pin))}</Text>
      </Box>
    )
    const cacheLabel = `${left > 0 && left < 5 * 60_000 ? '⚠ ' : ''}cache ${left > 0 ? mmss(left) : 'cold'}`
    const costRows = cacheIsOpen && c ? coldAdvice(c.C, c.model, c.warmUntil, now).rows : []
    return (
      <Box flexDirection="column">
        {(band.state === 'cold' || band.state === 'heavy' || band.state === 'paused' || band.state === 'off') && (
          <Text dimColor>arne: {band.text}</Text>
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="auto" variant={mode === 'paused' ? 'primary' : 'secondary'} label={autoLabel} onPress={() => toggleAuto($)} />
          <Box key="pick-model" hover={{ scope: 'arne-pick' }}>
            <Select
              key="model"
              label={pin?.tier ? '📌' : ''}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'haiku', label: 'Haiku' },
                { value: 'sonnet', label: 'Sonnet' },
                { value: 'opus', label: 'Opus' },
              ]}
              value={pin?.tier ? TIER_NAME_OF[pin.tier] : 'auto'}
              onSelect={(value: string) => {
                const tier = TIER_OF[value]
                void setPinPart($, { tier }).then(() => (tier ? moveModel($, MODEL[tier]) : undefined))
              }}
            />
            {card('model')}
          </Box>
          <Box key="pick-effort" hover={{ scope: 'arne-pick' }}>
            <Select
              key="effort"
              label={pin?.effort ? '📌' : ''}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
              ]}
              value={pin?.effort ?? 'auto'}
              onSelect={(value: string) => void setPinPart($, { effort: value === 'auto' ? undefined : (value as Pin['effort']) })}
            />
            {card('effort')}
          </Box>
          <Button key="cache" label={cacheLabel} onPress={() => update($, cacheOpen, o => !o)} />
          <Button key="why" label={whyIsOpen ? 'why ▴' : 'why ▾'} onPress={() => update($, whyOpen, o => !o)} />
          <Button key="gear" label="⚙" onPress={() => $.ui.open({ id: SETTINGS, title: 'arne settings' })} />
        </Box>
        {whyIsOpen && (
          <Box flexDirection="column">
            <Text dimColor>{whyText(l, Boolean(pin))}</Text>
            <Box gap={1}>
              <Button key="up" label="👍" onPress={() => feedback($, 'up')} />
              <Button key="down" label="👎" onPress={() => feedback($, 'down')} />
            </Box>
          </Box>
        )}
        {costRows.length > 0 && (
          <Box flexDirection="column">
            {costRows.slice(0, 3).map(row => (
              <Text key={`cost-${row.action}-${row.to ?? ''}`} dimColor>
                {rowLabel(row)}: ${dollars(row.first).toFixed(3)}
              </Text>
            ))}
          </Box>
        )}
        {effortOn && (
          <Box flexDirection="column">
            <Text>effortless is on and sets effort too. Disable it, then restart, so arne can.</Text>
            <Button label="Disable effortless" onPress={() => disableEffortless($)} />
          </Box>
        )}
        {heldText && (
          <Box flexDirection="column">
            <Text>Your message is held: the cache is cold, so compacting first costs less.</Text>
            <Box>
              <Button key="compact-send" variant="primary" label={`Compact & send${priced('compact')}`} onPress={() => compactAndSend($)} />
              <Button key="send-anyway" variant="secondary" label={`Send anyway${priced('continue')}`} onPress={() => sendAnyway($)} />
            </Box>
          </Box>
        )}
        {offer && !heldText && (
          <Box flexDirection="column">
            <Text>Cache is cold on a {Math.round(offer.c.C / 1000)}k chat. Next message, by cost (first request):</Text>
            {offer.rows.slice(0, 3).map(row => (
              <Text key={`${row.action}-${row.to ?? ''}`} dimColor>
                {rowLabel(row)}: ${dollars(row.first).toFixed(3)}
              </Text>
            ))}
            <Box>
              <Button
                key="compact"
                label={offer.best.action === 'compact' ? 'Compact (cheapest)' : 'Compact'}
                onPress={() => compactNow($, '')}
              />
              <Button
                key="continue"
                label="Continue"
                onPress={() => update($, coldDismissed, () => offer.c.warmUntil[offer.c.model] ?? 0)}
              />
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  // The ⚙ pane: each row cycles its value through $.config.set, so /config and the pane never disagree.
  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const set = (key: keyof Live, value: unknown) => () => $.config.set({ key: `arne.${key}`, value })
    const mode = await modeOf($)
    return (
      <Box flexDirection="column">
        <Button label={`Auto routing: ${mode}`} onPress={set('auto', mode !== 'on')} />
        {(Object.keys(CHOICES) as (keyof Live)[]).map(k => (
          <Button key={k} label={`${k}: ${String(live[k])}`} onPress={set(k, nextOf(CHOICES[k]!, live[k]))} />
        ))}
        {(Object.keys(STEP) as (keyof Live)[]).map(k => (
          <Button key={k} label={`${k}: ${live[k].toLocaleString('en-US')}`} onPress={set(k, nextOf(STEP[k]!, live[k]))} />
        ))}
        <Button label={`Continue after /compact: ${live.continueAfterCompact ? 'on' : 'off'}`} onPress={set('continueAfterCompact', !live.continueAfterCompact)} />
        <Text dimColor>Each press moves one step. The same values live in /config.</Text>
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
