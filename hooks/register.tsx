import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { JEV_MODEL, JEV_URL, LAYA_URL, parseVerdict, SYSTEM, SYSTEM_ONE_TIMEOUT_MS, systemOneBody, systemOneVerdict } from './backends'
import { bandText, CACHE_TTL, clampEffort, clampTier, coldAdvice, contextOf, costCompact, costContinue, dollars, EFFORT_LABEL, EFFORT_LABEL_SHORT, EFFORT_RANK, fillOf, fitRest, fitTier, midTask, mmss, nextTtl, overTurns, paysOffAfter, plainReason, planSwitch, shortModel, summaryPrompt, tierOf, PRICE, OUT, READ } from './econ'
import type { BandState, Row as CostRow } from './econ'
import { MODEL, failedAttempt, route } from './route'
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
// True while Jev is the judge but no TypeSafe key is found (17s); the why line then says Haiku judged.
const jevNoKey = atom({ plugin: 'arne', key: 'jevNoKey' } as const, false)
// The typesafe_key option (sensitive: secure storage, never settings.json). Kept here only, never in an atom,
// a log row or on screen.
let optionKey = ''
// The TypeSafe key: TYPESAFE_API_KEY first, then the option.
const typesafeKey = async ($: any): Promise<string | undefined> => (await Promise.resolve($.env.get('TYPESAFE_API_KEY')).catch(() => undefined)) || optionKey || undefined
const ADD_KEY_HINT = 'Set it in /config → arne → TypeSafe API key, or the TYPESAFE_API_KEY environment variable.'
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
// This chat's subagents (17x): how many arne moved to each tier, kept on their model, ran as asked, or capped (17y).
const subCount = atom({ plugin: 'arne', key: 'subCount' } as const, null)
type SubCount = Partial<Record<Tier | 'kept' | 'asked' | 'capped', number>>
const countSpawn = ($: any, k: keyof SubCount) => update($, subCount, (c: SubCount | null) => ({ ...c, [k]: ((c ?? {})[k] ?? 0) + 1 }))
// The Stats pane's three periods, parsed from the log once per open rather than on every press.
const statsData = atom({ plugin: 'arne', key: 'stats' } as const, null)
// What the band's panel shows: its main rows, Settings or Stats. In the app a Pane lost the first press
// of every button, so Settings and Stats moved into the band, whose buttons answer at once.
type View = 'main' | 'settings' | 'stats'
const panelView = atom({ plugin: 'arne', key: 'panelView' } as const, 'main')
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

// Card colours. On a dark theme the prompt box's outline colour, so arne's cards match it. No fill: it paints a square box behind the rounded border; any other theme keeps its keys.
let CARD: { border: string } = { border: 'promptBorder' }
let cardSynced = false
async function syncCard($: any) {
  if (cardSynced) return
  const row = (await $.config.list().catch(() => [])).find((r: any) => r.key === 'theme')
  if (!row) return
  cardSynced = true
  if (String(row.value).startsWith('dark')) CARD = { border: '#4d4d4c' }
}

// --- Handoff (17o, 17w) ---
// Haiku summarizes the chat into arne-handoff.md and the clipboard. Setting Handoff = newchat (default): a
// toast asks the person to open a new chat on `tier` and paste; no plugin call opens a chat or pastes into
// one. Handoff = clear: /clear starts a fresh chat in place, pinned to `tier`, whose first message is the
// summary. One at a time (the compacting atom).
const HANDOFF_FILE = 'arne-handoff.md'
const ARCHIVE_DIR = 'arne-archive'
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
    step = 'the clipboard'
    const copied = await $.ui.copy({ text, surface }).catch(() => undefined)
    if (copied?.isCopied === false) throw new Error('copy')
    if (live.handoff !== 'clear') {
      // No plugin call opens a new chat or pastes into one, so the old chat is left alone.
      await update($, handedOff, () => tier)
      $.ui.toast(`Handoff copied. Open a new chat on ${shortModel(MODEL[tier])} and paste. This chat is untouched.`)
      return
    }
    // The whole old chat, kept as a file before /clear: the sidebar history alone is not a copy.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const transcript = said.map((m: any) => `## ${m.role ?? 'message'}\n\n${m.text}`).join('\n\n')
    await $.fs.write(`${ARCHIVE_DIR}/handoff-${stamp}.md`, `# Chat before handoff\n\n${transcript}\n`).catch(() => undefined)
    step = '/clear'
    await $.command.run({ command: 'clear', args: '' })
    await update($, cache, () => null) // the new chat has no cache yet
    await update($, subCount, () => null)
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
// After an escalation, the next HOLD_TURNS prompts stay at least on its tier, so a judge that read the retry
// as small does not drop straight back to the model that failed (claude-router holds 2 turns too).
const HOLD_TURNS = 2
let hold: { tier: Tier; left: number } | undefined
const RANK: Record<Tier, number> = { S: 0, M: 1, L: 2 }
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
  subagents: string // 17y: the dearest model a subagent may run on (haiku, sonnet, opus), or off
  handoff: string // newchat: copy the summary and ask for a new chat; clear: /clear this chat and send it
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
  subagents: 'off', // experimental: routing a subagent is opt-in
  handoff: 'newchat',
}
// 17y: Subagents was On/Off before it became a ceiling; On reads as Sonnet, Off as off. Auto is no ceiling (Opus).
const subCeiling = (v: unknown) => (v === false || v === 'off' ? 'off' : v === 'auto' || TIER_OF[String(v)] ? String(v) : v === true ? 'sonnet' : 'auto')
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
  const rows: { key: string; provider?: unknown }[] = await $.config.list().catch(() => [])
  const named = rows.filter(row => row.key.endsWith(`.${field}`) || row.key === field)
  // The provider's shape isn't documented: any arne in the key or the provider object marks arne's row.
  const mine = named.filter(row => JSON.stringify([row.key, row.provider ?? null]).includes('arne'))
  if (mine.length > 1) return { deny: 'two copies of arne are enabled; turn one off in /plugin' }
  if (mine.length) return mine[0]!.key !== key ? setOnce($, mine[0]!.key, value) : r
  // The engine lists no row for this option at all: nothing can persist it, but the surfaces already hold
  // the value, so it applies for this session instead of rolling back with an error.
  if (!named.length) return { value }
  // Name the rows it saw, so a toast says what the engine calls this option.
  return { deny: `${r.deny.replace(/\)$/, '')}; rows ending .${field}: ${named.map(row => row.key).join(', ') || 'none'})` }
}

