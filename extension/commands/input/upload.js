// Browser Bridge worker: commands/input/upload.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { pressAt, requireInputVisibility } from './shared.js'
import { shared } from '../../lib/state.js'
import { requirePage } from '../tabs.js'
import { clearForced, evaluate, evaluateInContext, frameList, guardedContext, pageMeta, resolveFrameArg, send, waitEvent } from '../../lib/cdp.js'
import { FILE_CHOOSER_WAIT_MS } from '../../lib/constants.js'
import { boxOf } from '../../lib/page.js'
import { delay, fail, inputSuccess, isFileInputNode, resolveTarget } from '../../lib/util.js'

/**
 * Attach files to an <input type="file">.
 *
 * Chrome opens the paths itself, so they must be paths the browser machine can
 * see (a Windows path when Chrome runs on Windows), not WSL paths.
 *
 * Three routes, strongest first:
 * - a selector that already IS the file input in the top document: set it
 *   directly (no click, so it works on a hidden tab);
 * - `frame`: the same direct set inside a frame whose document the tab can
 *   reach (same-origin or same-process);
 * - otherwise a real press at `x,y` (or on a top-document trigger) with
 *   `Page.setInterceptFileChooserDialog` armed, then `DOM.setFileInputFiles`
 *   with the `backendNodeId` the chooser event reports. This needs no script
 *   access to the frame document, which is what makes a cross-origin picker
 *   reachable at all.
 */
