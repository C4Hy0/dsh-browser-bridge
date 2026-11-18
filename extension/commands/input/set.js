// Browser Bridge worker: commands/input/set.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { requirePage } from '../tabs.js'
import { evaluate, evaluateInContext, frameContext, pageMeta } from '../../lib/cdp.js'
import { fail, recentDialog, resolveTarget } from '../../lib/util.js'

/**
 * Choose an option in a <select> by value, visible label or zero-based index.
 *
 * Native dropdowns render outside the page, so a click opens an OS menu that
 * CDP cannot address; setting the option and firing input/change is the
 * reliable path. The result reports the value that actually stuck.
 */
export async function selectOption({ target, value, label, index, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
  if (!target) throw fail('BAD_ARGUMENT', 'select needs a target selector')
  const selector = resolveTarget(target, tabId)
  const ctx = frame ? await frameContext(tabId, frame) : null
  const run = ctx
    ? (expression) => evaluateInContext(tabId, ctx.contextId, expression)
    : (expression) => evaluate(tabId, expression)
  const arg = JSON.stringify({
    selector,
    value: value == null ? null : String(value),
    label: label == null ? null : String(label),
    index: index == null || index === '' ? null : Number(index),
  })
  const result = await run(`(() => {
    const arg = ${arg};
    const el = document.querySelector(arg.selector);
    if (!el) return { error: 'TARGET_NOT_FOUND' };
    if (String(el.tagName).toUpperCase() !== 'SELECT') return { error: 'NOT_A_SELECT', tag: el.tagName };
    const options = Array.from(el.options);
    let option = null;
    if (arg.index != null) option = options[arg.index] ?? null;
    else if (arg.value != null) option = options.find((o) => o.value === arg.value) ?? null;
    else if (arg.label != null) option = options.find((o) => (o.label || o.textContent || '').trim() === arg.label) ?? null;
    if (!option) return { error: 'NO_OPTION', options: options.map((o) => ({ value: o.value, label: o.label })) };
    el.value = option.value;
    option.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: el.value, label: option.label, count: options.length };
  })()`)
  if (result?.error === 'TARGET_NOT_FOUND') throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
  if (result?.error === 'NOT_A_SELECT') throw fail('NOT_A_SELECT', `${selector} is a ${result.tag}, not a <select>`)
  if (result?.error === 'NO_OPTION') {
    const available = (result.options || []).map((o) => `${o.value} (${o.label})`).join(', ')
    throw fail('NO_OPTION', `no option matches; available: ${available || '(none)'}`)
  }
  const meta = await pageMeta(tabId)
  const frameId = ctx?.frame?.frameId
  return { url: meta?.url ?? '', title: meta?.title ?? '', selector, ...(frameId ? { frameId } : {}), ...result, dialog: recentDialog(tabId) }
}

/**
 * Set a form control's value without a pointer: text inputs, textareas,
 * ranges, numbers and checkboxes/radios.
 *
 * Typing through CDP goes through the real keyboard path, which is right for
 * text a user would type but useless for a slider (no key moves a range
 * reliably) or a checkbox bound to a framework. This sets the value through
 * the prototype setter (React and Svelte store their own copy of the value, so
 * assigning `el.value` can be ignored) and fires `input` + `change`.
 */
export async function setControl({ target, value, checked, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
  if (!target) throw fail('BAD_ARGUMENT', 'set needs a target selector')
  const selector = resolveTarget(target, tabId)
  const arg = JSON.stringify({
    selector,
    value: value == null ? '' : String(value),
    checked: typeof checked === 'boolean' ? checked : null,
  })
  const source = `(() => {
    const arg = ${arg};
    const walk = (sel, root) => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      for (const node of root.querySelectorAll("*")) {
        if (!node.shadowRoot) continue;
        const inner = walk(sel, node.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const el = walk(arg.selector, document);
    if (!el) return { error: 'TARGET_NOT_FOUND' };
    el.focus && el.focus();
    const tag = String(el.tagName).toUpperCase();
    const type = (el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      const want = arg.checked == null ? arg.value !== 'false' && arg.value !== '' : arg.checked;
      if (el.checked !== want) el.click();
      return { tag, type, value: el.value, checked: el.checked };
    }
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && type !== 'file')) {
      const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, arg.value); else el.value = arg.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { tag, type, value: el.value, checked: false };
    }
    if (el.isContentEditable) {
      el.textContent = arg.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { tag, type: 'contenteditable', value: el.textContent, checked: false };
    }
    return { error: 'NOT_A_CONTROL', tag, type };
  })()`
  let result
  let frameId
  if (frame) {
    const hit = await frameContext(tabId, frame)
    result = await evaluateInContext(tabId, hit.contextId, source)
    frameId = hit.frame.frameId
  } else {
    result = await evaluate(tabId, source)
  }
  if (result?.error === 'TARGET_NOT_FOUND') throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
  if (result?.error === 'NOT_A_CONTROL') throw fail('NOT_A_CONTROL', `${selector} is a <${result.tag}${result.type ? ' type="' + result.type + '"' : ''}>, which this tool cannot set`)
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', selector, ...result, ...(frameId ? { frameId } : {}), dialog: recentDialog(tabId) }
}
