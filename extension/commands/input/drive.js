// Browser Bridge worker: commands/input/drive.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { clickPage } from './click.js'
import { requirePage } from '../tabs.js'
import { evaluateProgram, guardedContext, send } from '../../lib/cdp.js'
import { CAR_MEASURE_EXPR } from '../../lib/page.js'
import { shared } from '../../lib/state.js'
import { delay, fail, keySpec } from '../../lib/util.js'

/** Attach the sprite's velocity (game units/s) to a measurement. */
export const withVelocity = (tabId, measurement) => {
  // Continuity: a scene can hold several bright-neutral sprites (the player, the
  // traffic art cars). Sticking to the component closest to the pose seen on the
  // previous tick stops the controller from chasing a passing car.
  if (measurement && measurement.car) {
    const prev = shared.lastCarPose.get(tabId)
    if (prev && Date.now() - prev.t < 3000) {
      const all = [measurement.car, ...(measurement.others || [])]
      // Shape/colour gate: a traffic sprite can sit nearer than the player one
      // tick, so only candidates matching the previous sprite's brightness and
      // pixel area are eligible for the continuity re-pick.
      const near = (p) => {
        if (prev.b != null && p.b != null && Math.abs(p.b - prev.b) > 22) return false
        if (prev.n && p.n && (p.n > prev.n * 1.7 || p.n < prev.n * 0.55)) return false
        return true
      }
      let best = null, bestD = Infinity
      for (const p of all) {
        if (!near(p)) continue
        const d = Math.hypot(p.cx - prev.cx, p.cy - prev.cy)
        if (d < bestD) { bestD = d; best = p }
      }
      if (best && bestD <= 120 && best !== measurement.car) {
        measurement.car = best
        measurement.others = all.filter((p) => p !== best).slice(0, 4)
      }
    }
  }
  const car = measurement && measurement.car
  if (!car) return measurement
  const now = Date.now()
  const prev = shared.lastCarPose.get(tabId)
  if (prev && now > prev.t && now - prev.t < 4000 && (prev.b == null || car.b == null || Math.abs(car.b - prev.b) <= 26)) {
    const dt = (now - prev.t) / 1000
    car.vx = Math.round(((car.cx - prev.cx) / dt) * 10) / 10
    car.vy = Math.round(((car.cy - prev.cy) / dt) * 10) / 10
  }
  shared.lastCarPose.set(tabId, { cx: car.cx, cy: car.cy, t: now, b: car.b, n: car.n })
  return measurement
}

/**
 * Drive a canvas game sprite to a point: a closed-loop steering controller.
 *
 * A held key is a guess: while the model is deciding, the sprite keeps moving
 * (a parking-game car coasts 300 units in one round trip). This action keeps
 * the whole loop inside the extension — every tick it reads the canvas, compares
 * the sprite's velocity heading with the bearing to (x, y) and holds exactly the
 * keys the physics needs (accelerate, steer, brake). It is game-agnostic: any
 * sprite driven with arrow keys can be steered to a coordinate, and `keys` lets
 * the caller rebind the four directions (wasd, etc.).
 */
