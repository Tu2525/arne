import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { LAYA_URL, layaBody, layaVerdict, parseVerdict, SYSTEM } from './backends'
import { bandText, CACHE_TTL, clampEffort, clampTier, coldAdvice, contextOf, costCompact, costContinue, dollars, EFFORT_LABEL, EFFORT_LABEL_SHORT, EFFORT_RANK, fillOf, fitRest, fitTier, midTask, mmss, nextTtl, overTurns, paysOffAfter, plainReason, planSwitch, shortModel, summaryPrompt, tierOf, PRICE, OUT, READ } from './econ'
import type { BandState, Row as CostRow } from './econ'
import { MODEL, route } from './route'
import type { Backend, Decision, Tier } from './route'
import { parseUsage, periodStart, PERIODS, savedText, summarize, usageRow } from './stats'
import type { Period, UsageRow } from './stats'
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
const STATS = 'arne-stats'

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
// True while the band's panel is open (model, effort, why, settings).
const whyOpen = atom({ plugin: 'arne', key: 'whyOpen' } as const, false)
// The decision key the person just rated; the panel then says it logged the rating.
const thanked = atom({ plugin: 'arne', key: 'thanked' } as const, null as string | null)
// True while Laya is the judge but laya-serve is not answering; the why line then says Haiku judged.
const layaDown = atom({ plugin: 'arne', key: 'layaDown' } as const, false)
// What the desktop app's model picker shows: the session's first model, then each pick made in it
// (PostModelSwitch source "sdk"). Plugins cannot move that picker, so arne's /model can differ from it.
const appPicker = atom({ plugin: 'arne', key: 'appPicker' } as const, null)
// The Stats pane's period (17q).
const statsPeriod = atom({ plugin: 'arne', key: 'statsPeriod' } as const, 'week')
// 17u. Every own config write reloads the plugin and wipes module state, so what a press must show at
// once, or what has to outlive that reload, lives here.
// Bumped on every option change: the Settings pane reads it, since `live` alone draws nothing again.
const liveRev = atom({ plugin: 'arne', key: 'liveRev' } as const, 0)
// Bumped after a pin's store write: the band reads it, since a store read does not subscribe.
const pinRev = atom({ plugin: 'arne', key: 'pinRev' } as const, 0)
// The cold spell (its warmUntil) whose heavy alert the person dismissed, as coldDismissed.
const heavyDismissed = atom({ plugin: 'arne', key: 'heavyDismissed' } as const, 0)
// A compact arne started is running: its buttons give way to "summarizing…", and a second press does nothing.
const compacting = atom({ plugin: 'arne', key: 'compacting' } as const, false)
// `claude plugin disable effortless` is running (up to 60 s): its button is hidden meanwhile.
const disabling = atom({ plugin: 'arne', key: 'disabling' } as const, false)
// The main turn's decision, for its steps.
const currentAtom = atom({ plugin: 'arne', key: 'current' } as const, null)
// The session model arne expects: the one it last switched to, or last saw. A switch to another tier is the person's.
const expectedAtom = atom({ plugin: 'arne', key: 'expected' } as const, null)
// A Summarize, then send/continue is running: its compaction must not also send "Continue".
const compactSendingAtom = atom({ plugin: 'arne', key: 'compactSending' } as const, false)
// The tier the last handoff went to, for the panel's note; the "Handoff…" item's tier list is open (17w).
const handedOff = atom({ plugin: 'arne', key: 'handedOff' } as const, null)
const handoffMenu = atom({ plugin: 'arne', key: 'handoffMenu' } as const, false)
// This chat's subagents (17x): how many arne moved to each tier, kept on their model, or ran as asked.
// The "Ratings train Laya" line was seen this chat (closing the panel marks it).
const layaHinted = atom({ plugin: 'arne', key: 'layaHinted' } as const, false)
const subCount = atom({ plugin: 'arne', key: 'subCount' } as const, null)
type SubCount = Partial<Record<Tier | 'kept' | 'asked', number>>
const countSpawn = ($: any, k: keyof SubCount) => update($, subCount, (c: SubCount | null) => ({ ...c, [k]: ((c ?? {})[k] ?? 0) + 1 }))
// The Stats pane's three periods, parsed from the log once per open rather than on every press.
const statsData = atom({ plugin: 'arne', key: 'stats' } as const, null)
const TIER_NAME_OF: Record<Tier, string> = { S: 'haiku', M: 'sonnet', L: 'opus' }
const STATES: BandState[] = ['routing', 'off', 'paused', 'cold', 'heavy', 'normal']

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
  if (await read($, disabling)) return
  await update($, disabling, () => true)
  const r = await $.process.run(['claude', 'plugin', 'disable', EFFORTLESS], { timeoutMs: 60_000 }).catch(() => undefined)
  await update($, disabling, () => false)
  $.ui.toast(r?.exitCode === 0 ? 'Effortless disabled. Restart to hand effort to arne.' : 'Could not disable effortless; disable it from the plugin list.')
}

// One compact at a time: the alerts show "summarizing…" while it runs, and a second press returns false.
async function compactNow($: any, note: string): Promise<boolean> {
  if (await read($, compacting)) return false
  await update($, compacting, () => true)
  try {
    await $.command.run({ command: 'compact', args: note.trim() })
    return true
  } catch {
    $.ui.toast('Compact failed; try again when the session is idle')
    return false
  } finally {
    await update($, compacting, () => false)
  }
}

// --- Handoff (17o, 17w) ---
// Haiku summarizes the chat into arne-handoff.md and the clipboard. Then /clear starts a fresh chat in
// place, pinned to `tier`, whose first message is the summary. The old chat stays in history; no plugin
// call archives a desktop chat, so that stays the person's click. One at a time (the compacting atom).
const HANDOFF_FILE = 'arne-handoff.md'
const SUMMARY_SYSTEM = 'Summarize this coding conversation for its next turn: goal, decisions and why, files changed (paths), exact errors, open questions, next step. Plain text, under 1500 words.'

// Set before the first await, so two presses in the same tick still run one handoff; the atom draws "summarizing…".
let handingOff = false
async function handoff($: any, tier: Tier, surface?: string) {
  if (handingOff) return
  handingOff = true
  if (await read($, compacting)) return void (handingOff = false)
  await update($, compacting, () => true)
  let step = 'the summary'
  try {
    const msgs: any = await $.session.messages()
    const said = (Array.isArray(msgs) ? msgs : []).filter((m: any) => m.text?.trim())
    if (said.length === 0) throw new Error('empty chat')
    const r = await $.model.complete(
      { model: live.compactModel, prompt: summaryPrompt(said), system: SUMMARY_SYSTEM, effort: 'low' },
      { timeoutMs: 120_000 },
    )
    if (!r.isAnswered || !r.text) throw new Error('no summary')
    const sum = usageRow('summary', await $.clock.now(), r.usage, MODEL[TIER_OF[live.compactModel] ?? 'S'])
    if (sum) await appendLog($, sum)
    const text = `# Handoff

Summary of an earlier chat (written by ${shortModel(live.compactModel)} for arne):

${r.text}
`
    await $.fs.write(HANDOFF_FILE, text).catch(() => undefined)
    await $.ui.copy({ text, surface }).catch(() => undefined)
    step = '/clear'
    await $.command.run({ command: 'clear', args: '' })
    await update($, cache, () => null) // the new chat has no cache yet
    await update($, subCount, () => null)
    await update($, layaHinted, () => false)
    step = '/model'
    // Pinned after the clear: a pin belongs to the chat it was set in.
    await setPinPart($, { tier }, false)
    if (tierOf(await $.session.model()) !== tier) await moveModel($, MODEL[tier])
    if (tierOf(await $.session.model()) !== tier) throw new Error('model')
    step = 'sending the summary'
    await $.prompt.submit({ text, asUser: true })
    await update($, handedOff, () => tier)
    $.ui.toast(`Handed off to ${shortModel(MODEL[tier])}. Old chat saved in history; archive it from the sidebar when you are done.`)
  } catch {
    $.ui.toast(`Handoff stopped at ${step}.${step === 'the summary' ? '' : ` The summary is on your clipboard and in ${HANDOFF_FILE}.`}`)
  } finally {
    handingOff = false
    await update($, compacting, () => false)
    await update($, handoffMenu, () => false)
  }
}

// --- The held prompt (step 17a) ---
// A prompt typed on a cold, big chat waits here until the person picks Compact & send or Send anyway.
const CONTINUE_TEXT = 'Continue where you left off.'
// Messages a compact keeps word for word after the summary, and the judge's card reads (17v).
const KEEP_AFTER_COMPACT = 10
let lastReason: string | undefined // how the last main turn ended

// Sends a prompt as the person's own words. A plugin's own $.prompt.submit skips that plugin's
// prompt.submit hooks (seen in the test kit), so it is never held again and never routed there.
async function sendAsUser($: any, text: string) {
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch {
    $.ui.toast('Could not send your message; it is back in the prompt box')
    await $.prompt.fill({ text, mode: 'replace' }).catch(() => undefined)
  }
}

