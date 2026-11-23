/**
 * Mock harness for index.js — verifies v2.1.0 host behaviour:
 *   1. the route is registered under the new `__dsh-` prefixed path;
 *   2. a full turn produces a self-consistent ledger;
 *   3. the ledger persists under $DSH_HOME/storages/dsh-reply-timer/samples.json,
 *      NOT inside the package folder.
 */
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'dsh-home-'));
process.env.DSH_HOME = home;

// Make sure no stale in-package samples.json can satisfy the assertion.
const legacy = join(PKG, 'samples.json');
const hadLegacy = existsSync(legacy);

const mod = await import(new URL('../index.js', import.meta.url).href);
const { apply, ROUTE } = mod;
console.log('ROUTE =', ROUTE);
if (!ROUTE.startsWith('/__dsh-')) throw new Error('route lost its unique prefix');

const handlers = new Map();
const effects = [];
const ctx = {
  logger: { warn: (m) => console.log('WARN:', m) },
  on: (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event); },
  effect: (fn) => { const d = fn(); effects.push(d); return () => {}; },
  webServer: {
    register: (route) => {
      routes.push(route);
      return () => {};
    },
  },
  connection: { requestRejection: () => undefined },
};
const routes = [];
apply(ctx);
if (!routes.length) throw new Error('no route registered');
console.log('registered route =', routes[0].kind, routes[0].path);
if (routes[0].path !== ROUTE) throw new Error('route path mismatch');

/* ---- drive one complete turn ------------------------------------- */
const emit = (ev, ...args) => { const fn = handlers.get(ev); if (!fn) throw new Error('no handler for ' + ev); fn(...args); };
const sid = 'session-test-1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = { id: sid };
const ev = (type, extra = {}) => ({ type, sessionId: sid, ...extra });

emit('session/event', session, ev('turn/start'));
// REGRESSION: the real log order is turn/start -> step/start -> the user
// message that opened the turn, all within ~35ms. That user message must NOT
// close the turn (v2.1.0 did, recording a 36ms "interrupted" ledger).
emit('session/event', session, ev('step/start', { step: 1 }));
emit('session/event', session, ev('user/message', { source: { kind: 'user' }, role: 'user' }));
await sleep(80);   // 首字延迟
emit('agent/assistant-stream', { agent: session, frame: { type: 'chunk', chunk: { type: 'text-delta' } } });
await sleep(120);  // 工具耗时
emit('session/event', session, ev('tool/call', { callId: 'c1', toolName: 'bash' }));
await sleep(120);
emit('session/event', session, ev('tool/result', { callId: 'c1' }));
await sleep(100);  // 生成耗时
emit('session/event', session, ev('turn/end'));

/* ---- a subagent turn must never be recorded ----------------------- *
 * `session/event` carries the Session object, so its `origin` is the only
 * authoritative subagent signal; the stream/status feeds carry ids alone.
 * A child that opened a provisional row before its first event used to end up
 * in `lastDone` and block every real sample from ever being recorded.
 */
const childSid = 'session-child';
const child = { id: childSid, origin: 'subagent' };
emit('agent/assistant-stream', { agent: child, frame: { type: 'chunk', chunk: { type: 'text-delta' } } });
emit('api-session/status', childSid, true);
emit('session/event', child, { type: 'turn/start', sessionId: childSid });
emit('session/event', child, { type: 'tool/call', sessionId: childSid, data: { callId: 'x1', toolName: 'bash' } });
emit('session/event', child, { type: 'turn/end', sessionId: childSid });
emit('api-session/status', childSid, false);

/* ---- read the snapshot through the route handler ------------------ */
let body = null;
const res = {
  statusCode: 0,
  headers: {},
  writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
  setHeader(k, v) { this.headers[k] = v; },
  end(text) { body = JSON.parse(text); },
};
routes[0].handler({ method: 'GET', headers: {} }, res);
console.log('route status =', res.statusCode, '| ok =', body.ok);
const snap = body.value;
const st = snap.sessions[sid];
if (!st) throw new Error('no session in snapshot: ' + JSON.stringify(Object.keys(snap.sessions)));
console.log('phase =', st.phase, '| totalMs =', st.totalMs, '| ttftMs =', st.ttftMs,
  '| toolMs =', st.toolMs, '| genMs =', st.genMs, '| endedReason =', JSON.stringify(st.endedReason));
console.log('sessions in snapshot =', Object.keys(snap.sessions).join(','));
if (Object.prototype.hasOwnProperty.call(snap.sessions, childSid)) {
  throw new Error('subagent session leaked into the snapshot: ' + JSON.stringify(snap.sessions[childSid]));
}

/* ---- wait for the debounced save, then inspect disk ---------------- */
await new Promise((r) => setTimeout(r, 1400));
const stored = join(home, 'storages', 'dsh-reply-timer', 'samples.json');
if (!existsSync(stored)) throw new Error('samples.json was not written to ' + stored);
const disk = JSON.parse(await readFile(stored, 'utf8'));
console.log('disk keys =', Object.keys(disk).join(','));
console.log('disk lastDone has sid =', Object.prototype.hasOwnProperty.call(disk.lastDone, sid));
console.log('in-package samples.json created =', existsSync(legacy) && !hadLegacy);
if (existsSync(legacy) && !hadLegacy) throw new Error('plugin wrote inside its own package folder');
console.log('sample buckets =', JSON.stringify(Object.keys(disk.samples || {})));
if (Object.prototype.hasOwnProperty.call(disk.lastDone, childSid)) {
  throw new Error('subagent turn reached lastDone: ' + JSON.stringify(disk.lastDone[childSid]));
}
if (Object.prototype.hasOwnProperty.call(disk.turnLedgers, childSid)) {
  throw new Error('subagent turn reached turnLedgers');
}
if (!disk.turnLedgers[sid] || Object.keys(disk.turnLedgers[sid]).length !== 1) {
  throw new Error('the real turn did not land in turnLedgers: ' + JSON.stringify(disk.turnLedgers));
}

/* ---- ledger must partition the wall time exactly ------------------- */
const seg = (st.ttftMs || 0) + (st.toolMs || 0) + (st.genMs || 0) + (st.pausedMs || 0);
console.log('segment sum =', seg, 'vs totalMs =', st.totalMs);
if (Math.abs(seg - st.totalMs) > 2) throw new Error('ledger does not partition the wall time');
if (!disk.lastDone[sid] || disk.lastDone[sid].totalMs !== st.totalMs) {
  throw new Error('persisted lastDone disagrees with the snapshot');
}

// Dispose every effect (watchdog interval) so this process can exit.
for (const d of effects) { try { if (typeof d === 'function') d(); } catch {} }

await rm(home, { recursive: true, force: true });
console.log('OK: host route + ledger + out-of-package persistence');
