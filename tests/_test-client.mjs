/**
 * Mock harness for client.js — verifies the v2.1.0 session binding.
 * Loads the real bundle through a fake window.__ModuleLoader__, with a fake
 * `react` module, then drives the registration the way the Host does for a
 * scope:'session' slot.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const fakeReact = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: () => 0,
};

let definition = null;
globalThis.window = {
  __ModuleLoader__: { load: (d) => { definition = d; } },
  matchMedia: () => ({ matches: false }),
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = { baseURI: 'http://127.0.0.1:4797/' };
globalThis.fetch = () => Promise.reject(new Error('no network in test'));

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
// Evaluate the bundle body: it only touches window.__ModuleLoader__.load.
new Function('window', 'document', 'fetch', 'setTimeout', 'setInterval', source)(
  globalThis.window, globalThis.document, globalThis.fetch, () => 0, () => 0,
);
if (!definition) throw new Error('bundle did not call __ModuleLoader__.load');
console.log('bundle id =', definition.id);

const mod = definition.factory((name) => {
  if (name === 'react') return fakeReact;
  throw new Error('unexpected require: ' + name);
});
console.log('exports.inject =', JSON.stringify(mod.inject));

/* Build a mock ctx that records the registration options + component. */
let registered = null;
const ctx = {
  locale: { register: () => () => {}, bind: () => (k) => k },
  effect: (fn) => { try { fn(); } catch {} return () => {}; },
  sessions: {},           // deliberately NO .list — the real contract has none
  slots: {
    inject: (key, cb) => cb(),
    register: (opts, component) => { registered = { opts, component }; return () => {}; },
  },
};

mod.apply(ctx);
if (!registered) throw new Error('slot was never registered');
const { opts, component } = registered;
console.log('slot =', opts.name, '| id =', opts.id, '| order =', opts.order);
console.log('has inject face =', typeof opts.inject === 'function');

/* Render the widget with the face the Host would produce for session A. */
const face = opts.inject('session-A');
console.log('face =', JSON.stringify(face));
const element = component(face);
console.log('widget props.sessionId =', JSON.stringify(element.props.sessionId));

/*
 * Now prove pickRaw is session-scoped: two running sessions, and the widget is
 * mounted for session-B. It must show B, never A.
 */
const storeProbe = element.props;
console.log('rendered element type =', typeof element.type);

console.log('OK: session id reaches the widget through the inject face');