async function compactAndSend($: any) {
  const text = await read($, held)
  if (!text || (await read($, compactSendingAtom)) || (await read($, compacting))) return
  await update($, held, () => null) // cleared first: a second click finds nothing to send
  await update($, compactSendingAtom, () => true)
  const ok = await compactNow($, '').finally(() => update($, compactSendingAtom, () => false))
  if (ok) await routeAndSend($, text)
  else await update($, held, () => text)
}

// Heavy banner: nothing is held (the prompt was never blocked), so after compacting arne sends "Continue".
async function compactThenContinue($: any) {
  if ((await read($, compactSendingAtom)) || (await read($, compacting))) return
  await update($, compactSendingAtom, () => true)
  const ok = await compactNow($, '').finally(() => update($, compactSendingAtom, () => false))
  if (ok) await routeAndSend($, CONTINUE_TEXT)
}

async function sendAnyway($: any) {
  const text = await read($, held)
  if (!text) return
  await update($, held, () => null)
  await routeAndSend($, text)
}


// Module state. Reset on a reload, like every module variable (what must survive one is in atoms, 17u).
let prev: Decision | undefined
let switching = false // arne's own /model is queued or running: the session model may still be the old one
let lastResponseAt: number | undefined
let arneSwitched = false // arne's own /model ran: the next main turn's cache writes are the switch's (17q)
// Decisions made at prompt.submit, by text, for the turn.start of the same prompt.
const planned = new Map<string, Decision>()
// Subagent decisions, by agentId, so each step of a run uses the effort picked at its spawn (17x).
const agents = new Map<string, Decision | undefined>()
// Picks whose spawn has not resolved yet: the subagent's first request can arrive before its agentId does.
const pendingPicks: Decision[] = []
// A step of an agent with no pick yet claims the oldest pending pick on its model (effortless's helperEffortOf).
function agentPick(agentId: string, model: string): Decision | undefined {
  if (agents.has(agentId)) return agents.get(agentId)
  const i = pendingPicks.findIndex(d => tierOf(model) === d.tier)
  if (i < 0) return undefined
  const [d] = pendingPicks.splice(i, 1)
  agents.set(agentId, d)
  return d
}

// The band's pickers pin a tier, an effort, or both; the part left out is arne's to decide.
type Pin = { tier?: Tier; effort?: Decision['effort'] }
type Settings = { enabled: boolean; pin: Pin | null; backend: string }

// The userConfig values, as the engine holds them. arne's own writes (the band, Settings, /arne) go
// through setOption, which updates this copy itself: the app never shows a plugin its own config.set.
// A /config write lands in the config.set hook below. Either write reloads arne, and register reads them again.
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
  subagents: boolean
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
  subagents: true,
}
let live: Live = { ...DEFAULTS }
const FIELDS = Object.keys(DEFAULTS) as (keyof Live)[]

// The cold offer applies: the chat model's cache is cold, the chat is past coldTokens, and this cold
// spell was not dismissed. A compact clears the cache atom, so there is no offer until the next response.
async function coldOffer($: any, now: number) {
  const c: Cache | null = await read($, cache)
  if (!c) return undefined
  const until = c.warmUntil[c.model] ?? 0
  if (until > now || c.C < live.coldTokens) return undefined
  if ((await read($, coldDismissed)) === until) return undefined
  // Only when summarizing first is cheaper than the plain resend (17p): otherwise there is nothing to offer.
  const advice = coldAdvice(c.C, c.model, c.warmUntil, now)
  const resend = advice.rows.find(r => r.action === 'continue')!.first
  const summary = advice.rows.find(r => r.action === 'compact')!.first
  return summary < resend ? { c, ...advice } : undefined
}

// Where a handoff goes when no tier is named: the tier the judge last wanted, else the chat's own.
async function handoffTier($: any): Promise<Tier> {
  const l = await read($, last)
  return tierOf(l?.waitFor ?? l?.model ?? '') ?? tierOf(await $.session.model()) ?? 'M'
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
  const model: string = await $.session.model()
  await update($, expectedAtom, () => model)
}

// arne's own config writes while they run, by key. The app never shows them to arne's config.set hook
// (index.d.ts, $.config.set); the test kit does, so the hook skips these keys to match the app.
const ownWrites = new Set<string>()
async function setOnce($: any, key: string, value: unknown): Promise<{ value: unknown } | { deny: string }> {
  ownWrites.add(key)
  try {
    return await $.config.set({ key, value })
  } catch (err) {
    return { deny: String((err as Error)?.message ?? err) }
  } finally {
    ownWrites.delete(key)
  }
}
// With two arne plugins enabled (a stale cached copy and a dev one), the engine keys rows
// `arne@<marketplace>.<field>`, and `arne.<field>` names no row: find arne's own row and write that.
async function ownSet($: any, key: string, value: unknown): Promise<{ value: unknown } | { deny: string }> {
  const r = await setOnce($, key, value)
  if (!('deny' in r) || !r.deny.includes('no /config row')) return r
  const field = key.slice(key.indexOf('.') + 1)
  const rows: { key: string; provider?: { plugin?: string } }[] = await $.config.list().catch(() => [])
  const mine = rows.filter(row => row.provider?.plugin === 'arne' && row.key.endsWith(`.${field}`))
  if (mine.length > 1) return { deny: 'two copies of arne are enabled; turn one off in /plugin' }
  return mine.length && mine[0]!.key !== key ? setOnce($, mine[0]!.key, value) : r
}

// Puts one option into `live` and onto every surface: the band (isOff), the Settings pane (liveRev), the status line.
async function applyLive($: any, field: keyof Live, value: unknown) {
  ;(live as Record<string, unknown>)[field] = value
  await update($, liveRev, n => n + 1)
  if (field === 'auto') {
    await update($, isOff, () => !value)
    // Turning it on, from /config, the band, Settings or /arne on, is the person's go-ahead: clear any pause.
    if (value) await resume($)
    await showStatus($)
  }
}

// The one writer for arne's options (17u): the surfaces change first, then the config write. A refused
// write puts the old value back and says why.
async function setOption($: any, field: keyof Live, value: unknown) {
  const was = live[field]
  await applyLive($, field, value)
  const r = await ownSet($, `arne.${field}`, value)
  if ('deny' in r) {
    await applyLive($, field, was)
    // The engine's own "<plugin>: $.config.set: " prefix: the toast already shows arne's name.
    $.ui.toast(`Could not change ${field}: ${r.deny.replace(/^[^:]*: \$\.config\.set: /, '')}`)
  }
}

const setAuto = ($: any, on: boolean) => setOption($, 'auto', on)

// The band's Auto button: on turns off, off turns on. A pause resumes without a config write.
async function toggleAuto($: any) {
  const mode = await modeOf($)
  if (mode !== 'paused') return setAuto($, mode === 'off')
  await resume($)
  await showStatus($)
}

// Sets one part of the pin and keeps the other; a pin with neither part left is removed. A pin ends a pause.
// The band redraws first; a model pin then moves the real /model on the next tick, unless the pick
// already moved it (the app's own picker). The tick also lets /arne pin run it: a /model run from inside
// a command's own hook is refused.
async function setPinPart($: any, part: Pin, move = true) {
  const next: Pin = { ...((await settings($)).pin ?? {}), ...part }
  if (next.tier === undefined) delete next.tier
  if (next.effort === undefined) delete next.effort
  if (next.tier || next.effort) await $.store.set(await pinKey($), next)
  else await $.store.delete(await pinKey($))
  await update($, pinRev, n => n + 1)
  await resume($)
  await showStatus($)
  if (move && part.tier && tierOf(await $.session.model()) !== part.tier) {
    const target = MODEL[part.tier]
    $.clock.after(0, () => moveModel($, target))
  }
}

// The real /model moves now, marked as arne's own so PostModelSwitch does not pause arne.
async function moveModel($: any, target: string) {
  const was = await read($, expectedAtom)
  await update($, expectedAtom, () => target)
  switching = true
  try {
    await $.command.run({ command: 'model', args: target })
    arneSwitched = true
  } catch {
    await update($, expectedAtom, () => was)
    $.ui.toast(`Could not switch /model to ${shortModel(target)}`)
  } finally {
    switching = false
  }
}

// Good call / Wrong call on the last decision: a correction label for the classifier, written beside the log rows.
async function feedback($: any, verdict: 'up' | 'down') {
  const l = await read($, last)
  if (!l) return
  // Thanked first, so the buttons give way on the press; a failed write brings them back.
  const was = await read($, thanked)
  await update($, thanked, () => l.key)
  try {
    const old: string = await $.fs.read(await homePath($, LOG_FILE)).catch(() => '')
    await $.fs.write(await homePath($, LOG_FILE), old + JSON.stringify({ type: 'feedback', key: l.key, verdict, model: l.model, effort: l.effort, reason: l.reason, source: l.source }) + '\n')
  } catch {
    await update($, thanked, () => was)
    $.ui.toast('Could not log that feedback')
  }
}