// Puts one option into `live` and onto every surface: the band (isOff), the Settings pane (liveRev), the status line.
async function applyLive($: any, field: keyof Live, value: unknown) {
  ;(live as Record<string, unknown>)[field] = field === 'subagents' ? subCeiling(value) : value
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
    // No previous verdict here: the judge anchored on it and kept repeating Opus ("aight go on" → Opus).
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
  // System One (17s): laya-serve and Jev take the same request with the task card in its state.
  // No answer within 1.5 s falls through to Haiku.
  const systemOne = async (url: string, headers: Record<string, string>, text: string, model?: string) => {
    const r = await Promise.race([
      $.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: systemOneBody(text, card, model) }),
      $.clock.sleep(SYSTEM_ONE_TIMEOUT_MS).then(() => undefined),
    ])
    return r?.ok ? JSON.parse(r.text) : undefined
  }
  const laya: Backend = {
    name: 'laya',
    ask: async text => systemOneVerdict((await systemOne(`${LAYA_URL}/v1/systemone`, {}, text))?.answers, 'laya'),
  }
  const jev: Backend = {
    name: 'jev',
    ask: async text => {
      // Never stored, logged or shown. No key, no request.
      const key = await typesafeKey($)
      if (!key) return undefined
      const j = await systemOne(JEV_URL, { authorization: `Bearer ${key}` }, text, JEV_MODEL)
      // Jev's prices are not published, so Stats counts its tokens on a row of their own.
      const u = j?.usage
      if (u) await appendLog($, { type: 'usage', at: await $.clock.now(), kind: 'jev', model: JEV_MODEL, input: u.input_tokens ?? 0, read: 0, write: 0, out: u.output_tokens ?? 0 })
      return systemOneVerdict(j?.answers, 'jev')
    },
  }
  return backend === 'laya' ? [laya, haiku] : backend === 'jev' ? [jev, haiku] : backend === 'haiku' ? [haiku] : []
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
  const jevKeyless = s.backend === 'jev' && !(await typesafeKey($))
  await update($, jevNoKey, () => jevKeyless)
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
    const api: any = await $.session.messages({ as: 'api' }).catch(() => [])
    const failed = failedAttempt(Array.isArray(api) ? api : [], text)
    let r = await route(text, { prev, failed, paused: await read($, isPaused), backends: backendsOf($, s.backend, card) })
    if (!r) return undefined
    if (r.source === 'escalate') hold = { tier: r.tier, left: HOLD_TURNS }
    else if (hold && hold.left-- > 0 && RANK[r.tier] < RANK[hold.tier]) r = { ...r, tier: hold.tier, reason: `${r.reason}; held after a failure` }
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
  // An escalation moves even on a warm cache: a cold write costs less than failing again.
  if (d.source === 'pin' || d.source === 'escalate') return MODEL[d.tier]
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

// Opens the band's panel on a view. Stats reads all three periods from one parse here, so a period
// press only redraws (17u).
async function openView($: any, view: View) {
  if (view === 'stats') {
    const text: string = await $.fs.read(await homePath($, LOG_FILE)).catch(() => '')
    const rows = parseUsage(text)
    const now: number = await $.clock.now()
    await update($, statsData, () => Object.fromEntries(PERIODS.map(([p]) => [p, summarize(rows, periodStart(p, now))])))
  }
  await update($, panelView, () => view)
  await update($, whyOpen, () => true)
}

// A view's header: "‹ Back" to the main panel, then the view's title.
function viewHead($: any, { Box, Button, Text }: any, title: string) {
  return (
    <Box key="view-head" flexDirection="row" alignItems="center" gap={1}>
      <Button key="back" plain label="‹ Back" onPress={() => update($, panelView, () => 'main')} />
      <Text weight="semibold">{title}</Text>
    </Box>
  )
}

// A picked segment: the raised fill alone is faint (1.35:1 on the dark card), so a ✓ marks it too.
const picked = (label: string, on: boolean) => (on ? `✓ ${label}` : label)
const SETTINGS_LABEL_W = 16 // "Strongest model" is the longest label