export async function drivePage({ x, y, tol, timeoutMs, maxSpeed, untilMeasure, click, keys, route, tabId: hint }) {
  const tabId = await requirePage(hint)
  const legs = []
  if (Array.isArray(route) && route.length) {
    for (const step of route) {
      const lx = Number(step && step.x)
      const ly = Number(step && step.y)
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) throw fail('BAD_ARGUMENT', 'route legs need numeric x and y')
      legs.push({ x: lx, y: ly, tol: step.tol, maxSpeed: step.maxSpeed, untilMeasure: step.untilMeasure })
    }
  } else {
    const tx0 = Number(x)
    const ty0 = Number(y)
    if (!Number.isFinite(tx0) || !Number.isFinite(ty0)) throw fail('BAD_ARGUMENT', 'drive needs numeric x and y (or a route)')
    legs.push({ x: tx0, y: ty0, tol, maxSpeed, untilMeasure })
  }
  const fallbackTol = Number(tol)
  const fallbackCap = Number(maxSpeed)
  const bind = (input, fallback) => {
    const name = String(input ?? fallback).trim()
    if (!keySpec(name)) throw fail('BAD_ARGUMENT', 'unsupported key: ' + name)
    return name
  }
  const bindKeys = keys && typeof keys === 'object' ? keys : {}
  const K = {
    up: bind(bindKeys.up, 'ArrowUp'),
    down: bind(bindKeys.down, 'ArrowDown'),
    left: bind(bindKeys.left, 'ArrowLeft'),
    right: bind(bindKeys.right, 'ArrowRight'),
  }
  const contextId = await guardedContext(tabId)
  const held = new Map()
  const keyDown = async (name) => {
    if (held.has(name)) return
    const s = keySpec(name)
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: s.key, code: s.code, windowsVirtualKeyCode: s.vk, nativeVirtualKeyCode: s.vk, modifiers: 0 })
    held.set(name, s)
  }
  const keyUp = async (name) => {
    if (!held.has(name)) return
    const s = held.get(name)
    held.delete(name)
    try { await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: s.key, code: s.code, windowsVirtualKeyCode: s.vk, nativeVirtualKeyCode: s.vk, modifiers: 0 }) } catch {}
  }
  // A stuck keyUp is unrecoverable (the sprite drives until it crashes), so every
  // exit path releases twice with a delay between, like the gesture presser.
  const releaseAll = async () => {
    for (const name of [...held.keys()]) await keyUp(name)
    await delay(24)
    for (const name of [...held.keys()]) await keyUp(name)
  }
  const wrap = (a) => {
    while (a > Math.PI) a -= Math.PI * 2
    while (a < -Math.PI) a += Math.PI * 2
    return a
  }
  // Friction alone leaves a long coast and a coasting sprite eventually drifts
  // into a wall (which resets the level) while the model thinks. Braking by
  // reverse thrust also accelerates the sprite backwards once it has stopped, so
  // the direction is verified from the measured speed and flipped when wrong.
  const readSpeed = async () => {
    try {
      const m = withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
      const c = m && m.car
      return c ? Math.hypot(Number(c.vx) || 0, Number(c.vy) || 0) : 0
    } catch {
      return 0
    }
  }
  // Stop a coasting sprite without launching it the other way.
  //
  // Reverse thrust is a real brake only while the sprite is fast. Held
  // continuously it decelerates through zero and then accelerates the sprite
  // backwards — which is how a freshly parked car got reversed straight back
  // out of the bay it had just reached. So: coast on friction first (most
  // sprites stop in a few frames), and pulse the brake only above 25 u/s.
  const bringToRest = async (budgetMs) => {
    const deadline = Date.now() + (budgetMs || 1500)
    await releaseAll()
    let prev = await readSpeed()
    while (Date.now() < deadline && prev >= 4) {
      if (prev > 25) {
        await keyDown(K.down)
        await delay(70)
        await keyUp(K.down)
      } else {
        await delay(110)
      }
      const now = await readSpeed()
      // Speed climbing while braking means the thrust is pushing the sprite the
      // wrong way; stop braking and let friction finish.
      if (now > prev + 3) break
      prev = now
    }
    await releaseAll()
  }
  const startedAt = Date.now()
  const trace = []
  const legsReport = []
  let ticks = 0
  let car = null
  let ok = false
  let reason = 'timeout'
  try {
    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li]
      const tx = leg.x
      const ty = leg.y
      const tolerance = Math.min(Math.max(Number(leg.tol) || fallbackTol || 12, 2), 200)
      const globalCap = Math.min(Math.max(Number(leg.maxSpeed) || fallbackCap || 90, 10), 400)
      const cap = Math.min(Math.max(Number(timeoutMs) || 20000, 500), 120000)
      const legStart = Date.now()
      let heading = null
      let stuckTicks = 0
      let prevPos = null
      let movingCommanded = false
      let brakeKey = K.down
      let lastSpeed = 0
      let braking = false
      let prevBrakeSpeed = 0
      let escapeUntil = 0
      let escapeTurn = null
      let legOk = false
      let legReason = 'timeout'
      while (Date.now() - legStart < cap) {
        ticks += 1
        try {
          const m = withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
          car = m && m.car ? m.car : null
        } catch {
          car = null
        }
        if (!car) { legReason = 'no-sprite'; break }
        const vx = Number(car.vx) || 0
        const vy = Number(car.vy) || 0
        const speed = Math.hypot(vx, vy)
        // Track the heading down to walking pace: a slow final approach used to
        // keep whatever heading was last sampled above 20 u/s, so the controller
        // steered against a stale bearing and drifted sideways into the wall it
        // was trying to park beside. Low-pass it because a centroid velocity at
        // creep speed is noisy.
        if (speed > 4) {
          const sampled = Math.atan2(vy, vx)
          heading = heading == null ? sampled : heading + wrap(sampled - heading) * 0.45
        }
        const dx = tx - car.cx
        const dy = ty - car.cy
        const dist = Math.hypot(dx, dy)
        const err = heading == null ? 0 : wrap(Math.atan2(dy, dx) - heading)
        if (ticks <= 10 || ticks % 10 === 0) {
          trace.push({ t: Date.now() - startedAt, leg: li, cx: car.cx, cy: car.cy, dist: Math.round(dist), speed: Math.round(speed), err: Math.round((err * 180) / Math.PI) })
        }
        if (leg.untilMeasure) {
          try {
            const source = '(() => { const m = ' + JSON.stringify({ car }) + '; try { return Boolean(' + leg.untilMeasure + ') } catch { return false } })()'
            if (await evaluateProgram(tabId, source, { contextId })) { legOk = true; legReason = 'until-measure'; break }
          } catch {}
        }
        if (dist <= tolerance && speed <= 34) { legOk = true; legReason = 'arrived'; break }
        // Brake early: the sprite coasts, and a full-speed arrival overshoots the
        // point by the distance it needs to shed. Near the target the cap drops so
        // the last metres are slow enough to stop inside a parking bay.
        const align = Math.cos(err)
        const aimCap = align < 0.9 ? globalCap * (0.3 + 0.6 * Math.max(0, align)) : globalCap
        const localCap = Math.min(globalCap, 8 + dist * 0.45, aimCap)
        const stopping = (speed * speed) / (2 * 30)
        // Reverse thrust brakes a forward-moving sprite but accelerates one that
        // is already reversing, which turns into a runaway (>120 u/s). Watch the
        // speed across a brake tick and flip the brake key when it climbs.
        if (braking && speed > 25 && speed > prevBrakeSpeed + 3) brakeKey = brakeKey === K.down ? K.up : K.down
        prevBrakeSpeed = speed
        braking = false
        const wanted = new Set()
        // Stuck recovery: a sprite pinned against a wall has speed 0 while the
        // accelerator is held, and no amount of steering helps — reversing out is
        // the only way free. Detect that as "commanded to accelerate but not
        // moving", NOT as "slow": a low maxSpeed legitimately holds the sprite
        // under 12 u/s, and treating slowness as stuck made the controller
        // reverse out of a perfectly good slow approach (the sprite then
        // wandered off and finally crashed into a wall).
        const moved = prevPos === null ? 99 : Math.hypot(car.cx - prevPos.x, car.cy - prevPos.y)
        prevPos = { x: car.cx, y: car.cy }
        if (movingCommanded && moved < 0.6 && dist > tolerance) stuckTicks += 1
        else stuckTicks = 0
        if (stuckTicks >= 6) {
          escapeUntil = Date.now() + 650
          escapeTurn = err >= 0 ? K.right : K.left
          stuckTicks = 0
        }
        if (Date.now() < escapeUntil) {
          wanted.add(K.down)
          wanted.add(escapeTurn)
        } else if (align < 0.55) {
          // Car-like sprites only rotate while they move, so slowing down to turn
          // deadlocks (no speed -> no rotation -> no alignment). Keep the
          // accelerator down and steer — but cap the turn speed, because an
          // unbraked circle at full speed has too wide a radius to ever align.
          const turnCap = Math.min(globalCap, 45)
          if (speed > turnCap) { wanted.add(brakeKey); braking = true }
          else wanted.add(K.up)
          if (err > 0) wanted.add(K.right)
          else wanted.add(K.left)
        } else if (speed > localCap + 6 && dist < 220) { wanted.add(brakeKey); braking = true }
        else if (speed > localCap + 1.5) {
          // Between the cap and the brake threshold: coast on friction and keep
          // steering. Braking here overshoots the other way, so the sprite
          // shudders around the cap instead of holding a steady creep.
          if (err > 0.1) wanted.add(K.right)
          else if (err < -0.1) wanted.add(K.left)
        } else if (speed > 34 && dist < stopping) { wanted.add(brakeKey); braking = true }
        else {
          wanted.add(K.up)
          if (err > 0.1) wanted.add(K.right)
          else if (err < -0.1) wanted.add(K.left)
        }
        for (const name of [...held.keys()]) if (!wanted.has(name)) await keyUp(name)
        for (const name of wanted) await keyDown(name)
        movingCommanded = wanted.has(K.up)
        await delay(35)
      }
      await releaseAll()
      legsReport.push({ leg: li, x: tx, y: ty, ok: legOk, reason: legReason, ms: Date.now() - legStart })
      if (!legOk) { reason = 'leg-' + li + '-' + legReason; break }
      ok = true
      reason = legs.length > 1 ? 'route' : legReason
      // Settle between legs: the controller hands back a coasting sprite, so shed
      // the remaining speed while the next leg is being set up.
      if (li < legs.length - 1) await bringToRest(1200)
    }
  } finally {
    await releaseAll()
  }
  // Friction alone leaves a long coast, and a coasting sprite drifts into walls
  // while the model thinks. Bring the speed down before anything else happens.
  if (ok) await bringToRest(2000)
  let pressed = null
  if (ok && click) {
    try { await clickPage({ target: click, tabId: hint }); pressed = click } catch {}
  }
  const last = legs[legs.length - 1]
  return {
    ok,
    reason,
    ms: Date.now() - startedAt,
    ticks,
    tol: Math.min(Math.max(Number(last.tol) || fallbackTol || 12, 2), 200),
    target: { x: last.x, y: last.y },
    car,
    legs: legsReport,
    trace,
    click: pressed,
  }
}

/**
 * Read the canvas-game measurement without sending any input.
 *
 * `drive` and `key {measure:true}` report the sprite after a gesture, but an
 * interactive game loop also needs a pure observation between gestures ("where
 * did the sprite end up after that burst?"). Sending a key just to read the
 * state perturbs exactly the thing being measured, so this is the read-only
 * counterpart: same measurement, no key events, optional settle.
 */
export async function measurePage({ settle, tabId: hint } = {}) {
  const tabId = await requirePage(hint)
  const contextId = await guardedContext(tabId)
  if (settle) {
    // Poll the raw measurement until the sprite stops moving (or ~3.5 s pass),
    // then take one withVelocity read so vx/vy describe the resting pose.
    const started = Date.now()
    let prev = ''
    let calm = 0
    while (Date.now() - started < 3500) {
      const m = await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId })
      const car = m && m.car
      const sig = car ? `${Math.round(car.cx * 2)},${Math.round(car.cy * 2)}` : ''
      if (sig && sig === prev) { if (++calm >= 2) break } else calm = 0
      prev = sig
      await delay(110)
    }
  }
  return withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
}