async function showStatus($: any) {
  $.ui.status(statusOf(await modeOf($), await $.session.model()))
}

// The status line: the footer already names the plugin, so no "arne" here.
const statusOf = (mode: Mode, model: string) =>
  mode === 'on' ? undefined : bandText({ off: mode === 'off', paused: mode === 'paused', routing: false, model, warmLeftMs: 0, C: 0 }).short

// $.store is one JSON file for every session, so a pin is keyed by its chat: a new chat starts on Auto (17p).
// ponytail: one key per pinned chat is never cleaned up; prune old keys if the store ever nears its 4 MiB cap.
async function pinKey($: any): Promise<string> {
  return `pin:${await $.session.id().catch(() => '')}`
}

async function settings($: any): Promise<Settings> {
  return {
    enabled: live.auto,
    pin: ((await $.store.get(await pinKey($))) ?? null) as Pin | null,
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
    // laya not installed, or the server exited: the why line says Haiku judged until it answers
    $.ui.toast('laya-serve did not start (not on PATH?). Haiku judges until it does.')
  } finally {
    layaStarting = false
  }
}

// laya -> haiku -> prev -> default. The chain falls through silently.
// What the project is, so Haiku judges "how hard is this prompt" for this codebase, not in a vacuum.
// Read once per load from CLAUDE.md, else README.md, in the project folder. ponytail: stale until reload.
let projectCtx: Promise<string> | undefined
function projectContext($: any): Promise<string> {
  projectCtx ??= (async () => {
    for (const f of ['CLAUDE.md', 'README.md']) {
      const t: string = await $.fs.read(f).catch(() => '')
      if (t.trim()) return `\n\nProject context (${f}, for judging difficulty; do not answer it):\n${t.slice(0, 2500)}`
    }
    return ''
  })()
  return projectCtx
}

// The judge's view of the task so far (17p), so "continue", "do it" or "B" are read against the work in hand.
// Built from the transcript each time: the first prompt, the last 10 messages from both sides (17v), the
// last verdict, files touched, the context size. At most CARD_MAX characters (~2k tokens). '' when the
// transcript cannot be read.
const CARD_MAX = 8000
async function taskCard($: any, c: Cache | null): Promise<string> {
  const msgs: any = await $.session.messages().catch(() => [])
  if (!Array.isArray(msgs) || msgs.length === 0) return ''
  // Rows with words only: a user row that carries tool results is the engine's, not the person's.
  const said = msgs.filter((m: any) => m.text?.trim() && !m.toolResults?.length)
  const prompts = said.filter((m: any) => m.role === 'user').map((m: any) => m.text.trim())
  const recent = said.slice(-KEEP_AFTER_COMPACT)
  const files = new Set<string>()
  for (const m of msgs) for (const u of m.toolUses ?? []) {
    const f = u.input?.file_path ?? u.input?.notebook_path ?? u.input?.path
    if (typeof f === 'string') files.add(f)
  }
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
  const lines = [
    prompts[0] && `First prompt: ${clip(prompts[0], 1200)}`,
    recent.length > 1 && `Last messages:\n${recent.map((m: any) => `- ${m.role}: ${clip(m.text.trim(), 500)}`).join('\n')}`,
    prev && `Previous verdict: ${TIER_NAME_OF[prev.tier]} · ${prev.effort} (${prev.reason})`,
    files.size && `Files touched: ${[...files].slice(-15).join(', ')}`,
    c && `Context: ${Math.round(c.C / 1000)}k tokens`,
  ].filter(Boolean)
  return lines.length ? clip(`Conversation so far:\n${lines.join('\n')}`, CARD_MAX) : ''
}