// The panel's Settings view: a label and a segmented control per row. A press shows the new value at
// once, then writes it through $.config.set (setOption), so the panel and /config never disagree.
function settingsView($: any, { Box, Button, Text }: any, gui: boolean, cols: number, needsKey = false) {
  // Every row is the same: the label in a fixed column, the options beside it. A row with many options
  // wraps under its own first option, never to the far edge.
  const choice = (label: unknown, key: keyof Live, options: { value: unknown; label: string }[]) => {
    const set = (value: unknown) => setOption($, key, value)
    return (
      <Box key={key} flexDirection="row" alignItems="flex-start" columnGap={2}>
        <Box width={SETTINGS_LABEL_W} flexShrink={0}>
          <Text>{label}</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1} columnGap={1} rowGap={1}>
          {options.map(o =>
            o.value === live[key] ? (
              <Button key={`${key}-${String(o.value)}`} variant="secondary" label={picked(o.label, true)} onPress={() => set(o.value)} />
            ) : (
              <Button key={`${key}-${String(o.value)}`} plain label={o.label} onPress={() => set(o.value)} />
            ),
          )}
        </Box>
      </Box>
    )
  }
  // Each group: a caption over a bordered card of rows, as in the design's inset lists.
  const card = (title: string, rows: unknown[], note?: unknown) => (
    <Box key={`card-${title}`} flexDirection="column" flexGrow={1}>
      <Text size="footnote" dimColor>{title}</Text>
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={CARD.border} paddingX={1} rowGap={gui ? 1 : 0}>
        {rows as any}
      </Box>
      {note as any}
    </Box>
  )
  const MODELS = [{ value: 'haiku', label: 'Haiku' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }]
  // The same names as the band: full from 72 columns, short below.
  const effortNames = cols < 72 ? EFFORT_LABEL_SHORT : EFFORT_LABEL
  const EFFORTS = (['low', 'medium', 'high', 'xhigh', 'max'] as const).map(v => ({ value: v, label: effortNames[v] ?? v }))
  return (
    <Box key="settings-view" flexDirection="column" gap={1}>
      {viewHead($, { Box, Button, Text }, 'Settings')}
      {/* The band is at most half the window and scrolls past that: from 90 columns the cards sit side by side. */}
      <Box key="settings-cards" flexDirection={cols >= 90 ? 'row' : 'column'} gap={cols >= 90 ? 2 : 1}>
        {card('Routing', [
          choice('Auto routing', 'auto', [{ value: true, label: 'On' }, { value: false, label: 'Off' }]),
          choice('Judge', 'backend', [
            { value: 'heuristic', label: 'Rules' },
            { value: 'haiku', label: 'Haiku' },
            { value: 'laya', label: 'Laya' },
            { value: 'jev', label: 'Jev' },
          ]),
          choice('Subagents', 'subagents', [
            { value: 'auto', label: 'Auto' },
            { value: 'haiku', label: 'Haiku' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'opus', label: 'Opus' },
            { value: 'off', label: 'Off' },
          ]),
        ], (
          // The judge's note sits under the card it describes. Jev's while it is the judge.
          <Box key="routing-notes" flexDirection="column">
            <Text size="footnote" dimColor>
              {live.backend === 'jev' ? 'Jev is hosted: your prompts leave this machine.' : 'Laya runs on this machine and learns from your ratings.'}
            </Text>
            {needsKey && (
              // No masked Input exists, so the key is never typed here: the button points to /config's secure field.
              <Box key="jev-key" flexDirection="row" flexWrap="wrap" columnGap={2}>
                <Text size="footnote" dimColor>Jev needs a TypeSafe key.</Text>
                <Button key="add-key" plain label="Add key…" onPress={() => $.ui.toast(ADD_KEY_HINT)} />
              </Box>
            )}
          </Box>
        ))}
        {card('Limits', [
          choice('Cheapest model', 'modelFloor', MODELS),
          choice('Strongest model', 'modelCeiling', MODELS),
          choice('Lowest effort', 'effortFloor', EFFORTS),
          choice('Highest effort', 'effortCeiling', EFFORTS),
          choice('Handoff', 'handoff', [{ value: 'newchat', label: 'New chat' }, { value: 'clear', label: 'Clear' }]),
        ])}
      </Box>
      <Box key="settings-notes" flexDirection="column">
        <Text size="footnote" dimColor>Subagents are experimental. Also in /config.</Text>
      </Box>
    </Box>
  )
}

const STATS_EMPTY: Record<Period, string> = { today: 'No turns today yet.', week: 'No turns in the last 7 days yet.', all: 'No turns yet.' }

