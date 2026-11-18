// Browser Bridge worker: commands/input/key.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { clickPage } from './click.js'
import { withVelocity } from './drive.js'
import { requireInputVisibility } from './shared.js'
import { requirePage } from '../tabs.js'
import { clearForced, evaluate, evaluateInContext, evaluateProgram, frameContext, guardedContext, pageMeta, send } from '../../lib/cdp.js'
import { KEY_TEXT_CAP } from '../../lib/constants.js'
import { CANVAS_SIGNATURE_EXPR, CAR_MEASURE_EXPR, deepFindExpr, keyTextProbeExpr } from '../../lib/page.js'
import { KEY_MAP, chordPlan, delay, fail, inputSuccess, keySpec, keyTextPrefix, recentDialog, resolveTarget } from '../../lib/util.js'
import { shared } from '../../lib/state.js'

/**
 * Decide whether a key text run really landed.
 *
 * A reply may not say "applied" while the visible document text is shorter than
 * it was and nothing landed: that is the shape of a run that ate existing text
 * (the Docs report: 5662 -> 5103 characters, nothing inserted). The counts and a
 * short excerpt are in the error because an Error carries only a code and a
 * message across the bridge.
 */
export function keyTextVerification(before, after, prefix, sent) {
  // Without a readable page there is no claim to make: report the before length
  // and say the check could not finish, rather than implying nothing changed.
  if (!after) {
    return { textLenBefore: before.textLen, textVerified: false, textVerifyNote: 'the page could not be read after the run' }
  }
  const fields = { textLenBefore: before.textLen, textLenAfter: after.textLen, textSource: before.source || 'editor' }
  if (after.url !== before.url) {
    return { ...fields, textVerified: false, textVerifyNote: 'the page navigated during the run, so the text was delivered before it changed' }
  }
  const excerpt = after.excerpt ? JSON.stringify(after.excerpt) : '""'
  const counts = `textLenBefore: ${before.textLen}, textLenAfter: ${after.textLen}, excerpt: ${excerpt}`
  // A shorter document is never a success shape, even when the typed prefix is
  // present: that is the one symptom the Docs report had, and only the caller
  // can decide whether a replaced selection was intended.
  if (after.textLen < before.textLen) {
    throw fail(
      'EDITOR_LOST_TEXT',
      `key text left the document shorter: ${sent} key(s) were sent and the visible document text went ${before.textLen} -> ${after.textLen} characters. `
      + `${counts}. The typed prefix ${JSON.stringify(prefix)} was ${after.landed ? 'found' : 'absent'}. A success reply is not returned while the document `
      + 'is shorter than before: the editor may have replaced a selection, eaten existing text, or lost its caret. Re-read the page with bsb_read to see what remains.',
    )
  }
  if (after.badInput) {
    throw fail(
      'TEXT_NOT_APPLIED',
      `key text left the control in an invalid state: ${sent} key(s) were sent and the field reports validity.badInput with value ${JSON.stringify(after.value ?? '')}. `
      + `${counts}. A date, time or number input needs its own format (for example 2024-02-29 for a date); the keystrokes did not produce a valid value.`,
    )
  }
  if (after.landed) return { ...fields, textVerified: true }
  throw fail(
    'TEXT_NOT_APPLIED',
    `key text did not land: ${sent} key(s) were sent but the typed prefix ${JSON.stringify(prefix)} is absent from the editor text `
    + `(${before.textLen} -> ${after.textLen} characters). ${counts}. Nothing is reported as applied: the page may have cancelled the key events, `
    + 'moved the caret, or focused another control. Re-read the page, click the editor to place the caret, then retry.',
  )
}

