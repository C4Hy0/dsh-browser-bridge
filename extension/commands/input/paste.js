// Browser Bridge worker: commands/input/paste.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { requireEditableTarget, requireInputVisibility } from './shared.js'
import { requirePage } from '../tabs.js'
import { clearForced, evaluate, pageMeta, send } from '../../lib/cdp.js'
import { PASTE_MAX_CHARS } from '../../lib/constants.js'
import { delay, fail, inputSuccess, resolveTarget } from '../../lib/util.js'

/**
 * Put text on the OS clipboard from the extension service worker.
 *
 * Chrome 157 lets an extension worker holding the `clipboardWrite` permission
 * call `navigator.clipboard.writeText` directly; older builds expose no
 * clipboard API in a worker. The write is bounded because a clipboard call that
 * never settles used to look like a hung browser.
 */
export async function writeClipboardText(text) {
  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return { ok: false, reason: 'navigator.clipboard is not available in this worker' }
  }
  try {
    await Promise.race([
      clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(fail('CLIPBOARD_TIMEOUT', 'the clipboard write did not settle in 3 s')), 3000)),
    ])
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/** Ctrl on Windows/Linux, Command on macOS. */
export async function pasteModifier() {
  try {
    const info = await chrome.runtime.getPlatformInfo()
    return info?.os === 'mac' ? 4 : 2
  } catch {
    return 2
  }
}

/**
 * Insert text as a paste, without DOM injection.
 *
 * Preferred route: write the text to the OS clipboard and send a real Ctrl+V
 * whose key event carries Blink's `paste` edit command. That is the browser's
 * own paste path, so a spreadsheet explodes TSV into cells and a rich editor
 * receives one paste instead of hundreds of keystrokes. When the clipboard
 * write is unavailable, the honest fallback is CDP `Input.insertText`: one real
 * browser-level insertion at the caret, reported as `mode:"insertText"` because
 * it is not a native paste and does not trigger the page's paste handler.
 *
 * `key` text mode stops at 1000 keys; paste has a much higher cap and says so
 * when it truncates.
 */
export async function pastePage({ text, target, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  if (typeof text !== 'string' || text.length === 0) throw fail('BAD_ARGUMENT', 'paste needs text')
  const { visibility, forced } = await requireInputVisibility(tabId, 'paste', forceWanted)
  const finish = async (reply) => {
    if (forced) await clearForced(tabId, forced)
    return { ...reply, ...inputSuccess(visibility, forced) }
  }
  if (target) {
    const selector = resolveTarget(target, tabId)
    await requireEditableTarget(tabId, selector, undefined, undefined, 'paste')
  } else {
    // With no target the insertion goes to the focused element; if the page has
    // no focused element at all, nothing can receive it.
    const focused = await evaluate(tabId, '(() => { const el = document.activeElement; return !!el && el !== document.body && el !== document.documentElement })()').catch(() => false)
    if (!focused) {
      throw fail('NOT_EDITABLE', 'paste needs a focused element: click the field or cell first, or pass target. Nothing was inserted.')
    }
  }
  const points = Array.from(text)
  const truncated = points.length > PASTE_MAX_CHARS
  const body = truncated ? points.slice(0, PASTE_MAX_CHARS).join('') : text
  const chars = truncated ? PASTE_MAX_CHARS : points.length
  const meta = await pageMeta(tabId)
  const clipboard = await writeClipboardText(body)
  if (clipboard.ok) {
    const modifiers = await pasteModifier()
    const key = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers }
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, commands: ['paste'] })
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    await delay(150)
    return finish({
      url: meta?.url ?? '',
      title: meta?.title ?? '',
      chars,
      truncated,
      mode: 'clipboard',
      note: 'clipboard paste: the text was written to the OS clipboard and the browser paste edit command was sent with a real Ctrl+V key event, so the clipboard now holds this text and a spreadsheet can explode TSV into cells. '
        + 'Read the target back to confirm it landed; if nothing arrived, front the tab with bsb_tabs use so the page has focus and retry.',
    })
  }
  await send(tabId, 'Input.insertText', { text: body })
  await delay(150)
  return finish({
    url: meta?.url ?? '',
    title: meta?.title ?? '',
    chars,
    truncated,
    mode: 'insertText',
    note: 'not a native clipboard paste: the clipboard was not written and the text was inserted with CDP Input.insertText as one run at the caret. '
      + 'It does not fire the page paste handler and does not explode TSV into spreadsheet cells. '
      + `The clipboard write failed because ${clipboard.reason}.`,
  })
}