/** Fail when the page received a file it cannot read (0 bytes). */
export async function assertFilesReadable(tabId, selector, contextId) {
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || !el.files) return null;
    return Array.from(el.files).map((f) => ({ name: f.name, size: f.size }));
  })()`
  const read = contextId === undefined
    ? await evaluate(tabId, expression).catch(() => null)
    : await evaluateInContext(tabId, contextId, expression).catch(() => null)
  if (!Array.isArray(read) || read.length === 0) return
  const empty = read.filter((file) => Number(file.size) === 0)
  if (empty.length > 0) {
    throw fail(
      'FILE_NOT_READABLE',
      `the page received ${empty.map((file) => file.name).join(', ')} with 0 bytes: the browser could not read the file path. `
      + 'On a remote browser, pass a path that exists on that machine, or serve the file over http and download it there. '
      + 'The input now holds a 0-byte entry named after that path, and any earlier selection it held was replaced. '
      + 'A directory or a glob is not a regular file; pass the full path of one file.',
    )
  }
}

export async function uploadPage({ target, files, frame, x, y, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const list = Array.isArray(files)
    ? files.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim())
    : []
  if (!list.length) throw fail('BAD_ARGUMENT', 'upload needs at least one file path')
  const hasPoint = Number.isFinite(Number(x)) && Number.isFinite(Number(y))
  if (!target && !frame && !hasPoint) {
    throw fail('BAD_ARGUMENT', 'upload needs a target selector, a frame, or x and y that open the file chooser')
  }
  const names = list.map((f) => f.split(/[\\/]/).pop())
  await send(tabId, 'DOM.enable').catch(() => undefined)
  if (frame && (target || !hasPoint)) {
    const hit = resolveFrameArg(await frameList(tabId), frame)
    if (!hit) throw fail('FRAME_NOT_FOUND', `no child frame matches ${frame}`)
    if (!target) throw fail('BAD_ARGUMENT', 'upload with frame needs a target selector inside that frame, or x and y instead')
    // The frame's document is a node in the tab's DOM tree only when the frame
    // runs in the same process. `getFrameOwner` + `describeNode` alone misses it
    // for a same-origin picker iframe (the Google Picker is same-origin and was
    // still reported unreachable), so walk the pierced tree instead: it carries
    // every same-process iframe as a `contentDocument` child.
    const root = await send(tabId, 'DOM.getDocument', { depth: -1, pierce: true })
    const findFrameDocument = (node) => {
      if (!node) return null
      if (node.frameId === hit.frameId && node.contentDocument) return node.contentDocument
      for (const child of node.children ?? []) {
        const found = findFrameDocument(child)
        if (found) return found
      }
      return node.contentDocument ? findFrameDocument(node.contentDocument) : null
    }
    const frameDocument = findFrameDocument(root?.root)
    const rootNodeId = frameDocument?.nodeId
    if (!rootNodeId) {
      // A cross-site out-of-process frame is not part of this tab's DOM tree, so
      // no selector can resolve inside it. Say so instead of guessing.
      throw fail(
        'FRAME_NOT_READABLE',
        `the frame document is not part of the tab's DOM tree (a cross-site out-of-process frame): ${hit.url || hit.frameId}. `
        + 'Upload through a top-document target (a button, label, or the iframe element) or a top-document file input, '
        + 'or press the control that opens the chooser with x,y. A same-origin frame is reachable and should not hit this error.',
      )
    }
    const selector = resolveTarget(target, tabId)
    const found = await send(tabId, 'DOM.querySelector', { nodeId: rootNodeId, selector })
    if (!found?.nodeId) throw fail('TARGET_NOT_FOUND', `no element matches ${selector} in frame ${hit.url || hit.frameId}`)
    const node = (await send(tabId, 'DOM.describeNode', { nodeId: found.nodeId }))?.node ?? {}
    if (!isFileInputNode(node)) {
      throw fail(
        'NOT_A_FILE_INPUT',
        `${selector} is not an <input type="file">. If it is a control that opens the chooser, call upload without frame using x,y or a top-document target.`,
      )
    }
    const frameKey = tabId + ':' + selector
    const framePrior = shared.uploads.get(frameKey)
    const context = await guardedContext(tabId, hit.frameId).catch(() => undefined)
    try {
      await send(tabId, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: list })
      await delay(150)
      await assertFilesReadable(tabId, selector, context)
      shared.uploads.set(frameKey, { nodeId: found.nodeId, files: list })
    } catch (error) {
      if (framePrior?.files?.length) {
        try {
          await send(tabId, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: framePrior.files })
          await delay(150)
          await assertFilesReadable(tabId, selector, context)
          error.message += ' The previous selection was restored to ' + framePrior.files.join(', ') + '.'
        } catch {}
      }
      throw error
    }
    const meta = await pageMeta(tabId)
    return { url: meta?.url ?? '', title: meta?.title ?? '', count: list.length, files: names, via: 'frame', nodeId: found.nodeId, frameId: hit.frameId }
  }
  // A target that is itself the file input needs no press: this keeps the old
  // top-document path, including its behavior on a hidden tab.
  if (target) {
    const selector = resolveTarget(target, tabId)
    const root = await send(tabId, 'DOM.getDocument', { depth: 0, pierce: false })
    const found = await send(tabId, 'DOM.querySelector', { nodeId: root.root.nodeId, selector })
    if (found?.nodeId) {
      const node = (await send(tabId, 'DOM.describeNode', { nodeId: found.nodeId }))?.node ?? {}
      if (isFileInputNode(node)) {
        const key = tabId + ':' + selector
        const prior = shared.uploads.get(key)
        try {
          await send(tabId, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: list })
          await delay(150)
          await assertFilesReadable(tabId, selector)
          shared.uploads.set(key, { nodeId: found.nodeId, files: list })
        } catch (error) {
          // The failed set has already replaced the input with 0-byte junk. If
          // the last good paths are known, put them back before reporting.
          if (prior?.files?.length) {
            try {
              await send(tabId, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: prior.files })
              await delay(150)
              await assertFilesReadable(tabId, selector)
              error.message += ' The previous selection was restored to ' + prior.files.join(', ') + '.'
            } catch {}
          }
          throw error
        }
        const meta = await pageMeta(tabId)
        return { url: meta?.url ?? '', title: meta?.title ?? '', count: list.length, files: names, via: 'input', nodeId: found.nodeId }
      }
    }
  }
  // The chooser-interception route crashed the fixture renderer twice on live
  // tests (a modal native chooser plus the debugger session). It is withdrawn
  // until it can be validated without a renderer crash. A top-document input or
  // a reachable frame input still works; nothing is pressed here.
  throw fail(
    'UNSUPPORTED',
    'cross-origin file-chooser upload is disabled in this build: the interception route crashed the renderer on live tests. '
    + 'Set files on a top-document <input type="file"> with target, or on a reachable frame input. Nothing was pressed.',
  )
}

