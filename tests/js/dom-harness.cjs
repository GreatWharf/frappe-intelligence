/* Minimal, dependency-free DOM contract harness for the actual browser client.
 * Implements the DOM/event operations this client uses; it is NOT a browser or a visual layout test.
 * Browser coverage belongs to browser.cjs against the explicit local mock preview.
 */
'use strict';
const vm = require('node:vm');
const decode = (text) => String(text).replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[key]);
const encode = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const voids = new Set(['input', 'br', 'hr', 'meta', 'link', 'img', 'source', 'wbr']);
/* Minimal MutationObserver: childList-only, batched one callback per microtask
 * per observer, mirroring how real observers coalesce a synchronous burst. */
class MutationObserver {
  constructor(callback) { this.callback = callback; this.nodes = []; this.pending = false; }
  observe(node, options = {}) { if (!options.childList || this.nodes.includes(node)) return; this.nodes.push(node); (node._mutWatchers || (node._mutWatchers = [])).push(this); }
  disconnect() { for (const node of this.nodes) node._mutWatchers = (node._mutWatchers || []).filter((watcher) => watcher !== this); this.nodes = []; }
  fire() { if (this.pending) return; this.pending = true; queueMicrotask(() => { this.pending = false; this.callback([{ type: 'childList' }], this); }); }
}
const notifyMutations = (node) => { for (const watcher of [...(node._mutWatchers || [])]) watcher.fire(); };
class Event {
  constructor(type, options = {}) { Object.assign(this, { type, bubbles: false, cancelable: false, defaultPrevented: false }, options); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}
function matches(node, selector) {
  if (node.tagName === '#text') return false;
  const parts = selector.trim().split(/\s+(?=[^\]]*(?:\[|$))/);
  if (parts.length > 1) { const last = parts.pop(); if (!matches(node, last)) return false; let parent = node.parentNode; while (parent) { if (matches(parent, parts.join(' '))) return true; parent = parent.parentNode; } return false; }
  selector = selector.replace(/:not\(([^)]+)\)/g, (_, excluded) => matches(node, excluded) ? '#__never_match__' : '');
  const tag = selector.match(/^[\w-]+/); if (tag && node.tagName !== tag[0].toLowerCase()) return false;
  for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(match[1])) return false;
  const id = selector.match(/#([\w-]+)/); if (id && node.getAttribute('id') !== id[1]) return false;
  for (const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    if (!node.hasAttribute(match[1])) return false;
    if (match[2] !== undefined && node.getAttribute(match[1]) !== match[2]) return false;
  }
  return true;
}
class Element {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.listeners = new Map(); this.style = {};
    this.scrollTop = 0; this.scrollHeight = 300; this.clientHeight = 500;
    this.dataset = new Proxy({}, { get: (_, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, (s) => '-' + s.toLowerCase())) || undefined, set: (_, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, (s) => '-' + s.toLowerCase()), value); return true; } });
    this.classList = { contains: (name) => this.className.split(/\s+/).includes(name), add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' '); }, remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(' '); }, toggle: (name, force) => { const add = force === undefined ? !this.classList.contains(name) : force; if (add) this.classList.add(name); else this.classList.remove(name); return add; } };
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] === undefined ? null : this.attrs[key]; }
  hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
  removeAttribute(key) { delete this.attrs[key]; }
  get className() { return this.attrs.class || ''; } set className(value) { this.attrs.class = value; }
  get disabled() { return this.hasAttribute('disabled'); } set disabled(value) { if (value) this.attrs.disabled = ''; else delete this.attrs.disabled; }
  get hidden() { return this.hasAttribute('hidden'); } set hidden(value) { if (value) this.attrs.hidden = ''; else delete this.attrs.hidden; }
  get checked() { return this._checked === undefined ? this.hasAttribute('checked') : this._checked; } set checked(value) { this._checked = !!value; }
  get value() { if (this._value !== undefined) return this._value; if (this.tagName === 'select') { const option = this.querySelector('option'); return option ? option.value : ''; } return this.attrs.value || (['textarea', 'option'].includes(this.tagName) ? this.textContent : ''); }
  set value(value) { this._value = String(value == null ? '' : value); }
  get name() { return this.attrs.name; } set name(value) { this.attrs.name = value; }
  get title() { return this.attrs.title; } set title(value) { this.attrs.title = value; }
  get textContent() { return this.tagName === '#text' ? this.data : this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(value) { if (this.tagName === '#text') this.data = String(value); else { this.childNodes.forEach((node) => { node.parentNode = null; }); this.childNodes = []; notifyMutations(this); const node = new Element('#text', this.ownerDocument); node.data = String(value); this.appendChild(node); } }
  get innerHTML() { return this.childNodes.map((node) => node.outerHTML).join(''); }
  set innerHTML(value) { this.childNodes.forEach((node) => { node.parentNode = null; }); this.childNodes = []; notifyMutations(this); parse(String(value), this); }
  get outerHTML() { if (this.tagName === '#text') return encode(this.data); const attrs = Object.entries(this.attrs).map(([key, value]) => ' ' + key + '="' + encode(value) + '"').join(''); return '<' + this.tagName + attrs + '>' + (voids.has(this.tagName) ? '' : this.innerHTML + '</' + this.tagName + '>'); }
  get children() { return this.childNodes.filter((node) => node.tagName !== '#text'); }
  get isConnected() { let current = this; while (current) { if (current === this.ownerDocument) return true; current = current.parentNode; } return false; }
  get elements() { const elements = this.querySelectorAll('input,select,textarea,button'); return new Proxy(elements, { get: (target, key) => key in target ? target[key] : target.find((node) => node.name === key) }); }
  appendChild(node) { if (node.parentNode) node.remove(); node.parentNode = this; this.childNodes.push(node); notifyMutations(this); return node; }
  insertBefore(node, ref) { if (node.parentNode) node.remove(); node.parentNode = this; const index = ref ? this.childNodes.indexOf(ref) : -1; if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node); notifyMutations(this); return node; }
  after(node) { if (!this.parentNode) return; const index = this.parentNode.childNodes.indexOf(this); if (node.parentNode) node.remove(); node.parentNode = this.parentNode; this.parentNode.childNodes.splice(index + 1, 0, node); notifyMutations(this.parentNode); }
  get nextSibling() { if (!this.parentNode) return null; const index = this.parentNode.childNodes.indexOf(this); return this.parentNode.childNodes[index + 1] || null; }
  remove() { const parent = this.parentNode; if (parent) this.parentNode.childNodes = parent.childNodes.filter((node) => node !== this); this.parentNode = null; if (parent) notifyMutations(parent); }
  contains(node) { while (node) { if (node === this) return true; node = node.parentNode; } return false; }
  querySelectorAll(selector) { const selectors = selector.split(',').map((part) => part.trim()), result = []; const walk = (parent) => { for (const node of parent.childNodes) { if (selectors.some((part) => matches(node, part))) result.push(node); walk(node); } }; walk(this); return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { let node = this; while (node) { if (matches(node, selector)) return node; node = node.parentNode; } return null; }
  addEventListener(type, listener, options) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push({ listener, once: options && options.once }); }
  dispatchEvent(event) { if (!event.target) event.target = this; event.currentTarget = this; for (const entry of [...(this.listeners.get(event.type) || [])]) { entry.listener(event); if (entry.once) this.listeners.set(event.type, this.listeners.get(event.type).filter((item) => item !== entry)); } if (event.bubbles && !event.stopped && this.parentNode) this.parentNode.dispatchEvent(event); return !event.defaultPrevented; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
  focus() { this.ownerDocument.activeElement = this; }
  getClientRects() { return this.isConnected && !this.closest('[hidden]') ? [{}] : []; }
  reset() { for (const node of this.querySelectorAll('input,select,textarea')) { node._value = undefined; node._checked = undefined; } }
}
function parse(html, parent) {
  const stack = [parent], regex = /<!--[^]*?-->|<![^>]*>|<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi;
  for (const match of html.matchAll(regex)) {
    const current = stack[stack.length - 1];
    if (match[3]) { const text = new Element('#text', parent.ownerDocument); text.data = decode(match[3]); current.appendChild(text); continue; }
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    if (match[0][1] === '/') { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag) { stack.length = i; break; } continue; }
    const node = new Element(tag, parent.ownerDocument);
    for (const attr of match[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)) node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
    current.appendChild(node); if (!voids.has(tag) && !match[0].endsWith('/>')) stack.push(node);
  }
}
class Document extends Element {
  constructor() { super('#document'); this.ownerDocument = this; this.readyState = 'complete'; this.documentElement = this.appendChild(new Element('html', this)); this.body = this.documentElement.appendChild(new Element('body', this)); this.activeElement = this.body; }
  createElement(tag) { return new Element(tag.toLowerCase(), this); }
}
class JSDOM {
  constructor(html) {
    const document = new Document(), timers = new Set(); document.body.innerHTML = html.replace(/<!doctype[^>]*>|<\/?(?:html|body)[^>]*>/gi, '');
    const window = { document, URL, console, Event, KeyboardEvent: Event, MutationObserver, navigator: { onLine: true }, Promise, Map, Set, Date, JSON, Object, Array, String, Number, Math,
      setTimeout: (fn, delay) => { const id = setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; }, clearTimeout: (id) => { timers.delete(id); clearTimeout(id); }, addEventListener: () => {}, close: () => { for (const id of timers) clearTimeout(id); timers.clear(); } };
    window.window = window; window.globalThis = window; const context = vm.createContext(window); window.eval = (source) => vm.runInContext(source, context); this.window = window;
  }
}
module.exports = { JSDOM };