function backendsOf($: any, backend: string, card = ''): Backend[] {
  const haiku: Backend = {
    name: 'haiku',
    ask: async text => {
      const prompt = card ? `${card}\n\nNew prompt to judge:\n${text.slice(0, 4000)}` : text.slice(0, 4000)
      const r = await $.model.complete(
        { model: 'haiku', prompt, system: SYSTEM + (await projectContext($)), effort: 'low' },
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
  // The band says so when Laya was picked but is not answering: the chain judges with Haiku instead.
  await update($, layaDown, () => s.backend === 'laya' && !layaUp)
  // Any pin pins both parts and skips routing (17p): the part it leaves out stays what the session has now.
  // A pin is the person's own pick, so it skips the floor and ceiling (how xhigh, max or a capped tier are reached).
  const pin = s.pin ?? undefined
  const c: Cache | null = await read($, cache)
  let d: Decision
  if (pin?.tier || pin?.effort) {
    const effort = pin.effort ?? (((await read($, appEffort)) ?? 'medium') as Decision['effort'])
    d = { tier: pin.tier ?? tierOf(await $.session.model()) ?? 'M', effort, reason: 'pinned', source: 'pin', keepEffort: !pin.effort }
  } else {
    const card = await taskCard($, c)
    const r = await route(text, { prev, paused: await read($, isPaused), backends: backendsOf($, s.backend, card) })
    if (!r) return undefined
    d = { ...r, tier: clampTier(r.tier, live.modelFloor, live.modelCeiling), effort: clampEffort(r.effort, live.effortFloor, live.effortCeiling) }
  }
  // Never route to a model whose window is smaller than the chat: a bigger tier takes the prompt instead.
  // This is the one thing that moves a pin, and the band then says why ("the chat needs a bigger window").
  const tier = c ? fitTier(d.tier, c.C) : d.tier
  const sized = tier === d.tier ? d : { ...d, tier, reason: 'window' }
  prev = sized
  return sized
}

// The model the real /model should move to before this prompt, or undefined to stay.
// A pin always moves; otherwise only where planSwitch says moving pays (a cache boundary, or worth it).
async function switchTarget($: any, d: Decision): Promise<string | undefined> {
  const chat = tierOf(await $.session.model())
  if (!chat || d.tier === chat) return undefined
  if (d.source === 'pin') return MODEL[d.tier]
  const c: Cache | null = await read($, cache)
  const plan = planSwitch({ decided: d.tier, chat, C: c?.C ?? 0, warmUntil: c?.warmUntil ?? {}, now: await $.clock.now() })
  return plan.why === 'sticky' ? undefined : MODEL[d.tier]
}

// The effort the native /effort should move to before this prompt, or undefined to stay. Haiku takes
// none, and while effortless is on the effort is its to set.
// Effort is never typed as /effort any more: turn.step rewrites it silently on every request, so the
// prompt is not dropped and re-sent for it. ponytail: the app's effort control keeps showing its old value.
async function effortTarget(_$: any, _d: Decision, _model: string): Promise<Decision['effort'] | undefined> {
  return undefined
}

// Runs the real /model and /effort, then sends the dropped prompt once, whether or not they worked.
async function switchThenSend($: any, target: string | undefined, effort: Decision['effort'] | undefined, text: string) {
  // The person may have picked a model while this waited: theirs stands.
  if ((await modeOf($)) === 'on' && effort) {
    try {
      await $.command.run({ command: 'effort', args: effort })
      await update($, appEffort, () => effort)
    } catch {
      $.ui.toast(`Could not set /effort to ${effort}`)
    }
  }
  if ((await modeOf($)) === 'on' && target) {
    const was = await read($, expectedAtom)
    await update($, expectedAtom, () => target)
    switching = true
    try {
      await $.command.run({ command: 'model', args: target })
      arneSwitched = true
    } catch {
      await update($, expectedAtom, () => was)
      planned.delete(text) // decided for a model it is not on: turn.start decides again
      $.ui.toast(`Could not switch /model to ${shortModel(target)}; sending on the current model`)
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
  const effort = d && (await effortTarget($, d, target ?? (await $.session.model())))
  if (target || effort) await switchThenSend($, target, effort, text)
  else await sendAsUser($, text)
}

// $.fs has no append: read, then write the whole file. ponytail: O(n) per turn, fine below ~10k rows.
async function appendLog($: any, row: (Row & { text: string; agent?: string; decided?: string; from?: string; to?: string; at?: number }) | UsageRow) {
  try {
    const old: string = await $.fs.read(await homePath($, LOG_FILE)).catch(() => '')
    await $.fs.write(await homePath($, LOG_FILE), old + JSON.stringify(row) + '\n')
  } catch {
    // no log this time
  }
}

// Stats for one period, from the log's usage rows (17q). ponytail: reads the whole log per call; fine
// below ~10k rows, keep running totals in the store if it ever gets slow.
async function statsFor($: any, period: Period) {
  const text: string = await $.fs.read(await homePath($, LOG_FILE)).catch(() => '')
  return summarize(parseUsage(text), periodStart(period, await $.clock.now()))
}

// The Stats pane reads all three periods from one parse at open, so a period press only redraws (17u).
async function openStats($: any) {
  const text: string = await $.fs.read(await homePath($, LOG_FILE)).catch(() => '')
  const rows = parseUsage(text)
  const now: number = await $.clock.now()
  await update($, statsData, () => Object.fromEntries(PERIODS.map(([p]) => [p, summarize(rows, periodStart(p, now))])))
  await $.ui.open({ id: STATS, title: 'arne stats' })
}

// Drives the band's countdown while the cache is warm. A reload cancels every timer and session.start does
// not run again, so a response landing and a render of a warm band arm it too; `tick` is module state, so a
// reload arms it once more. A cold cache stays cold, so the tick stops there: no write every second while
// the chat sits idle. ponytail: a 1s state write while warm.
let tick: { cancel: () => void } | undefined
function armTick($: any) {
  if (tick) return
  try {
    tick = $.clock.every(1000, async () => {
      const c = await read($, cache)
      const now: number = await $.clock.now()
      await update($, clockNow, () => now) // the last one redraws the band as the cache turns cold
      if (c === null || (c.warmUntil[c.model] ?? 0) <= now) {
        tick?.cancel()
        tick = undefined
      }
    })
  } catch {
    tick = undefined
  }
}

// A main-loop response landed: the answering model's cache is warm for one more TTL.
async function cacheTouched($: any, model: string, usage: unknown) {
  const tier = tierOf(model)
  // No usage means no response landed (an interrupted or failed step): the cache and its size are unchanged.
  if (!tier || !usage) return
  const now: number = await $.clock.now()
  const since = lastResponseAt === undefined ? undefined : now - lastResponseAt
  lastResponseAt = now
  await update($, cache, (c: Cache | null): Cache => {
    const ttl = nextTtl(c?.ttl ?? '5m', usage, since)
    return { ttl, C: contextOf(usage), model: tier, warmUntil: { ...c?.warmUntil, [tier]: now + CACHE_TTL[ttl] } }
  })
  await update($, clockNow, () => now)
  armTick($)
}

export const register: Register = (on, options) => {
  live = { ...DEFAULTS, ...(options as Partial<Live>) }

  // A write to an arne.* row from /config or another plugin lands here. arne's own writes never do: the
  // app skips a plugin's own hooks, and ownWrites makes the test kit skip them the same way (17u).
  on('config.set', async ($, e, next) => {
    if (ownWrites.has(e.key)) return next(e)
    const r = await next(e)
    // `arne.<field>`, or `arne@<marketplace>.<field>` while another arne is enabled too.
    const field = /^arne(@[^.]+)?\./.test(e.key) ? (e.key.slice(e.key.indexOf('.') + 1) as keyof Live) : undefined
    if (field && FIELDS.includes(field) && !('deny' in r)) await applyLive($, field, r.value)
    return r
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    // Busy flags are atoms, so they outlive a reload or a quit that cut their `finally` short: a new session clears them.
    await update($, compacting, () => false)
    await update($, compactSendingAtom, () => false)
    await update($, disabling, () => false)
    await update($, subCount, () => null)
    await update($, layaHinted, () => false)
    await $.command.register({
      name: 'arne',
      description: 'Auto model and effort routing: on, off, pin, unpin, handoff, subagents, why, log, stats, backend, debug',
    })
    const eff = await effortlessOn($)
    await update($, effortless, () => eff)
    await update($, isOff, () => !live.auto)
    const first = await $.session.model()
    // The app's picker shows the session's model at start. Re-read each start, so a stale pick does not outlive it.
    await update($, appPicker, () => first)
    armTick($)
    return next(e)
  })

  // arne's own switch lands here as source "command" too, so it is told apart by its tier: arne sets
  // `expected` before it runs /model, and a repeat event for the same switch still matches.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    // ponytail: a manual pick of the tier arne already expects reads as arne's own and does not pause;
    // tell them apart by origin if command.run ever carries one for /model.
    const expected = await read($, expectedAtom)
    const isOwn = expected !== null && tierOf(e.to_model) === tierOf(expected)
    // A pick in the desktop app's picker is an input: it pins that tier, not a pause. Auto in the band's panel unpins.
    if (e.source === 'sdk' && !switching) {
      await update($, appPicker, () => e.to_model)
      const tier = tierOf(e.to_model)
      if (tier) await setPinPart($, { tier }, false)
    } else {
      const byHand = e.source === 'command' || e.source === 'picker'
      if (!isOwn && byHand && !(await read($, isOff))) await update($, isPaused, () => true)
    }
    await update($, expectedAtom, () => e.to_model)
    await update($, sessionModel, () => e.to_model)
    await showStatus($)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const isMain = e.agentId === undefined
    if (isMain) lastReason = e.reason
    // Each turn's real usage goes to the log, for Stats across reloads (17q). A turn with none is not logged.
    const row = usageRow(isMain ? 'turn' : 'agent', await $.clock.now(), r.usage ?? e.usage, undefined, isMain && arneSwitched)
    if (isMain) arneSwitched = false
    if (row) await appendLog($, row)
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
          system: SUMMARY_SYSTEM + (e.instructions ? ` Keep: ${e.instructions}` : ''),
          effort: 'low',
        },
        { timeoutMs: 120_000 },
      )
      if (!r.isAnswered || !r.text) return next(e)
      const sum = usageRow('summary', await $.clock.now(), r.usage, MODEL[TIER_OF[live.compactModel] ?? 'S'])
      if (sum) await appendLog($, sum)
      const kept = e.messages.slice(-KEEP_AFTER_COMPACT) // word for word after the summary (17v)
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
    // The cache numbers are the old chat's, and the atom outlives a reload: a stale big, expired cache
    // made the first prompt after a compact read as a cold 100k chat and get held (17v). No cache until
    // the next response lands (cacheTouched); planSwitch then reads the chat as a boundary.
    await update($, cache, () => null)
    const r = await next(e)
    if (e.trigger === 'manual' && !(await read($, compactSendingAtom)) && live.continueAfterCompact && !(await read($, held)) && midTask(lastReason, e.compact_summary)) {
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
      return { drop: 'arne is holding your message: the cache is cold. Pick Summarize, then send or Send as is above the prompt.' }
    }
    await update($, routing, () => true)
    const d = await decideMain($, e.text).finally(() => update($, routing, () => false))
    if (d) planned.set(e.text, d)
    const target = d && (await switchTarget($, d))
    const effort = d && (await effortTarget($, d, target ?? (await $.session.model())))
    if (!target && !effort) return next(e)
    $.clock.after(0, () => switchThenSend($, target, effort, e.text))
    const to = [target && shortModel(target), effort].filter(Boolean).join(' · ')
    return { drop: `arne: switching to ${to} first; your message follows.` }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'arne' }, async ($, e) => {
    const [sub, ...rest] = e.args.trim().split(/\s+/)
    const s = await settings($)

    switch (sub) {
      case 'on':
        await setAuto($, true)
        return { text: live.auto ? 'arne on.' : 'arne stays off: the setting was refused.' }
      case 'off':
        await setAuto($, false)
        return { text: live.auto ? 'arne stays on: the setting was refused.' : 'arne off. Requests use the session model.' }
      case 'settings':
        await $.ui.open({ id: SETTINGS, title: 'arne settings' })
        return { text: 'arne settings opened. Changes here match /config.' }
      case 'pin': {
        const tier = TIER_OF[rest[0]]
        if (!tier) return { text: 'Usage: /arne pin haiku|sonnet|opus [low|medium|high|xhigh|max]' }
        if (rest[1] && !(rest[1] in EFFORT_RANK)) return { text: 'Efforts: low, medium, high, xhigh, max.' }
        const effort = (rest[1] ?? 'medium') as Decision['effort']
        // A pin is the person's pick made through arne: it ends a pause and moves /model (on the next tick).
        await setPinPart($, { tier, effort })
        return { text: `arne pinned to ${rest[0]} · ${effort}.` }
      }
      case 'unpin':
        await setPinPart($, { tier: undefined, effort: undefined })
        return { text: 'arne unpinned.' }
      case 'backend': {
        const b = rest[0]
        if (b !== 'haiku' && b !== 'heuristic' && b !== 'laya') return { text: 'Backends: haiku, heuristic, laya.' }
        await setOption($, 'backend', b)
        if (live.backend !== b) return { text: `arne backend stays ${live.backend}: the setting was refused.` }
        if (b === 'laya') {
          return {
            text: 'arne backend: laya. It needs laya-serve on PATH (Python 3.10+, the laya package, torch; git clone https://github.com/NandhaKishorM/laya and pip install -e .). Until it answers, turns fall back to haiku.',
          }
        }
        return { text: `arne backend: ${b}.` }
      }
      case 'stats': {
        const lines = await Promise.all(
          PERIODS.map(async ([p, label]) => {
            const st = await statsFor($, p)
            const opus = savedText(st.spent, st.opus)
            return `${label}: $${st.spent.toFixed(2)} spent over ${st.turns} turns. Against Opus · medium: ${opus.headline.toLowerCase()} (${opus.sub}). Against Sonnet · medium: ${savedText(st.spent, st.sonnet).headline.toLowerCase()}.`
          }),
        )
        return { text: `arne stats (an estimate: each turn's real tokens, priced again on Opus or Sonnet):\n${lines.join('\n')}` }
      }
      case 'subagents': {
        if (rest[0] !== 'on' && rest[0] !== 'off') return { text: 'Usage: /arne subagents on|off' }
        await setOption($, 'subagents', rest[0] === 'on')
        return { text: live.subagents ? 'arne routes subagents.' : 'arne leaves subagents on the model they ask for.' }
      }
      case 'handoff': {
        const named: Tier | undefined = TIER_OF[rest[0] ?? '']
        if (rest[0] && !named) return { text: 'Usage: /arne handoff [haiku|sonnet|opus]' }
        const tier = named ?? (await handoffTier($))
        // Next tick: /clear and /model are refused from inside a command's own hook.
        $.clock.after(0, () => handoff($, tier))
        return { text: `arne: handing off to ${shortModel(MODEL[tier])}…` }
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
        return { text: `arne debug: ${await modeOf($)}, ttl ${c.ttl}, C ${c.C} tokens, last ${MODEL[c.model]}. ${warm}. expected ${(await read($, expectedAtom)) ?? 'none'}, switching ${switching}.` }
      }
      default: {
        const mode = await modeOf($)
        const state = mode === 'paused' ? 'paused (you picked a model; /arne on resumes)' : mode
        return {
          text: `arne ${state}, backend ${s.backend}${s.pin ? `, pinned ${[s.pin.tier && TIER_NAME_OF[s.pin.tier], s.pin.effort].filter(Boolean).join(' · ')}` : ''}. Subcommands: on, off, pin, unpin, handoff, subagents, why, log, stats, backend, debug.`,
        }
      }
    }
  })

  // A subagent's model is picked here, before it starts (17x). Left alone: Subagents off, arne off, a pin,
  // a fork, a teammate, a workflow agent, a resumed run, and a call that named its model (the parent asked).
  on('agent.spawn', async ($, e, next) => {
    const s = await settings($)
    if (!live.subagents || !s.enabled || s.pin || e.fork || e.isTeammate || e.workflow || e.resume) return next(e)
    const now: number = await $.clock.now()
    if (e.model) {
      const r = await next(e)
      if (r.agentId) agents.set(r.agentId, undefined)
      await countSpawn($, 'asked')
      await appendLog($, { key: `agent:${r.agentId ?? e.tool_use_id}`, model: e.model, effort: '', reason: 'asked for', source: 'asked', out: 0, cacheRead: 0, text: e.prompt.slice(0, 4000), agent: e.subagentType, at: now })
      return r
    }
    const parent = tierOf(e.parentModel) ?? 'L'
    // The type's own default counts as what it would have run on: Explore's is Haiku.
    const from: Tier = e.subagentType === 'Explore' ? 'S' : parent
    const brief = `${e.prompt.slice(0, 4000)}

[This is the task Claude gave a ${e.subagentType} subagent, not a message from the person. Judge the work that subagent needs.]`
    const r0 = await route(brief, { agentType: e.subagentType, backends: backendsOf($, s.backend) })
    if (!r0) return next(e)
    // Never dearer than the chat that sent it; effort at least medium (helpers at low miscounted).
    const clamped = clampTier(r0.tier, live.modelFloor, live.modelCeiling)
    const tier = PRICE[clamped] > PRICE[parent] ? parent : clamped
    const effort = clampEffort(r0.effort, live.effortFloor, live.effortCeiling)
    const d: Decision = { ...r0, tier, effort: (EFFORT_RANK[effort] ?? 0) < 1 ? 'medium' : effort }
    pendingPicks.push(d)
    let r
    try {
      r = await next({ ...e, model: MODEL[tier] })
    } finally {
      const i = pendingPicks.indexOf(d)
      if (i >= 0) pendingPicks.splice(i, 1)
    }
    if (r.agentId && !agents.has(r.agentId)) agents.set(r.agentId, d)
    const label = `${shortModel(MODEL[tier])}${tier === 'S' ? '' : ` · ${d.effort}`}`
    if (tier !== from) {
      try {
        $.ui.notice(e.tool_use_id, `arne: ${label} (${plainReason(d.reason)})`)
      } catch {
        // the call is no longer open
      }
    }
    await countSpawn($, tier === from ? 'kept' : tier)
    await appendLog($, { key: `agent:${r.agentId ?? e.tool_use_id}`, model: MODEL[tier], effort: d.effort, reason: d.reason, source: d.source, out: 0, cacheRead: 0, text: e.prompt.slice(0, 4000), agent: e.subagentType, from: MODEL[from], to: MODEL[tier], at: now })
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const s = await settings($)
    if (e.agentId === undefined) await update($, isOff, () => !s.enabled)

    if (e.agentId === undefined) {
      const model = await $.session.model()
      // A model the user set by hand (/model) pauses arne. classic.PostModelSwitch catches it at once;
      // this is the fallback. By tier: the same model can come back as an alias or a full id.
      // Skipped while arne's own switch waits: the session is still on the old model then.
      const expected = await read($, expectedAtom)
      if (expected !== null && !switching && tierOf(model) !== tierOf(expected) && s.enabled) await update($, isPaused, () => true)
      if (expected === null) await update($, expectedAtom, () => model)
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
      // Held on the chat's model (cache warm, or mid-turn): the row keeps the decision's own reason and says what it waited for.
      const waitFor = decided && chat && decided.tier !== chat ? MODEL[decided.tier] : undefined
      const current = decided && chat && decided.tier !== chat ? { ...decided, tier: chat } : decided
      await update($, currentAtom, () => current ?? null)
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
          waitFor,
        }
        await update($, last, () => row)
        await update($, log, list => [...list, row].slice(-200))
        await appendLog($, { ...row, text: e.text, decided: decided ? MODEL[decided.tier] : undefined })
      }
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const decision = isMain ? ((await read($, currentAtom)) ?? undefined) : agentPick(e.agentId!, e.model)

    // Haiku takes no effort setting. While effortless is on, it keeps the effort it set.
    const effortOwned = await read($, effortless)
    // `e` is the app's own request, before arne touches it: its effort is what the native control says.
    if (isMain && (e.effort ?? null) !== (await read($, appEffort))) await update($, appEffort, () => e.effort ?? null)
    // No request's model is rewritten: the main loop's moves with the real /model (17c), a subagent's was
    // set at agent.spawn (17x). Only the effort is set here.
    const model = e.model
    const routed = decision
      ? { ...e, model, effort: effortOwned || decision.keepEffort ? e.effort : tierOf(model) === 'S' ? undefined : decision.effort }
      : e
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
    await read($, liveRev) // subscribes: the subagent toggle reads `live` (17x)
    const l = await read($, last)
    const c = await read($, cache)
    const forced = await read($, shown)
    // The band always draws, so the pickers are there before the first request too.
    // The atom read subscribes this render to the 1s tick; the time itself comes from the clock, since the
    // tick only starts at session.start and a hot reload skips that (a frozen tick showed a stale cache state).
    await read($, clockNow)
    await read($, pinRev) // subscribes: the pin itself is read from the store, which does not
    const now: number = await $.clock.now()
    const tier = c ? c.model : undefined
    const left = c && tier ? (c.warmUntil[tier] ?? 0) - now : 0
    if (left > 0) armTick($) // after a reload the tick is gone; a warm band starts it again
    const { Box, Button, Select, Text } = $.ui.resolve(e)
    // The width the band gets, re-read on every render: AbovePrompt's bodyColumns, else the viewport's columns.
    const cols = Number((e as any).props?.bodyColumns ?? e.viewport?.columns ?? 80)
    const narrow = cols < 72
    // The desktop draws a Button as its own native button and flattens Text children into one plain label,
    // so there the resting line is styled Text in a row and only the chevron is the button.
    const gui = e.surface !== 'terminal'
    // A cold chat under coldTokens is cheap to re-warm: no offer. A dismissal lasts until the cache warms again.
    const heldText = await read($, held)
    const pin = (await settings($)).pin
    const whyIsOpen = await read($, whyOpen)
    const picker = await read($, appPicker)
    // Before the first turn (a new chat, a reload) no turn has said the model yet: ask the session (2).
    const running: string | null = (await read($, sessionModel)) ?? (await Promise.resolve($.session.model()).catch(() => null)) ?? null
    const offer = await coldOffer($, now)
    const pinned = Boolean(pin?.tier || pin?.effort)
    const thankedKey = await read($, thanked)
    const judgeDown = await read($, layaDown)
    const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
    // The cold alert's copy: how long the cache has been cold, and what a summary costs against a plain resend.
    const money = (a: 'compact' | 'continue') => {
      const row = offer?.rows.find(x => x.action === a)
      return row ? `$${dollars(row.first).toFixed(2)}` : ''
    }
    const coldLine = offer
      ? `The cache went cold, so your next message re-reads all ${Math.round(offer.c.C / 1000)}k tokens: ${money('continue')}. A ${cap(live.compactModel)} summary first costs ${money('compact')}.`
      : 'The cache went cold. Your message is waiting.'
    const effortOn = await read($, effortless)
    const isDisabling = await read($, disabling)
    // While a compact arne started runs, an alert's actions give way to this.
    const busy = (await read($, compacting)) ? <Text key="busy" color="subtle">summarizing…</Text> : undefined
    const heavyGone = c ? (await read($, heavyDismissed)) === (c.warmUntil[c.model] ?? 0) : false
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
    const appModel = mode === 'on' ? undefined : (running ?? undefined)
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
    // At rest the band is one pressable line, read like Claude's limit banner: the arne mark, model and
    // effort, the reason, and the cache on the right. Pressing it opens a small panel under it.
    // Model and effort words keep a fixed width, so nothing moves sideways between turns.
    const open = whyIsOpen // the whyOpen atom now holds "panel open"
    // Closing the panel also clears the handoff note.
    const toggle = async () => {
      // The Laya line shows on the first open of a chat only: closing the panel marks it seen (4).
      if (open) await update($, layaHinted, () => true)
      await update($, whyOpen, o => !o)
      await update($, handedOff, () => null)
    }
    // The model the chat really runs, when known; MODEL.M only stands in for the words.
    const realModel = appModel ?? l?.model ?? running ?? undefined
    const runModel = realModel ?? MODEL.M
    const modelWord = shortModel(runModel)
    const effortWord = tierOf(runModel) === 'S' ? '' : ((mode === 'on' && l ? l.effort : await read($, appEffort)) ?? '')
    // A decision the chat's cache holds back: the band says which model it wanted and that the switch waits.
    const waiting = l?.waitFor && tierOf(l.waitFor) !== tierOf(l.model) ? l.waitFor : undefined
    const reason =
      band.state === 'routing'
        ? 'routing…'
        : waiting
          ? `${shortModel(waiting)} fits better; switching waits for the cache`
          : l
            ? plainReason(l.reason)
            : ''
    // Auto picked this model and effort (no pin, no wait on the cache): the band says it was routed.
    const routedNow = Boolean(l) && !pinned && !waiting
    const modelText = `${routedNow ? 'auto · ' : ''}${modelWord}${effortWord ? ` · ${effortWord}` : ''}${routedNow && !narrow ? ' (routed)' : ''}`
    // The resting line with no decision yet: the model and effort the chat runs, never a bare "auto" (2).
    const decided = Boolean(l) || band.state === 'routing'
    const lineText = decided ? modelText : realModel ? `${pinned ? '' : 'auto · '}${modelText}` : 'auto'
    const minutes = Math.ceil(left / 60_000)
    const chatK = c ? `${Math.round(c.C / 1000)}k` : ''
    // The cache text in three lengths; the resting line picks the longest that fits (fitRest).
    const cacheLong = c ? (left > 0 ? `cache warm ${minutes}m · ${chatK}` : `cache cold · ${chatK}`) : ''
    const cacheMid = c ? (left > 0 ? `cache ${minutes}m` : 'cache cold') : ''
    const cacheShort = c ? (left > 0 ? `${minutes}m` : 'cold') : ''
    const cacheWords = cacheLong
    const cool = left > 0 && left < 5 * 60_000
    // What the last turn cost: its output and cache reads at the tier's price. ponytail: leaves out uncached input.
    const lastTier = l ? tierOf(l.model) : undefined
    const lastCost = l && lastTier ? dollars(PRICE[lastTier] * (l.out * OUT + l.cacheRead * READ)) : 0
    // A segmented group: the selected segment is the raised grey (secondary), the others are plain text.
    const segment = (key: string, options: { value: string; label: string }[], active: string, pick: (v: string) => void) =>
      options.map(o =>
        o.value === active ? (
          <Button key={`${key}-${o.value}`} variant="secondary" label={o.label} onPress={() => pick(o.value)} />
        ) : (
          <Button key={`${key}-${o.value}`} plain label={o.label} onPress={() => pick(o.value)} />
        ),
      )
    // An alert row: the message on the left, its actions on the right.
    // Its buttons drop under the message, aligned right, when there is no room beside it.
    const banner = (key: string, message: string, actions: unknown) => (
      <Box key={key} flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2} borderStyle="round" borderColor="warning" paddingX={gui ? undefined : 1}>
        <Text>{message}</Text>
        <Box flexDirection="row" flexWrap="wrap" justifyContent="flex-end" flexGrow={1} gap={1}>
          {actions as any}
        </Box>
      </Box>
    )
    const lastNote = lastCost > 0 ? ` Last turn $${lastCost.toFixed(2)}.` : ''
    // The resting line at this width: the head never shrinks, the reason fills the rest, the cache steps down.
    const head = `arne  ${lineText}`
    // The card's border and padding take 4 columns, the chevron 2, the cache dot 2, the arne mark 2.
    const rest = fitRest(cols - (c ? 10 : 8), head, reason, c ? [cacheLong, cacheMid, cacheShort] : [''])
    const why = judgeDown
      ? 'Laya not running, Haiku judged.'
      : !l
        ? 'No decision yet.'
        : pinned
        ? 'Pinned. arne keeps your pick until you choose Auto.'
        : waiting
          ? `${cap(plainReason(l.reason))}, so ${shortModel(waiting)} fits better. Switching now re-reads ${chatK} tokens, so arne stays on ${modelWord} until the cache cools.${lastNote}`
          : `${modelWord} because ${plainReason(l.reason)}.${lastNote}`
    // 17w: a cheaper tier fits but switching on the warm cache does not pay, so the panel prices the three
    // ways on from coldAdvice: stay, switch in this chat, or hand off to a fresh chat on that tier.
    const want = waiting ? tierOf(waiting) : undefined
    const doneTo = await read($, handedOff)
    const name = (t: Tier) => shortModel(MODEL[t])
    let costs: { key: string; label: string; money: string; best: boolean; tier?: Tier }[] = []
    if (c && want && !pinned && !doneTo && left > 0 && PRICE[want] < PRICE[c.model] && planSwitch({ decided: want, chat: c.model, C: c.C, warmUntil: c.warmUntil, now }).why === 'sticky') {
      const rows = coldAdvice(c.C, c.model, c.warmUntil, now).rows
      const stay = rows.find(r => r.action === 'continue')!
      const sw = rows.find(r => r.action === 'switch' && r.to === want)!
      const ho = rows.find(r => r.action === 'handoff' && r.to === want)!
      const best = [stay, sw, ho].reduce((a, b) => (overTurns(b) < overTurns(a) ? b : a))
      const usd = (u: number) => (dollars(u) < 0.01 ? 'under $0.01' : `$${dollars(u).toFixed(2)}`)
      const payoff = (r: CostRow) => {
        const n = paysOffAfter(r, stay)
        return n === undefined ? " · doesn't pay off soon" : n === 0 ? ' · cheaper from the start' : ` · pays off after ${n} turn${n === 1 ? '' : 's'}`
      }
      const money = (r: CostRow, note = '') => `${usd(r.first)} now${note}, ${usd(r.after)} a turn${r === stay ? '' : payoff(r)}`
      costs = [
        { key: 'stay', label: `Stay on ${name(c.model)}`, money: money(stay), best: best === stay },
        { key: 'switch', label: `Switch to ${name(want)} in this chat`, money: money(sw, ' (re-reads the whole chat cold)'), best: best === sw },
        { key: 'handoff', label: `Handoff to ${name(want)}`, money: money(ho, ` (${cap(live.compactModel)} summary plus a small new chat)`), best: best === ho, tier: want },
      ]
    }
    const menuOpen = await read($, handoffMenu)
    const subs: SubCount = (await read($, subCount)) ?? {}
    const moved = (['S', 'M', 'L'] as Tier[]).filter(t => subs[t]).map(t => `${subs[t]} to ${name(t)}`)
    const parts = [...moved, subs.kept && `${subs.kept} kept`, subs.asked && `${subs.asked} as asked`].filter(Boolean)
    const routedN = (['S', 'M', 'L', 'kept'] as const).reduce((n, k) => n + (subs[k] ?? 0), 0)
    const subLine = !live.subagents
      ? narrow ? '' : 'left on the model they ask for'
      : parts.length
        ? narrow ? `${routedN} routed` : `${routedN} routed this chat (${parts.join(', ')})`
        : narrow ? '' : 'none yet this chat'
    const hinted = await read($, layaHinted)
    // Haiku's note only when the chat really runs Haiku; "picked" only after a decision (1, 7).
    const effortNote = pin?.effort
      ? 'pinned'
      : l && effortWord
        ? narrow ? effortWord : `picked ${effortWord}`
        : realModel && tierOf(realModel) === 'S' && !narrow
          ? 'Haiku takes no effort'
          : ''
    const alertTier = await handoffTier($)
    // A handoff to the chat's own tier only starts a new chat: say that (5).
    const alertLabel = c && alertTier === c.model ? `New chat on ${name(alertTier)}` : `Handoff to ${name(alertTier)}`
    return (
      <Box flexDirection="column" rowGap={gui ? 1 : 0}>
        {effortOn &&
          banner(
            'alert-effortless',
            'effortless is on: it sets effort too. Disable it and restart.',
            isDisabling ? (
              <Text key="disabling" color="subtle">disabling…</Text>
            ) : (
              <Button key="disable-effortless" variant="primary" label="Disable effortless" onPress={() => disableEffortless($)} />
            ),
          )}
        {heldText &&
          banner(
            'alert-held',
            coldLine,
            busy ?? [
              <Button key="send-anyway" plain label="Send as is" onPress={() => sendAnyway($)} />,
              <Button key="compact-send" variant="primary" label="Summarize, then send" onPress={() => compactAndSend($)} />,
            ],
          )}
        {offer &&
          !heldText &&
          banner(
            'alert-cold',
            coldLine,
            busy ?? [
              <Button key="compact" variant="primary" label="Summarize" onPress={() => compactNow($, '')} />,
              <Button key="handoff" plain label={alertLabel} onPress={(p: any) => handoff($, alertTier, p?.surface)} />,
              <Button key="continue" plain role="dismiss" label="Dismiss" onPress={async () => {
                  // One Dismiss covers the whole cold spell: the heavy alert would otherwise take its place.
                  const until = offer.c.warmUntil[offer.c.model] ?? 0
                  await update($, heavyDismissed, () => until)
                  await update($, coldDismissed, () => until)
                }} />,
            ],
          )}
        {/* A big chat with a warm cache is never a reason for an alert (17p): only once it has gone cold. */}
        {/* By size, not band.state: the band reads a cold chat as "cold" before "heavy", so that never matched here. */}
        {!forced &&
          c &&
          c.C >= live.heavyTokens &&
          left <= 0 &&
          !offer &&
          !heavyGone &&
          banner(
            'alert-heavy',
            `Chat is ${chatK} tokens. Compacting with ${cap(live.compactModel)} costs $${dollars(costCompact(c.C, 4000, TIER_OF[live.compactModel] ?? 'S')).toFixed(2)}; resending the whole chat costs $${dollars(costContinue(c.C, c.model, false)).toFixed(2)}.`,
            busy ?? [
              // role="dismiss" only tells the surface how to draw it; the press itself hides the alert for this cold spell.
              <Button key="dismiss" plain role="dismiss" label="Dismiss" onPress={() => update($, heavyDismissed, () => c.warmUntil[c.model] ?? 0)} />,
              <Button key="handoff" plain label={alertLabel} onPress={(p: any) => handoff($, alertTier, p?.surface)} />,
              <Button key="compact-send" variant="primary" label="Summarize, then continue" onPress={() => compactThenContinue($)} />,
            ],
          )}
        <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={gui ? undefined : 1}>
          {mode === 'paused' ? (
            <Box flexDirection="row" gap={1}>
              <Text color="claude">◆</Text>
              <Text>arne</Text>
              <Text color="subtle">paused · you picked {appModel ? shortModel(appModel) : 'a model'}</Text>
              <Button key="auto" plain label="Resume" onPress={() => toggleAuto($)} />
            </Box>
          ) : mode === 'off' ? (
            <Box flexDirection="row" gap={1}>
              <Text color="claude">◆</Text>
              <Text>arne</Text>
              <Text color="subtle">off</Text>
              <Button key="auto" plain label="Turn on" onPress={() => toggleAuto($)} />
            </Box>
          ) : (
            <Box flexDirection="column">
              {gui ? (
                <Box key="band-line" flexDirection="row" alignItems="center" gap={1}>
                  <Text color="claude">◆</Text>
                  <Text bold>arne</Text>
                  <Text color={decided ? undefined : 'subtle'}>{lineText}</Text>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    {reason !== '' && <Text color="subtle" wrap="truncate-end">{reason}</Text>}
                  </Box>
                  {cacheWords !== '' && <Text color={left <= 0 ? 'inactive' : cool ? 'warning' : 'success'}>●</Text>}
                  {cacheWords !== '' && <Text color="subtle">{rest.cache}</Text>}
                  <Button key="band" plain label={open ? '▴' : '▾'} onPress={toggle} />
                </Box>
              ) : (
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Button key="band" plain onPress={toggle}>
                  <Text color="claude">◆ </Text>
                  <Text bold>arne</Text>
                  <Text color={decided ? undefined : 'subtle'}>{`  ${lineText}`}</Text>
                  {rest.reason !== '' && <Text color="inactive">{`  ${rest.reason}`}</Text>}
                </Button>
                {/* The cache and the chevron sit at the right end, as in the design. The dot carries warm, cooling or cold. */}
                <Button key="band-cache" plain onPress={toggle}>
                  {cacheWords !== '' && <Text color={left <= 0 ? 'inactive' : cool ? 'warning' : 'success'}>● </Text>}
                  {cacheWords !== '' && <Text color="subtle">{rest.cache}</Text>}
                  <Text color="subtle">{open ? ' ▴' : ' ▾'}</Text>
                </Button>
              </Box>
              )}
              {/* Plugins cannot move the app's model menu, so a mismatch shows on the band itself, not only in the panel. */}
              {picker && running && tierOf(picker) !== tierOf(running) && (
                <Text color="warning" wrap="truncate-end">{`⇄ The app's model menu shows ${shortModel(picker)}; arne runs ${shortModel(running)}. Plugins can't change that menu.`}</Text>
              )}
              {open && (
                <Box flexDirection="column" gap={1} marginTop={1}>
                  {/* Each row: a fixed-width label, the segments as one group that never splits, then the note. */}
                  <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
                    <Box flexDirection="row" alignItems="center" flexShrink={0}>
                      <Box width={10} flexShrink={0}>
                        <Text color="subtle">Model</Text>
                      </Box>
                      {segment(
                        'model',
                        [{ value: 'auto', label: 'Auto' }, { value: 'haiku', label: 'Haiku' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }],
                        pin?.tier ? TIER_NAME_OF[pin.tier] : 'auto',
                        v => void setPinPart($, { tier: v === 'auto' ? undefined : TIER_OF[v] }),
                      )}
                    </Box>
                    {/* No decision, no "picked"; narrow, the bare word, so the row stays one line (1, 7). */}
                    {(pin?.tier || l) && <Text color="subtle">{pin?.tier ? 'pinned' : narrow ? modelWord : `picked ${modelWord}`}</Text>}
                  </Box>
                  <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
                    <Box flexDirection="row" alignItems="center" flexShrink={0}>
                      <Box width={10} flexShrink={0}>
                        <Text color="subtle">Effort</Text>
                      </Box>
                      {segment(
                        'effort',
                        [
                          { value: 'auto', label: 'Auto' },
                          ...(['low', 'medium', 'high', 'xhigh', 'max'] as const).map(v => ({
                            value: v,
                            label: narrow ? EFFORT_LABEL_SHORT[v] : EFFORT_LABEL[v],
                          })),
                        ],
                        pin?.effort ?? 'auto',
                        v => void setPinPart($, { effort: v === 'auto' ? undefined : (v as Pin['effort']) }),
                      )}
                    </Box>
                    {effortNote !== '' && <Text color="subtle">{effortNote}</Text>}
                  </Box>
                  <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2} justifyContent="space-between">
                    <Text>{why}</Text>
                    {/* The two ratings are one group that never splits (4). */}
                    {l && !pinned && thankedKey !== l.key && (
                      <Box flexDirection="row" flexShrink={0} gap={1}>
                        <Button key="up" plain label="Good call" onPress={() => feedback($, 'up')} />
                        <Button key="down" plain label="Wrong call" onPress={() => feedback($, 'down')} />
                      </Box>
                    )}
                    {l && !pinned && thankedKey === l.key && <Text color="subtle">Saved for Laya's training.</Text>}
                  </Box>
                  {/* What a rating is for, under the two buttons (17v): once a chat, not on every open (4). */}
                  {l && !pinned && !hinted && thankedKey !== l.key && <Text color="subtle">Ratings train Laya, your local judge. Saved only on this machine.</Text>}
                  {costs.length > 0 && (
                    <Box flexDirection="column">
                      {costs.map(r => (
                        <Box key={`cost-${r.key}`} flexDirection="row" alignItems="center" columnGap={2}>
                          {/* The handoff row's label is its button, so the button never sits on a line of its own (3). */}
                          {r.tier && !busy ? (
                            <Button key="handoff-row" plain label={r.label} onPress={(p: any) => handoff($, r.tier!, p?.surface)} />
                          ) : (
                            <Text>{r.label}</Text>
                          )}
                          <Box flexShrink={1}>
                            <Text color="subtle">{`${r.money}${r.best ? ' · best' : ''}`}</Text>
                          </Box>
                        </Box>
                      ))}
                    </Box>
                  )}
                  {/* What arne did with this chat's subagents, and the switch for it (17x). */}
                  <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
                    <Box flexDirection="row" alignItems="center" flexShrink={0}>
                      <Box width={10} flexShrink={0}>
                        <Text color="subtle">Subagents</Text>
                      </Box>
                      {segment('subs', [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], live.subagents ? 'on' : 'off', v => void setOption($, 'subagents', v === 'on'))}
                    </Box>
                    {subLine !== '' && <Text color="subtle">{subLine}</Text>}
                  </Box>
                  {doneTo && <Text color="subtle">{`Handed off to ${name(doneTo as Tier)}. Old chat saved in history; archive it from the sidebar when you are done.`}</Text>}
                  <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2} justifyContent="space-between">
                    <Box flexDirection="row" flexWrap="wrap" gap={2}>
                      <Button key="auto" plain label="Turn off" onPress={() => toggleAuto($)} />
                      <Button key="gear" plain label="Settings" onPress={() => $.ui.open({ id: SETTINGS, title: 'arne settings' })} />
                      {/* While the costs table shows, its handoff row is the one Handoff (3). */}
                      {costs.length === 0 && (busy ?? <Button key="handoff-menu" plain label="Handoff…" onPress={() => update($, handoffMenu, o => !o)} />)}
                      {menuOpen &&
                        !busy &&
                        costs.length === 0 &&
                        (['S', 'M', 'L'] as Tier[]).map(t => (
                          <Button key={`handoff-${TIER_NAME_OF[t]}`} plain label={`to ${name(t)}`} onPress={(p: any) => handoff($, t, p?.surface)} />
                        ))}
                    </Box>
                    {!narrow && <Text color="subtle">Esc to close</Text>}
                  </Box>
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  // The settings pane: a label and a segmented control per row. A press shows the new value at once, then
  // writes it through $.config.set (setOption), so the pane and /config never disagree.
  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    await read($, liveRev) // subscribes: the rows read `live`
    const { Box, Button, Text } = $.ui.resolve(e)
    // Narrow, as in the band: the short effort names, and a row's segments drop under its label.
    const narrow = Number((e as any).props?.bodyColumns ?? e.viewport?.columns ?? 80) < 72
    const gui = e.surface !== 'terminal'
    const choice = (label: string, key: keyof Live, options: { value: unknown; label: string }[]) => {
      const set = (value: unknown) => setOption($, key, value)
      return (
        <Box key={key} flexDirection="row" flexWrap="wrap" alignItems="center" justifyContent="space-between" columnGap={2}>
          <Text>{label}</Text>
          <Box flexDirection="row" flexWrap="wrap" flexGrow={1} justifyContent="flex-end" columnGap={1}>
            {options.map(o =>
              o.value === live[key] ? (
                <Button key={`${key}-${String(o.value)}`} variant="secondary" label={o.label} onPress={() => set(o.value)} />
              ) : (
                <Button key={`${key}-${String(o.value)}`} plain label={o.label} onPress={() => set(o.value)} />
              ),
            )}
          </Box>
        </Box>
      )
    }
    const MODELS = [{ value: 'haiku', label: 'Haiku' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }]
    const EFFORTS = (['low', 'medium', 'high', 'xhigh', 'max'] as const).map(v => ({ value: v, label: (narrow ? EFFORT_LABEL_SHORT : EFFORT_LABEL)[v] }))
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={2}>
          <Text bold>arne settings</Text>
          <Button role="dismiss" plain label="Done" onPress={() => undefined} />
        </Box>
        {/* Each group: a caption over a bordered card of rows, as in the design's inset lists. */}
        <Box flexDirection="column">
          <Text color="subtle">Routing</Text>
          <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={gui ? undefined : 1}>
            {choice('Auto routing', 'auto', [{ value: true, label: 'On' }, { value: false, label: 'Off' }])}
            {choice('Judge', 'backend', [
              { value: 'heuristic', label: 'Rules only' },
              { value: 'haiku', label: 'Haiku' },
              { value: 'laya', label: 'Laya' },
            ])}
            {choice('Subagents', 'subagents', [{ value: true, label: 'Route' }, { value: false, label: 'Leave' }])}
          </Box>
          {live.backend === 'laya' && (
            <Text color="subtle">Laya runs on this machine through laya-serve. Until it answers, Haiku judges.</Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text color="subtle">Range</Text>
          <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={gui ? undefined : 1}>
            {choice('Cheapest model', 'modelFloor', MODELS)}
            {choice('Strongest model', 'modelCeiling', MODELS)}
            {choice('Lowest effort', 'effortFloor', EFFORTS)}
            {choice('Highest effort', 'effortCeiling', EFFORTS)}
          </Box>
        </Box>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={2}>
          <Text color="inactive">Also in /config.</Text>
          <Button key="open-stats" plain label="Stats" onPress={() => openStats($)} />
        </Box>
      </Box>
    )
  })

  // Stats (17q): what arne saved against running every turn on Opus or Sonnet at medium. An estimate, said so.
  on('ui.render', { component: 'Pane', requestId: STATS }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const cols = Number((e as any).props?.bodyColumns ?? e.viewport?.columns ?? 80)
    const gui = e.surface !== 'terminal'
    const period = (await read($, statsPeriod)) as Period
    // Parsed once at open (openStats); a pane drawn without that open (a restore) parses here.
    const st = (await read($, statsData))?.[period] ?? (await statsFor($, period))
    const usd = (v: number) => `$${v.toFixed(2)}`
    // Bars as text, so they follow the theme: one accent for arne, subtle for the baselines.
    const room = Math.max(10, Math.min(40, cols - 24))
    const max = Math.max(st.spent, st.sonnet, st.opus, 1e-9)
    const bar = (v: number) => '█'.repeat(Math.max(v > 0 ? 1 : 0, Math.round((v / max) * room)))
    const tile = (name: string, base: number) => {
      const t = savedText(st.spent, base)
      return (
        <Box key={`tile-${name}`} flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={gui ? undefined : 1} flexGrow={1}>
          <Text color="subtle">{`Against ${name}`}</Text>
          <Text bold>{t.headline}</Text>
          <Text color="subtle">{t.sub}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" justifyContent="space-between" columnGap={2}>
          <Text bold>Stats</Text>
          <Box flexDirection="row" columnGap={1}>
            {PERIODS.map(([p, label]) =>
              p === period ? (
                <Button key={`period-${p}`} variant="secondary" label={label} onPress={() => update($, statsPeriod, () => p)} />
              ) : (
                <Button key={`period-${p}`} plain label={label} onPress={() => update($, statsPeriod, () => p)} />
              ),
            )}
            <Button role="dismiss" plain label="Done" onPress={() => undefined} />
          </Box>
        </Box>
        {st.turns === 0 && st.lines.length === 0 ? (
          <Text color="subtle">No turns with usage in this period yet.</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection={cols < 60 ? 'column' : 'row'} gap={1}>
              {tile('Opus · medium', st.opus)}
              {tile('Sonnet · medium', st.sonnet)}
            </Box>
            <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={gui ? undefined : 1}>
              {([['With arne', st.spent, 'claude'], ['Sonnet · medium', st.sonnet, 'subtle'], ['Opus · medium', st.opus, 'subtle']] as const).map(([label, v, color]) => (
                <Box key={`bar-${label}`} flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text color={label === 'With arne' ? undefined : 'subtle'}>{label}</Text>
                    <Text>{usd(v)}</Text>
                  </Box>
                  <Text color={color}>{bar(v)}</Text>
                </Box>
              ))}
            </Box>
            <Box flexDirection="column">
              <Text color="subtle">Where it went</Text>
              <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={gui ? undefined : 1}>
                {st.lines.map(l => (
                  <Box key={`line-${l.label}`} flexDirection="row" columnGap={2}>
                    <Box flexGrow={1}>
                      <Text>{l.label}</Text>
                    </Box>
                    <Text color="subtle">{l.label === 'Switches and summaries' ? String(l.count) : `${l.count} turn${l.count === 1 ? '' : 's'}`}</Text>
                    <Text>{usd(l.cost)}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        )}
        <Text color="subtle">An estimate: each turn's real tokens, priced again as if every turn ran on Opus at medium effort, or on Sonnet at medium effort. Model switches and summaries count against arne.</Text>
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