/**
 * Set files on a file input through the browser's own chooser.
 *
 * The press is real input at a viewport point, so the tab must be visible. The
 * interception is armed for this command only: leaving it on would swallow
 * every later chooser on the tab. The returned `backendNodeId` comes from
 * Chrome, so no selector is resolved inside the (possibly cross-origin) frame
 * document.
 */
export async function fileChooserUpload(tabId, { list, names, target, x, y, forceWanted }) {
  const { visibility, forced } = await requireInputVisibility(tabId, 'upload', forceWanted)
  let point
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    point = { x: Number(x), y: Number(y) }
  } else if (target) {
    const selector = resolveTarget(target, tabId)
    const box = await evaluate(tabId, `(${boxOf.toString()})(${JSON.stringify(selector)})`)
    if (!box) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
    if (box.offscreen) {
      throw fail('TARGET_OFFSCREEN', `${selector} stays outside the viewport after scrolling to it, so the press that opens the file chooser cannot land. Scroll it into view or pass x,y.`)
    }
    point = { x: box.x, y: box.y }
  } else {
    throw fail('BAD_ARGUMENT', 'upload needs x and y, or a top-document target, to open the file chooser')
  }
  // An explicit x,y outside the layout viewport used to reach pressAt and crash
  // the renderer on a hidden tab. Refuse it before any input is dispatched: a
  // press outside the viewport cannot open a chooser anyway.
  const viewport = await evaluate(tabId, '({ width: window.innerWidth, height: window.innerHeight })').catch(() => null)
  if (viewport && (point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height)) {
    throw fail(
      'TARGET_OFFSCREEN',
      `the press point (${Math.round(point.x)},${Math.round(point.y)}) is outside the ${Math.round(viewport.width)}x${Math.round(viewport.height)} viewport, so no file chooser can open there. `
      + 'Scroll the control into view with bsb_act scroll, or pass in-view x,y. Nothing was pressed.',
    )
  }
  const opened = waitEvent(tabId, 'Page.fileChooserOpened', FILE_CHOOSER_WAIT_MS)
  // The event may never arrive (a press that opens nothing). Mark the promise
  // handled so a failure before the await cannot surface as an unhandled rejection.
  opened.catch(() => undefined)
  let handled = false
  try {
    try {
      await send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true })
    } catch (error) {
      throw fail('FILE_CHOOSER_UNSUPPORTED', `this browser cannot intercept a file chooser (${error?.message ?? error}); pass a top-document <input type="file"> selector instead.`)
    }
    await pressAt(tabId, point, 1, 'left')
    let event
    try {
      event = await opened
    } catch {
      throw fail(
        'FILE_CHOOSER_NOT_OPENED',
        `no file chooser opened after pressing (${Math.round(point.x)},${Math.round(point.y)}). The press must land on an <input type="file">, its label, or a control that opens one. `
        + 'If the input lives in a cross-origin iframe, press the control itself with x,y: a frame that runs in another process cannot be intercepted from the tab.',
      )
    }
    if (!event?.backendNodeId) {
      throw fail(
        'FILE_INPUT_NOT_FOUND',
        'the file chooser opened but Chrome did not report an input node (only an <input type="file"> reports one; showOpenFilePicker() does not), so the files cannot be attached.',
      )
    }
    await send(tabId, 'DOM.setFileInputFiles', { backendNodeId: event.backendNodeId, files: list })
    handled = true
    await delay(200)
    const meta = await pageMeta(tabId)
    return {
      url: meta?.url ?? '',
      title: meta?.title ?? '',
      count: list.length,
      files: names,
      via: 'fileChooser',
      backendNodeId: event.backendNodeId,
      ...(event.frameId ? { frameId: event.frameId } : {}),
      ...inputSuccess(visibility, forced),
    }
  } finally {
    // Disable interception even when the press opened nothing. `cancel` releases
    // a chooser that is still pending because it reported no input node.
    await send(tabId, 'Page.setInterceptFileChooserDialog', handled ? { enabled: false } : { enabled: false, cancel: true })
      .catch(() => send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined))
    if (forced) await clearForced(tabId, forced)
  }
}
