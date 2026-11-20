// Browser Bridge worker: commands/input/type.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { clearAndType, ensureTyped, readActiveElement, requireEditableTarget, requireInputVisibility, typedValueDidNotLand } from './shared.js'
import { requirePage } from '../tabs.js'
import { clearForced, ensureLayout, frameContext, pageMeta, send } from '../../lib/cdp.js'
import { delay, fail, inputSuccess, resolveTarget } from '../../lib/util.js'

export async function typePage({ target, text, submit, frame, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const { visibility, forced } = await requireInputVisibility(tabId, 'type', forceWanted)
  await ensureLayout(tabId)
  const wanted = String(text ?? '')
  const finish = async (reply) => {
    if (forced) await clearForced(tabId, forced)
    return { ...reply, ...inputSuccess(visibility, forced) }
  }
  if (frame) {
    const { frame: hit, contextId } = await frameContext(tabId, frame)
    const selector = resolveTarget(target, tabId)
    const where = `frame ${hit.url || hit.frameId}`
    await requireEditableTarget(tabId, selector, contextId, where)
    const mode = await clearAndType(tabId, text, { bulk: true })
    const frameTyped = await ensureTyped(tabId, selector, text, contextId)
    if (wanted.length && (typeof frameTyped.value !== 'string' || !frameTyped.value.includes(wanted))) {
      throw fail('TYPE_NOT_APPLIED', typedValueDidNotLand(selector, wanted, frameTyped.value))
    }
    const activeElement = await readActiveElement(tabId, contextId)
    if (submit === true) {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key })
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    }
    await delay(300)
    const frameMeta = await pageMeta(tabId)
    const activeElementAfter = submit === true ? await readActiveElement(tabId, contextId) : undefined
    return finish({
      url: frameMeta?.url ?? '', title: frameMeta?.title ?? '', frameId: hit.frameId,
      typed: frameTyped.value ?? undefined, valueAfter: frameTyped.value ?? undefined, valueForced: frameTyped.forced,
      mode, activeElement: activeElement ?? undefined, ...(submit === true ? { activeElementAfter: activeElementAfter ?? undefined } : {}),
    })
  }
  const selector = resolveTarget(target, tabId)
  await requireEditableTarget(tabId, selector)
  // Insert as real input so every keystroke goes through the page's handlers.
  const mode = await clearAndType(tabId, text, { bulk: true })
  const landed = await ensureTyped(tabId, selector, text)
  if (wanted.length && (typeof landed.value !== 'string' || !landed.value.includes(wanted))) {
    throw fail('TYPE_NOT_APPLIED', typedValueDidNotLand(selector, wanted, landed.value))
  }
  const activeElement = await readActiveElement(tabId)
  if (submit === true) {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key })
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }
  await delay(300)
  const meta = await pageMeta(tabId)
  const activeElementAfter = submit === true ? await readActiveElement(tabId) : undefined
  return finish({
    url: meta?.url ?? '', title: meta?.title ?? '',
    typed: landed.value ?? undefined, valueAfter: landed.value ?? undefined, valueForced: landed.forced,
    mode, activeElement: activeElement ?? undefined, ...(submit === true ? { activeElementAfter: activeElementAfter ?? undefined } : {}),
  })
}