// The panel's Stats view (17q): what arne saved against running every turn on Opus at medium.
// An estimate, said so. Back returns to the main panel.
async function statsView($: any, { Box, Button, Text }: any, cols: number, gui: boolean) {
  const period = (await read($, statsPeriod)) as Period
  // Parsed once at open (openView); a panel drawn without that open (a reload) parses here.
  const st = (await read($, statsData))?.[period] ?? (await statsFor($, period))
  const usd = (v: number) => `$${v.toFixed(2)}`
  // Bars as text, so they follow the theme: one accent for arne, dim for the baselines.
  const room = Math.max(10, Math.min(40, cols - 24))
  const max = Math.max(st.spent, st.opus, 1e-9)
  // ▆ not █: a full block touches the label's descenders above it.
  const bar = (v: number) => '▆'.repeat(Math.max(v > 0 ? 1 : 0, Math.round((v / max) * room)))
  const tile = (name: string, base: number) => {
    const t = savedText(st.spent, base)
    return (
      <Box key={`tile-${name}`} flexDirection="column" borderStyle="round" borderColor={CARD.border} paddingX={1} flexGrow={1}>
        <Text size="footnote" dimColor>{`Against ${name}`}</Text>
        <Text size="title" weight="semibold" tabular>{t.headline}</Text>
        <Text size="footnote" dimColor tabular>{t.sub}</Text>
      </Box>
    )
  }
  return (
    <Box key="stats-view" flexDirection="column" gap={1}>
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" justifyContent="space-between" columnGap={2} rowGap={1}>
        {viewHead($, { Box, Button, Text }, 'Stats')}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          {PERIODS.map(([p, label]) =>
            p === period ? (
              <Button key={`period-${p}`} variant="secondary" label={picked(label, true)} onPress={() => update($, statsPeriod, () => p)} />
            ) : (
              <Button key={`period-${p}`} plain label={label} onPress={() => update($, statsPeriod, () => p)} />
            ),
          )}
        </Box>
      </Box>
      {st.turns === 0 && st.lines.length === 0 ? (
        <Box flexDirection="column">
          <Text>{STATS_EMPTY[period]}</Text>
          <Text size="footnote" dimColor>Once there are, this shows what arne spent next to the same turns on Opus at medium effort. It is an estimate.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection={cols < 60 ? 'column' : 'row'} gap={1}>
            {tile('Opus · medium', st.opus)}
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor={CARD.border} paddingX={1} rowGap={gui ? 1 : 0}>
            {([['With arne', st.spent], ['Opus · medium', st.opus]] as const).map(([label, v]) => (
              <Box key={`bar-${label}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between">
                  <Text dimColor={label !== 'With arne'}>{label}</Text>
                  <Text tabular>{usd(v)}</Text>
                </Box>
                {label === 'With arne' ? <Text color="claude">{bar(v)}</Text> : <Text dimColor>{bar(v)}</Text>}
              </Box>
            ))}
          </Box>
          <Box flexDirection="column">
            <Text size="footnote" dimColor>Where it went</Text>
            <Box flexDirection="column" borderStyle="round" borderColor={CARD.border} paddingX={1}>
              {st.lines.map(l => (
                <Box key={`line-${l.label}`} flexDirection="row" columnGap={2}>
                  <Box flexGrow={1}>
                    <Text>{l.label}</Text>
                  </Box>
                  <Text dimColor tabular>{l.label === 'Switches and summaries' ? `${l.count} ${l.count === 1 ? 'time' : 'times'}` : `${l.count} ${l.tokens === undefined ? 'turn' : 'call'}${l.count === 1 ? '' : 's'}`}</Text>
                  <Text tabular>{l.tokens === undefined ? usd(l.cost) : `${l.tokens.toLocaleString('en-US')} tokens`}</Text>
                </Box>
              ))}
            </Box>
          </Box>
          <Text size="footnote" dimColor>An estimate: each turn's real tokens, priced again as if every turn ran on Opus at medium effort. Model switches and summaries count against arne.</Text>
        </Box>
      )}
    </Box>
  )
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
  live.subagents = subCeiling(live.subagents)
  optionKey = String((options as Record<string, unknown>).typesafe_key ?? '')

  // A write to an arne.* row from /config or another plugin lands here. arne's own writes never do: the
  // app skips a plugin's own hooks, and ownWrites makes the test kit skip them the same way (17u).
  on('config.set', async ($, e, next) => {
    if (ownWrites.has(e.key)) return next(e)
    const r = await next(e)
    // `arne.<field>`, or `arne@<marketplace>.<field>` while another arne is enabled too.
    const field = /^arne(@[^.]+)?\./.test(e.key) ? (e.key.slice(e.key.indexOf('.') + 1) as keyof Live) : undefined
    if (field && FIELDS.includes(field) && !('deny' in r)) await applyLive($, field, r.value)
    if ((field as string) === 'typesafe_key' && !('deny' in r)) {
      optionKey = String(r.value ?? '')
      await update($, liveRev, n => n + 1)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    // Busy flags are atoms, so they outlive a reload or a quit that cut their `finally` short: a new session clears them.
    await update($, compacting, () => false)
    await update($, compactSendingAtom, () => false)
    await update($, disabling, () => false)
    await update($, subCount, () => null)
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
        await openView($, 'settings')
        return { text: 'arne settings are open in the band above the prompt. Changes there match /config.' }
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
        if (b !== 'haiku' && b !== 'heuristic' && b !== 'laya' && b !== 'jev') return { text: 'Backends: haiku, heuristic, laya, jev.' }
        await setOption($, 'backend', b)
        if (live.backend !== b) return { text: `arne backend stays ${live.backend}: the setting was refused.` }
        if (b === 'laya') {
          return {
            text: 'arne backend: laya. It needs laya-serve on PATH (Python 3.10+, the laya package, torch; git clone https://github.com/NandhaKishorM/laya and pip install -e .). Until it answers, turns fall back to haiku.',
          }
        }
        if (b === 'jev') {
          return {
            text: 'arne backend: jev. Jev is TypeSafe’s hosted judge: your prompts and the task card leave this machine. Set the key in /config (arne → TypeSafe API key) or TYPESAFE_API_KEY; keys are at console.typesafe.ai/keys. Until then, turns fall back to haiku.',
          }
        }
        return { text: `arne backend: ${b}.` }
      }
      case 'stats': {
        const lines = await Promise.all(
          PERIODS.map(async ([p, label]) => {
            const st = await statsFor($, p)
            const opus = savedText(st.spent, st.opus)
            return `${label}: $${st.spent.toFixed(2)} spent over ${st.turns} turns. Against Opus · medium: ${opus.headline.toLowerCase()} (${opus.sub}).`
          }),
        )
        await openView($, 'stats')
        return { text: `arne stats (an estimate: each turn's real tokens, priced again on Opus):\n${lines.join('\n')}` }
      }
      case 'subagents': {
        // `on` was the old switch: it reads as the default ceiling.
        const v = rest[0] === 'on' ? 'auto' : rest[0]
        if (v !== 'off' && v !== 'auto' && !TIER_OF[v ?? '']) return { text: 'Usage: /arne subagents auto|haiku|sonnet|opus|off' }
        await setOption($, 'subagents', v)
        return {
          text: live.subagents === 'off' ? 'arne leaves subagents on the model they ask for.' : live.subagents === 'auto' ? "arne picks each subagent's model, no ceiling." : `arne routes subagents, ${shortModel(MODEL[TIER_OF[live.subagents] ?? 'M'])} at most.`,
        }
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

  // A subagent's model is picked here, before it starts (17x), never above the Subagents ceiling (17y). Left
  // alone: Subagents off, arne off, a fork (it shares the parent's cache), a teammate, a workflow agent and a
  // resumed run. A pin is the main chat's, so it does not skip this.
  on('agent.spawn', async ($, e, next) => {
    const s = await settings($)
    if (live.subagents === 'off' || !s.enabled || e.fork || e.isTeammate || e.workflow || e.resume) return next(e)
    const now: number = await $.clock.now()
    const ceiling: Tier = TIER_OF[live.subagents] ?? 'L'
    const asked = e.model ? tierOf(e.model) : undefined
    // A model the call named runs as asked unless it is dearer than the ceiling: then the ceiling, at medium.
    if (asked && PRICE[asked] > PRICE[ceiling]) {
      const d: Decision = { tier: ceiling, effort: 'medium', reason: 'capped', source: 'capped' }
      pendingPicks.push(d)
      let r
      try {
        r = await next({ ...e, model: MODEL[ceiling] })
      } finally {
        const i = pendingPicks.indexOf(d)
        if (i >= 0) pendingPicks.splice(i, 1)
      }
      if (r.agentId && !agents.has(r.agentId)) agents.set(r.agentId, d)
      try {
        $.ui.notice(e.tool_use_id, `arne: ${shortModel(MODEL[ceiling])} (capped from ${shortModel(MODEL[asked])})`)
      } catch {
        // the call is no longer open
      }
      await countSpawn($, 'capped')
      await appendLog($, { key: `agent:${r.agentId ?? e.tool_use_id}`, model: MODEL[ceiling], effort: d.effort, reason: d.reason, source: d.source, out: 0, cacheRead: 0, text: e.prompt.slice(0, 4000), agent: e.subagentType, from: MODEL[asked], to: MODEL[ceiling], at: now })
      return r
    }
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
    // Never dearer than the chat that sent it or the Subagents ceiling; effort at least medium (helpers at low miscounted).
    const clamped = clampTier(r0.tier, live.modelFloor, live.modelCeiling)
    const tier = [clamped, parent, ceiling].reduce((a, b) => (PRICE[b] < PRICE[a] ? b : a))
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
    await read($, liveRev) // subscribes: Settings reads `live`
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
    const { Box, Button, Text } = $.ui.resolve(e)
    // The width the band gets, re-read on every render: AbovePrompt's bodyColumns, else the viewport's columns.
    const cols = Number((e as any).props?.bodyColumns ?? e.viewport?.columns ?? 80)
    const narrow = cols < 72
    // The desktop draws a Button as its own native button and flattens Text children into one plain label,
    // so there the resting line is styled Text in a row and only the chevron is the button.
    const gui = e.surface !== 'terminal'
    await syncCard($)
    const heldText = await read($, held)
    const pin = (await settings($)).pin
    const open = await read($, whyOpen) // the whyOpen atom holds "panel open"
    const picker = await read($, appPicker)
    // Before the first turn (a new chat, a reload) no turn has said the model yet: ask the session (2).
    const running: string | null = (await read($, sessionModel)) ?? (await Promise.resolve($.session.model()).catch(() => null)) ?? null
    // A cold chat under coldTokens is cheap to re-warm: no offer. A dismissal lasts until the cache warms again.
    const offer = await coldOffer($, now)
    const pinned = Boolean(pin?.tier || pin?.effort)
    const thankedKey = await read($, thanked)
    const judgeDown = await read($, layaDown)
    const jevKeyless = await read($, jevNoKey)
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
    const usd = (u: number) => (dollars(u) < 0.01 ? 'under $0.01' : `$${dollars(u).toFixed(2)}`)
    const chatK = c ? `${Math.round(c.C / 1000)}k` : ''
    // The price an alert's button spends, from the cold offer's rows.
    const price = (a: 'compact' | 'continue') => {
      const row = offer?.rows.find(x => x.action === a)
      return row ? `$${dollars(row.first).toFixed(2)}` : ''
    }
    const priced = (label: string, p: string) => (p ? `${label} · ${p}` : label)
    const effortOn = await read($, effortless)
    const isDisabling = await read($, disabling)
    // While a compact arne started runs, an alert's actions give way to this.
    const busy = (await read($, compacting)) ? <Text key="busy" dimColor>summarizing…</Text> : undefined
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
    const view = (await read($, panelView)) as View
    const toggle = async () => {
      // Closing the panel returns it to its main rows and clears the handoff note.
      if (open) await update($, panelView, () => 'main')
      await update($, whyOpen, o => !o)
      await update($, handedOff, () => null)
    }
    // The model the chat really runs, when known; MODEL.M only stands in for the words.
    const realModel = appModel ?? l?.model ?? running ?? undefined
    const runModel = realModel ?? MODEL.M
    const modelWord = shortModel(runModel)
    const effortWord = tierOf(runModel) === 'S' ? '' : ((mode === 'on' && l ? l.effort : await read($, appEffort)) ?? '')
    const effortName = effortWord ? ((narrow ? EFFORT_LABEL_SHORT : EFFORT_LABEL)[effortWord] ?? effortWord) : ''
    const lineText = realModel ? `${modelWord}${effortName ? ` · ${effortName}` : ''}` : 'Auto'
    // A decision the chat's cache holds back: the band says which model it wanted and that the switch waits.
    const waiting = l?.waitFor && tierOf(l.waitFor) !== tierOf(l.model) ? l.waitFor : undefined
    const reason =
      band.state === 'routing'
        ? 'routing…'
        : pinned
          ? 'pinned'
          : waiting
            ? `${shortModel(waiting)} fits; waiting for the cache`
            : l
              ? plainReason(l.reason)
              : ''
    // The cache in minutes only; the dot carries warm, cooling or cold.
    const cacheText = c ? (left > 0 ? `cache ${Math.ceil(left / 60_000)}m` : 'cache cold') : ''
    const cool = left > 0 && left < 5 * 60_000
    const dotColor = left <= 0 ? undefined : cool ? 'warning' : 'success'
    // The resting line at this width: the head never shrinks, the reason fills the rest.
    // The card's border and padding take 4 columns, the chevron 2, the cache dot 2, the arne mark 2.
    const rest = fitRest(cols - (c ? 10 : 8), `arne  ${lineText}`, reason, [cacheText])
    // What the last turn cost: its output and cache reads at the tier's price. ponytail: leaves out uncached input.
    const lastTier = l ? tierOf(l.model) : undefined
    const lastCost = l && lastTier ? dollars(PRICE[lastTier] * (l.out * OUT + l.cacheRead * READ)) : 0
    // A segmented group: the selected segment is the raised grey (secondary), the others are plain text.
    const segment = (key: string, options: { value: string; label: string }[], active: string, pick: (v: string) => void) =>
      options.map(o =>
        o.value === active ? (
          <Button key={`${key}-${o.value}`} variant="secondary" label={picked(o.label, true)} onPress={() => pick(o.value)} />
        ) : (
          <Button key={`${key}-${o.value}`} plain label={o.label} onPress={() => pick(o.value)} />
        ),
      )
    // An alert: a semibold headline over one dim sentence, the actions on the right in macOS order
    // (dismiss first, the primary last). The actions drop under the text when there is no room beside it.
    const banner = (key: string, headline: string, sentence: string, actions: unknown) => (
      <Box key={key} flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2} rowGap={1} borderStyle="round" borderColor="warning" paddingX={1}>
        <Box flexDirection="column" flexShrink={1}>
          <Text weight="semibold">{headline}</Text>
          <Text size="footnote" dimColor>{sentence}</Text>
        </Box>
        <Box key={`${key}-actions`} flexDirection="row" flexWrap="wrap" justifyContent="flex-end" flexGrow={1} columnGap={1} rowGap={1}>
          {actions as any}
        </Box>
      </Box>
    )
    const name = (t: Tier) => shortModel(MODEL[t])
    // 17w: a cheaper tier fits but switching on the warm cache does not pay, so the panel prices the three
    // ways on from coldAdvice: stay, switch in this chat, or hand off to a fresh chat on that tier.
    const want = waiting ? tierOf(waiting) : undefined
    const doneTo = await read($, handedOff)
    let costs: { key: string; label: string; now: string; each: string; note: string; best?: boolean; tier?: Tier }[] = []
    if (c && want && !pinned && !doneTo && left > 0 && PRICE[want] < PRICE[c.model] && planSwitch({ decided: want, chat: c.model, C: c.C, warmUntil: c.warmUntil, now }).why === 'sticky') {
      const rows = coldAdvice(c.C, c.model, c.warmUntil, now).rows
      const stay = rows.find(r => r.action === 'continue')!
      const sw = rows.find(r => r.action === 'switch' && r.to === want)!
      const ho = rows.find(r => r.action === 'handoff' && r.to === want)!
      const best = [stay, sw, ho].reduce((a, b) => (overTurns(b) < overTurns(a) ? b : a))
      const payoff = (r: CostRow) => {
        if (r === stay) return ''
        const n = paysOffAfter(r, stay)
        return n === undefined ? "doesn't pay off soon" : n === 0 ? 'cheaper from the start' : `pays off in ${n} turn${n === 1 ? '' : 's'}`
      }
      const row = (key: string, label: string, r: CostRow, tier?: Tier) => ({
        key,
        label,
        now: usd(r.first),
        each: usd(r.after),
        note: payoff(r),
        best: r === best,
        // Only the recommended handoff gets its button.
        tier: r === best ? tier : undefined,
      })
      costs = [row('stay', `Stay on ${name(c.model)}`, stay), row('switch', `Switch to ${name(want)}`, sw), row('handoff', `New chat on ${name(want)}`, ho, want)]
    }
    // The handoff math for a big chat: what a new chat on each cheaper tier costs now, saves a turn, and when it breaks even.
    const handoffMath: { key: string; text: string }[] = []
    if (c && !costs.length && !pinned && !doneTo && c.C >= live.coldTokens) {
      const rows = coldAdvice(c.C, c.model, c.warmUntil, now).rows
      const stay = rows.find(r => r.action === 'continue')!
      for (const t of ['S', 'M'] as Tier[]) {
        const ho = rows.find(r => r.action === 'handoff' && r.to === t)
        if (!ho || PRICE[t] >= PRICE[c.model]) continue
        const n = paysOffAfter(ho, stay)
        const tail = n === undefined ? "doesn't break even in 20 turns" : n === 0 ? 'cheaper from the start' : `breaks even in ${n} turn${n === 1 ? '' : 's'}`
        handoffMath.push({ key: t, text: `New chat on ${name(t)} via a ${cap(live.compactModel)} summary: ${usd(ho.first)} now (staying ${usd(stay.first)}) · saves ${usd(stay.after - ho.after)} a turn · ${tail}` })
      }
    }
    // While the table offers its Hand off, that is the one Handoff in the panel.
    const tableHandoff = costs.some(r => r.tier)
    const menuOpen = await read($, handoffMenu)
    const subs: SubCount = (await read($, subCount)) ?? {}
    const subParts = [...(['S', 'M', 'L'] as Tier[]).filter(t => subs[t]).map(t => `${subs[t]} ${name(t)}`), subs.kept && `${subs.kept} kept`, subs.asked && `${subs.asked} as asked`, subs.capped && `${subs.capped} capped`].filter(Boolean)
    const subN = (['S', 'M', 'L', 'kept', 'asked', 'capped'] as const).reduce((n, k) => n + (subs[k] ?? 0), 0)
    const why = judgeDown
      ? 'Laya is not answering, so Haiku judged.'
      : jevKeyless
        ? 'Jev needs a key; Haiku judged'
        : !l
        ? 'No decision yet.'
        : pinned
          ? 'Pinned: arne keeps your pick until you choose Auto.'
          : waiting
            ? `${shortModel(waiting)} fits this task, but the cache is warm.`
            : `${modelWord}${effortWord ? ` at ${effortWord} effort` : ''}: ${plainReason(l.reason)}.`
    const whyNote = costs.length
      ? `Switching in this chat re-reads all ${chatK} tokens. A new chat starts from a ${cap(live.compactModel)} summary. To switch here, pick a Model below.`
      : waiting && c
        ? `Switching in this chat re-reads all ${chatK} tokens, so arne stays on ${modelWord} until the cache cools.`
        : [lastCost > 0 && `Last turn $${lastCost.toFixed(2)}`, subParts.length && `${subN} subagent${subN === 1 ? '' : 's'} routed: ${subParts.join(', ')}`].filter(Boolean).join(' · ')
    const alertTier = await handoffTier($)
    // A handoff to the chat's own tier only starts a new chat: say that (5).
    const alertLabel = c && alertTier === c.model ? `New chat on ${name(alertTier)}` : `Handoff to ${name(alertTier)}`
    const handoffAlertButton = <Button key="handoff" plain label={alertLabel} onPress={(p: any) => handoff($, alertTier, p?.surface)} />
    // A row's note: when it pays off, dim; the recommended row says so in the accent, semibold, so it is not missed.
    const costNote = (r: { note: string; best?: boolean }) =>
      r.note === '' && !r.best ? undefined : (
        <Text size="footnote" dimColor>
          {r.note}
          {r.note !== '' && r.best ? ' · ' : ''}
          {r.best && <Text size="footnote" weight="semibold" color="claude">Recommended</Text>}
        </Text>
      )
    // The costs table's columns: a fixed width each, so the numbers line up.
    const W = { label: narrow ? 18 : 20, now: 7, each: 12, end: 12 }
    return (
      <Box flexDirection="column" rowGap={gui ? 1 : 0}>
        {effortOn &&
          banner(
            'alert-effortless',
            'effortless is on',
            'It sets effort too, so arne routes the model only. Disable it, then restart.',
            isDisabling ? (
              <Text key="disabling" dimColor>disabling…</Text>
            ) : (
              <Button key="disable-effortless" variant="primary" label="Disable effortless" onPress={() => disableEffortless($)} />
            ),
          )}
        {heldText &&
          banner(
            'alert-held',
            'Your message is waiting',
            `The cache went cold, so sending now re-reads ${c ? `all ${chatK} tokens` : 'the whole chat'}.`,
            busy ?? [
              <Button key="send-anyway" plain label={priced('Send now', price('continue'))} onPress={() => sendAnyway($)} />,
              <Button key="compact-send" variant="primary" label={priced('Summarize, then send', price('compact'))} onPress={() => compactAndSend($)} />,
            ],
          )}
        {offer &&
          !heldText &&
          banner(
            'alert-cold',
            'The cache went cold',
            `Your next message re-reads all ${chatK} tokens, about ${price('continue')}.`,
            busy ?? [
              <Button key="continue" plain role="dismiss" label="Dismiss" onPress={async () => {
                  // One Dismiss covers the whole cold spell: the heavy alert would otherwise take its place.
                  const until = offer.c.warmUntil[offer.c.model] ?? 0
                  await update($, heavyDismissed, () => until)
                  await update($, coldDismissed, () => until)
                }} />,
              handoffAlertButton,
              <Button key="compact" variant="primary" label={priced('Summarize first', price('compact'))} onPress={() => compactNow($, '')} />,
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
            `This chat is ${chatK} tokens`,
            `Its cache went cold, so the next message re-reads all of it, about $${dollars(costContinue(c.C, c.model, false)).toFixed(2)}.`,
            busy ?? [
              // role="dismiss" only tells the surface how to draw it; the press itself hides the alert for this cold spell.
              <Button key="dismiss" plain role="dismiss" label="Dismiss" onPress={() => update($, heavyDismissed, () => c.warmUntil[c.model] ?? 0)} />,
              handoffAlertButton,
              <Button key="compact-send" variant="primary" label={`Summarize, then continue · $${dollars(costCompact(c.C, 4000, TIER_OF[live.compactModel] ?? 'S')).toFixed(2)}`} onPress={() => compactThenContinue($)} />,
            ],
          )}
        <Box flexDirection="column" borderStyle="round" borderColor={CARD.border} paddingX={1}>
          {mode === 'paused' ? (
            <Box flexDirection="row" gap={1}>
              <Text color="claude">◆</Text>
              <Text weight="semibold">arne</Text>
              <Text dimColor>paused · you picked {appModel ? shortModel(appModel) : 'a model'}</Text>
              <Button key="auto" plain label="Resume" onPress={() => toggleAuto($)} />
            </Box>
          ) : mode === 'off' ? (
            <Box flexDirection="row" gap={1}>
              <Text color="claude">◆</Text>
              <Text weight="semibold">arne</Text>
              <Text dimColor>off</Text>
              <Button key="auto" plain label="Turn arne on" onPress={() => toggleAuto($)} />
            </Box>
          ) : (
            <Box flexDirection="column">
              {gui ? (
                <Box key="band-line" flexDirection="row" alignItems="center" gap={1}>
                  <Text color="claude">◆</Text>
                  <Text weight="semibold">arne</Text>
                  <Text>{lineText}</Text>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    {reason !== '' && <Text dimColor wrap="truncate-end">{reason}</Text>}
                  </Box>
                  {c && <Text color={dotColor} dimColor={!dotColor}>●</Text>}
                  {c && <Text dimColor tabular>{cacheText}</Text>}
                  <Button key="band" plain label={open ? '▴' : '▾'} onPress={toggle} />
                </Box>
              ) : (
                <Box key="band-line" flexDirection="row" justifyContent="space-between" gap={1}>
                  <Button key="band" plain onPress={toggle}>
                    <Text color="claude">◆ </Text>
                    <Text weight="semibold">arne</Text>
                    <Text>{`  ${lineText}`}</Text>
                    {rest.reason !== '' && <Text dimColor>{`  ${rest.reason}`}</Text>}
                  </Button>
                  {/* The cache and the chevron sit at the right end, as in the design. */}
                  <Button key="band-cache" plain onPress={toggle}>
                    {c && <Text color={dotColor} dimColor={!dotColor}>● </Text>}
                    {c && <Text dimColor tabular>{cacheText}</Text>}
                    <Text dimColor>{open ? ' ▴' : ' ▾'}</Text>
                  </Button>
                </Box>
              )}
              {open && view === 'settings' && (
                <Box flexDirection="column" marginTop={1}>
                  {settingsView($, { Box, Button, Text }, gui, cols, live.backend === 'jev' && !(await typesafeKey($)))}
                </Box>
              )}
              {open && view === 'stats' && (
                <Box flexDirection="column" marginTop={1}>
                  {await statsView($, { Box, Button, Text }, cols, gui)}
                </Box>
              )}
              {open && view === 'main' && (
                <Box flexDirection="column" gap={1} marginTop={1}>
                  {/* Why: the sentence with the two ratings on its right, one footnote under it. */}
                  <Box flexDirection="column">
                    <Box flexDirection="row" flexWrap="wrap" alignItems="center" justifyContent="space-between" columnGap={2} rowGap={1}>
                      <Text>{why}</Text>
                      {l && !pinned && thankedKey !== l.key && (
                        <Box flexDirection="row" flexShrink={0} alignItems="center" gap={1}>
                          <Text size="footnote" dimColor>Right pick?</Text>
                          <Button key="up" plain label="Good call" onPress={() => feedback($, 'up')} />
                          <Button key="down" plain label="Wrong call" onPress={() => feedback($, 'down')} />
                        </Box>
                      )}
                      {l && !pinned && thankedKey === l.key && <Text size="footnote" dimColor>Saved for Laya's training.</Text>}
                    </Box>
                    {whyNote !== '' && <Text size="footnote" dimColor>{whyNote}</Text>}
                  </Box>
                  {handoffMath.length > 0 && (
                    <Box key="handoff-math" flexDirection="column">
                      {handoffMath.map(m => (
                        <Text key={`hm-${m.key}`} size="footnote" dimColor>{m.text}</Text>
                      ))}
                    </Box>
                  )}
                  {costs.length > 0 && (
                    <Box key="costs" flexDirection="column" rowGap={gui ? 1 : 0}>
                      {[{ key: 'head', label: '', now: 'Now', each: 'Each turn', note: '', tier: undefined as Tier | undefined }, ...costs].map(r => (
                        <Box key={`cost-${r.key}`} flexDirection="column">
                          <Box key={`cost-${r.key}-row`} flexDirection="row" alignItems="center" columnGap={2}>
                            <Box width={W.label} flexShrink={0}>
                              <Text dimColor={r.key === 'head'} weight={r.key === 'head' ? undefined : 'semibold'}>{r.label}</Text>
                            </Box>
                            <Box width={W.now} flexShrink={0}>
                              <Text tabular dimColor={r.key === 'head'} weight={r.key === 'head' ? undefined : 'semibold'}>{r.now}</Text>
                            </Box>
                            <Box width={W.each} flexShrink={0}>
                              <Text tabular dimColor={r.key === 'head'}>{r.each}</Text>
                            </Box>
                            {!narrow && (
                              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                                {costNote(r)}
                              </Box>
                            )}
                            <Box width={W.end} flexShrink={0} justifyContent="flex-end">
                              {r.tier && (busy ?? <Button key="handoff-row" variant="secondary" label="Hand off" onPress={(p: any) => handoff($, r.tier!, p?.surface)} />)}
                            </Box>
                          </Box>
                          {/* Narrow, the note goes under its row. */}
                          {narrow && costNote(r)}
                        </Box>
                      ))}
                    </Box>
                  )}
                  <Box flexDirection="column" rowGap={gui ? 1 : 0}>
                    <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
                      <Box width={8} flexShrink={0}>
                        <Text size="footnote" dimColor>Model</Text>
                      </Box>
                      {segment(
                        'model',
                        [{ value: 'auto', label: 'Auto' }, { value: 'haiku', label: 'Haiku' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }],
                        pin?.tier ? TIER_NAME_OF[pin.tier] : 'auto',
                        v => void setPinPart($, { tier: v === 'auto' ? undefined : TIER_OF[v] }),
                      )}
                    </Box>
                    <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
                      <Box width={8} flexShrink={0}>
                        <Text size="footnote" dimColor>Effort</Text>
                      </Box>
                      {segment(
                        'effort',
                        [
                          { value: 'auto', label: 'Auto' },
                          ...(['low', 'medium', 'high', 'xhigh', 'max'] as const).map(v => ({
                            value: v,
                            label: (narrow ? EFFORT_LABEL_SHORT : EFFORT_LABEL)[v] ?? v,
                          })),
                        ],
                        pin?.effort ?? 'auto',
                        v => void setPinPart($, { effort: v === 'auto' ? undefined : (v as Pin['effort']) }),
                      )}
                    </Box>
                  </Box>
                  {doneTo && <Text size="footnote" dimColor>{`Handed off to ${name(doneTo as Tier)}. Old chat saved in history; archive it from the sidebar when you are done.`}</Text>}
                  {/* Footer: the views and Handoff… on the left, Turn off alone on the right. */}
                  <Box key="footer" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2} rowGap={1} justifyContent="space-between">
                    <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
                      <Button key="gear" plain label="Settings" onPress={() => openView($, 'settings')} />
                      <Button key="open-stats" plain label="Stats" onPress={() => openView($, 'stats')} />
                      {!tableHandoff && (busy ?? <Button key="handoff-menu" plain label="Handoff…" onPress={() => update($, handoffMenu, o => !o)} />)}
                      {menuOpen &&
                        !busy &&
                        !tableHandoff &&
                        (['S', 'M', 'L'] as Tier[]).map(t => (
                          <Button key={`handoff-${TIER_NAME_OF[t]}`} plain label={`to ${name(t)}`} onPress={(p: any) => handoff($, t, p?.surface)} />
                        ))}
                    </Box>
                    <Button key="auto" plain label="Turn arne off" onPress={() => toggleAuto($)} />
                  </Box>
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  // Settings and Stats live in the band's panel now. A pane restored from an older session points there.
  for (const id of [SETTINGS, STATS]) {
    on('ui.render', { component: 'Pane', requestId: id }, async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>arne's settings and stats are in the band above the prompt: open it, then Settings.</Text>
    })
  }

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