export async function keyPage({ key, keys, text, keyDelayMs, steps, count, holdMs, target, modifiers, frame, forceActive: forceWanted, measure, settle, tabId: hint }) {
  const tabId = await requirePage(hint)
  const startedAt = Date.now()
  // Native dialogs are auto-dismissed as cancelled the moment they open, so a
  // later Enter/Escape cannot reach them. Claiming applied:true for that key is
  // the defect this check exists to prevent (BSB-20261117-2310).
  const dialogKey = (() => {
    const names = []
    if (typeof key === 'string') names.push(key)
    if (Array.isArray(keys)) names.push(...keys)
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (typeof step?.key === 'string') names.push(step.key)
        if (Array.isArray(step?.keys)) names.push(...step.keys)
      }
    }
    return names.some((name) => /^(Enter|Escape|Esc)$/i.test(String(name)))
  })()
  if (dialogKey) {
    const dialog = shared.dialogs.get(tabId)
    if (dialog && Date.now() - dialog.at < 15000) {
      throw fail(
        'DIALOG_AUTO_DISMISSED',
        'a modal ' + String(dialog.type || 'dialog') + ' dialog (' + JSON.stringify(String(dialog.message ?? '')) + ') was auto-dismissed as cancelled when it opened, so ' + (key || 'Enter') + ' could not reach it and nothing was sent. Native dialogs are dismissed to keep the tab responsive; use a page-controlled dialog, or read the reply of the action that opened it.',
      )
    }
  }
  // A framed key run lands in the frame's document, so the probe must read that
  // document; the top page's activeElement is body and looks unmeasurable.
  // The local must not be named `frameContext`: a `let` of that name shadows the
  // helper function, so the call throws and the catch silently falls back to the
  // top document, where a framed key run looks unmeasurable.
  let frameContextId
  let frameId
  if (frame !== undefined && frame !== null && String(frame).trim() !== '') {
    try {
      const hit = await frameContext(tabId, frame)
      frameContextId = hit.contextId
      frameId = hit.frame?.frameId
    } catch {}
  }
  const probeIn = async (expression) => (frameContextId === undefined
    ? evaluate(tabId, expression)
    : evaluateInContext(tabId, frameContextId, expression))
  // forceActive:true is the escape hatch for a page whose frame clock has
  // stopped (a sleeping display leaves the tab "hidden" and rAF paused, so
  // input would be held). It is never installed on attach and it never happens
  // silently: the reply carries what was forced and the visibility observed.
  const { visibility, forced } = await requireInputVisibility(tabId, 'key', forceWanted)
  // Text mode: one real key event per character. Canvas games read keydown and
  // cannot be typed into by assigning value, so expanding a string into steps
  // by hand costs one JSON object per character.
  if (typeof text === 'string' && text.length > 0
      && !key && !(Array.isArray(keys) && keys.length) && !(Array.isArray(steps) && steps.length)) {
    if (target) {
      const selector = resolveTarget(target, tabId)
      const focused = await probeIn(`(() => { const el = ${deepFindExpr(selector)}; if (!el) return false; el.focus(); return true })()`)
      if (!focused) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
    }
    // A long run used to be cut at 1000 keys with no marker, so a 1200-character
    // write lost its tail behind an `applied:true` reply. The cap is higher now
    // and the cut is always reported: requestedKeys, sentKeys, droppedKeys and
    // truncated travel with every text reply.
    const requested = Array.from(text)
    const chars = requested.slice(0, KEY_TEXT_CAP)
    const truncated = chars.length < requested.length
    const prefix = keyTextPrefix(text)
    // Verification only means something when the focused element is an editor
    // that owns visible text. On a canvas game (or any page whose active element
    // is body) there is no document text to compare, so the probe stays off.
    const probe = prefix ? await probeIn(keyTextProbeExpr(prefix)).catch(() => null) : null
    // A long run of per-character CDP key events is slow enough to hit the tool
    // timeout and, on at least one live fixture, crash the renderer. When the
    // focused element owns editable text and the run is long, insert the block
    // in one real input event instead. Canvas/key-driven pages keep the keydown
    // path; the reply says which path ran.
    const editableActive = await evaluate(tabId, `(() => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = String(el.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable === true || el.getAttribute('role') === 'textbox';
    })()`).catch(() => false)
    let bulk = false
    if (chars.length > 200 && editableActive) {
      try {
        await send(tabId, 'Input.insertText', { text: chars.join('') })
        bulk = true
      } catch {}
    }
    const gap = Math.min(Math.max(Number(keyDelayMs) || 40, 8), 500)
    let tabs = 0
    let enters = 0
    if (!bulk) for (const ch of chars) {
      // A tab or newline in the text is a navigation key, not a printable
      // character: spreadsheet-style editing needs real Tab/Enter keydowns and a
      // keyUp for each. Anything else in the C0/DEL range has no honest mapping,
      // so it is refused instead of typed as a control character that no page
      // treats as a key.
      let control = null
      if (ch === '\t') {
        control = KEY_MAP.Tab
        tabs += 1
      } else if (ch === '\n' || ch === '\r') {
        control = KEY_MAP.Enter
        enters += 1
      } else if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(ch)) {
        const point = 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
        throw fail('BAD_ARGUMENT', `key text cannot map control character ${point}: use "\\t" for Tab, "\\n" or "\\r" for Enter, or pass the key by name`)
      }
      const spec = control ?? keySpec(ch)
      const base = {
        key: spec?.key ?? ch,
        ...(spec?.code ? { code: spec.code } : {}),
        ...(Number.isFinite(spec?.vk) ? { windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk } : {}),
      }
      const printable = spec?.text ?? (control ? undefined : ch)
      const textPayload = printable !== undefined ? { text: printable, unmodifiedText: printable } : {}
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...textPayload })
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await delay(gap)
    }
    const meta = await pageMeta(tabId)
    // A canvas editor paints its text mirror on the next render tick, so reading
    // it in the same task would compare against the pre-run state.
    if (probe?.source === 'document-mirror') await delay(250)
    const after = probe?.applies === true
      ? await probeIn(keyTextProbeExpr(prefix)).catch(() => null)
      : null
    if (forced) await clearForced(tabId, forced)
    const verification = probe?.applies === true
      ? keyTextVerification(probe, after, prefix, chars.length)
      // No measurable text is not a silent omission: say the run could not be
      // checked, so a caller never mistakes an absent field for a pass.
      : {
          textVerified: false,
          textVerifyNote: probe
            ? 'the focused element is not a text editor and the page exposes no document text mirror, so the run could not be measured; confirm the result with bsb_read or bsb_capture'
            : 'the page could not be read, so the run could not be measured',
        }
    return {
      url: meta?.url ?? '', title: meta?.title ?? '', key: 'text', times: chars.length, sentKeys: chars.length,
      requestedKeys: requested.length, truncated, droppedKeys: requested.length - chars.length,
      tabs, enters, mode: bulk ? 'insertText' : 'keys', keySemantics: bulk ? 'insertText' : 'keydown-keyup',
      modifiers: [], ...(frameId ? { frameId } : {}), ...(verification ?? {}), ...inputSuccess(visibility, forced),
    }
  }
  const specFor = (raw) => {
    const name = String(raw ?? '').trim()
    const spec = keySpec(name)
    if (!spec) throw fail('BAD_ARGUMENT', `unsupported key: ${name || '(empty)'}; use a single character, a friendly name (${Object.keys(KEY_MAP).join(', ')}) or a physical event.code (KeyW, Digit4, ShiftLeft, F5, Numpad8)`)
    return spec
  }
  const stepList = Array.isArray(steps) ? steps.filter((step) => step && typeof step === 'object') : []
  const names = (Array.isArray(keys) && keys.length ? keys : [key])
    .map((raw) => String(raw ?? '').trim())
    .filter((name) => name !== '')
  const specs = names.map(specFor)
  const spec = specs[0]
  if (target) {
    const selector = resolveTarget(target, tabId)
    const focused = await evaluate(tabId, `(() => { const el = ${deepFindExpr(selector)}; if (!el) return false; el.focus(); return true })()`)
    if (!focused) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
  }
  const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
  const mask = (Array.isArray(modifiers) ? modifiers : [])
    .map((name) => MODIFIER_BITS[String(name).toLowerCase()])
    .filter((bit) => typeof bit === 'number')
    .reduce((all, bit) => all | bit, 0)
  const times = Math.min(Math.max(Math.trunc(Number(count) || 1), 1), 1000)
  // A held key is a different gesture from a tap: games read key-down state on
  // animation frames, so a down/up pair inside one tick never moves them. With
  // hold, the key stays down for holdMs (one press, no repeats).
  const hold = Math.min(Math.max(Number(holdMs) || 0, 0), 10000)
  const withText = specs.length === 1
  // Every key list becomes a plan: which spec, and the modifier mask its own
  // event carries. A modifier named in `keys` now sets its bit on the main key,
  // so Ctrl+Alt+1 is delivered as a chord instead of three bare keys.
  const { plan, mask: chordMask } = chordPlan(specs, mask)
  const eventFor = (item, type, eventMask = mask) => ({
    type,
    key: item.key,
    code: item.code,
    windowsVirtualKeyCode: item.vk,
    nativeVirtualKeyCode: item.vk,
    modifiers: eventMask,
    ...(withText && item.text && eventMask === 0 ? { text: item.text } : {}),
  })
  // Releasing a key is the one event a game can never recover from losing: a
  // stuck keyDown drives the avatar until it crashes. Every path that raises a
  // key therefore releases it in a finally block, retrying the release because a
  // renderer that just hung ("not responding") still receives it on recovery.
  const releaseKey = async (item, eventMask, tries = 4) => {
    for (let i = 0; i < tries; i += 1) {
      try {
        await send(tabId, 'Input.dispatchKeyEvent', eventFor(item, 'keyUp', eventMask))
        return true
      } catch {
        await delay(150)
      }
    }
    return false
  }
  const press = async (steps, holdFor) => {
    try {
      for (const step of steps) await send(tabId, 'Input.dispatchKeyEvent', eventFor(step.spec, 'keyDown', step.mask))
      if (holdFor > 0) await delay(holdFor)
    } finally {
      // Release in reverse: the key comes up before the modifiers that held it,
      // like a real chord, and each release keeps the mask its press carried.
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
      // A throttled page can drop the keyUp even when the send resolves; the
      // repeat is idempotent for normal pages and repairs the lost event.
      await delay(24)
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
    }
  }
  // until: hold the keys until a READ-ONLY page expression turns truthy. This is
  // the closed-loop counterpart of holdMs: a steering burst that ends on "the
  // car passed x=200" is exact where a 1200 ms hold is a guess. The expression
  // runs in the same guarded world as every other read, so it can inspect but
  // never modify the page.
  const pressUntil = async (steps, expression, deadline, contextId) => {
    try {
      for (const step of steps) await send(tabId, 'Input.dispatchKeyEvent', eventFor(step.spec, 'keyDown', step.mask))
      while (Date.now() < deadline) {
        await delay(55)
        try {
          if (await evaluateProgram(tabId, expression, { contextId })) return true
        } catch {}
      }
      return false
    } finally {
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
      await delay(24)
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
    }
  }
  const pressUntilMeasure = async (steps, expression, deadline, contextId) => {
    // The condition is evaluated in the page against the measurement, not in the
    // service worker: an MV3 extension may not use eval/new Function (CSP), while
    // a CDP Runtime.evaluate is allowed to run the caller's expression.
    try {
      for (const step of steps) await send(tabId, 'Input.dispatchKeyEvent', eventFor(step.spec, 'keyDown', step.mask))
      while (Date.now() < deadline) {
        await delay(90)
        try {
          const m = withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
          if (!m) continue
          const source = '(() => { const m = ' + JSON.stringify(m) + '; try { return Boolean(' + expression + ') } catch { return false } })()'
          if (await evaluateProgram(tabId, source, { contextId })) return true
        } catch {}
      }
      return false
    } finally {
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
      await delay(24)
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
    }
  }
  // Clear keys a previous call may have left down (its own hold timed out).
  // Releasing a key that was never pressed is a no-op for the page.
  for (const name of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'w', 'a', 's', 'd']) {
    try { await send(tabId, 'Input.dispatchKeyEvent', eventFor(specFor(name), 'keyUp')) } catch {}
  }
  // A recorded gesture: several press/hold/wait phases executed back-to-back in
  // ONE call. Games that steer only while accelerating need the phases to be
  // continuous — a model round trip between phases lets the car coast to a stop.
  const untilResults = []
  if (stepList.length) {
    for (const step of stepList) {
      // A step may be a pure pause ({ waitMs }) — it presses nothing.
      const raw = Array.isArray(step.keys) && step.keys.length
        ? step.keys.map((name) => String(name ?? "").trim()).filter((name) => name !== "")
        : (step.key == null || String(step.key).trim() === "" ? [] : [String(step.key).trim()])
      const list = raw.map(specFor)
      const { plan: stepPlan } = chordPlan(list, mask)
      const stepHold = Math.min(Math.max(Number(step.holdMs) || 0, 0), 10000)
      const stepUntil = typeof step.until === "string" && step.until.trim() ? step.until.trim() : ""
      const stepUntilMeasure = typeof step.untilMeasure === "string" && step.untilMeasure.trim() ? step.untilMeasure.trim() : ""
      if (stepUntilMeasure) {
        const cap = Math.min(Math.max(Number(step.timeoutMs) || 6000, 100), 60000)
        const startedAt = Date.now()
        const contextId = await guardedContext(tabId)
        const ok = await pressUntilMeasure(stepPlan, stepUntilMeasure, startedAt + cap, contextId)
        untilResults.push({ index: untilResults.length, ok, ms: Date.now() - startedAt, on: "measure" })
      } else if (stepUntil) {
        const cap = Math.min(Math.max(Number(step.timeoutMs) || 6000, 100), 60000)
        const startedAt = Date.now()
        const contextId = await guardedContext(tabId)
        const ok = await pressUntil(stepPlan, stepUntil, startedAt + cap, contextId)
        untilResults.push({ index: untilResults.length, ok, ms: Date.now() - startedAt })
      } else {
        await press(stepPlan, stepHold)
      }
      const wait = Math.min(Math.max(Number(step.waitMs) || 0, 0), 10000)
      if (wait > 0) await delay(wait)
      // A step may end with a press. The gesture's last release is the freshest
      // thing the page has done, and some UIs only accept the confirmation in
      // that instant (a car parks for two seconds before its own reset), so the
      // click has to land here instead of a model round trip later.
      const stepClick = typeof step.click === "string" && step.click.trim() ? step.click.trim() : ""
      if (stepClick) {
        try { await clickPage({ target: stepClick, tabId: hint }) } catch {}
      }
    }
  } else if (hold > 0) {
    if (!specs.length) throw fail("BAD_ARGUMENT", "key needs key or keys")
    // Several keys can be down at once: a game that drives with one key and
    // steers with another only sees the combined gesture.
    await press(plan, hold)
  } else {
    // Large repeats run at a lower interval: a 644-step slider sweep cost four calls
    for (let i = 0; i < times; i += 1) {
      await press(plan, 0)
      await delay(times > 200 ? 10 : 30)
    }
  }
  await delay(200)
  const meta = await pageMeta(tabId)
  const label = specs.map((item) => item.key).join('+')
  // measure:true is the closed-loop primitive for pixel games: one call = one
  // gesture plus a read of what changed on the canvas, so a driver never spends
  // a second round trip on a separate inspection call.
  let measurement = null
  if (measure) {
    // settle:true waits for the canvas to stop changing before reading it. A car
    // keeps coasting for seconds after the key is released, so a measurement
    // taken immediately describes a pose the next decision would already be too
    // late for. Two identical signatures 120 ms apart mean the world is still.
    if (settle) {
      try {
        const sk = await guardedContext(tabId)
        let prev; let still = 0
        for (let i = 0; i < 30 && still < 2; i += 1) {
          const sig = await evaluateProgram(tabId, CANVAS_SIGNATURE_EXPR, { contextId: sk })
          if (sig !== null && sig === prev) still += 1
          else still = 0
          prev = sig
          if (still >= 2) break
          await delay(120)
        }
      } catch {}
    }
    try {
      const contextId = await guardedContext(tabId)
      measurement = withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
    } catch (error) {
      measurement = { error: String(error?.message || error) }
    }
  }
  if (forced) await clearForced(tabId, forced)
  return {
    url: meta?.url ?? '', title: meta?.title ?? '', key: label, times, modifiers: chordMask, steps: stepList.length,
    measure: measurement, until: untilResults.length ? untilResults : undefined, dialog: recentDialog(tabId, startedAt),
    ...inputSuccess(visibility, forced),
  }
}
