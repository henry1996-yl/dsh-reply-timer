/**
 * Regression harness for the long-turn cap.
 *
 * Real turn durations in this workspace's session logs are p50 56s, p90 562s,
 * p99 3496s, max 4493s (75 minutes). v2.3.0 capped recording at MAX_TURN_MS =
 * 30 minutes, so 3.3% of real turns — exactly the slow ones the plugin exists
 * to explain — produced no sample and no ledger at all.
 *
 * This drives one 4493s turn on a fake clock and asserts it is still recorded.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = await mkdtemp(join(tmpdir(), 'dsh-home-long-'));
process.env.DSH_HOME = home;

// A 75-minute turn must not need 75 real minutes to test.
let clock = 1794793296181;
const realNow = Date.now;
Date.now = () => clock;

const mod = await import(new URL('../index.js', import.meta.url).href);
const { apply } = mod;

const handlers = new Map();
const routes = [];
const effects = [];
apply({
  logger: { warn: () => {} },
  on: (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event); },
  effect: (fn) => { const d = fn(); effects.push(d); return () => {}; },
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  connection: { requestRejection: () => undefined },
});

const emit = (event, ...args) => {
  const fn = handlers.get(event);
  if (!fn) throw new Error('no handler for ' + event);
  fn(...args);
};
const sid = 'session-long';
const session = { id: sid };
const ev = (type, data = {}) => ({ type, sessionId: sid, data });

const TOTAL = 4493 * 1000;   // the longest turn observed in the real logs

emit('session/event', session, ev('turn/start', { turn: 1 }));
// Interleave activity so this looks like a working turn, not a suspended app.
for (let i = 1; i <= 40; i += 1) {
  clock += 100000;
  emit('session/event', session, ev('step/start', { step: i }));
  clock += 12000;
  emit('agent/assistant-stream', {
    agent: session,
    frame: { type: 'chunk', chunk: { type: 'text-delta' } },
  });
}
clock = 1794793296181 + TOTAL;
emit('session/event', session, ev('turn/end', { reason: { kind: 'completed' } }));

let body = null;
const res = {
  writeHead(status) { this.statusCode = status; return this; },
  setHeader() {},
  end(text) { body = JSON.parse(text); },
};
routes[0].handler({ method: 'GET', headers: {} }, res);
const st = body.value.sessions[sid];
if (!st) throw new Error('long turn vanished from the snapshot');
console.log('phase =', st.phase, '| totalMs =', st.totalMs, '| endedReason =', JSON.stringify(st.endedReason));
if (st.endedReason !== 'completed') throw new Error('long turn was not completed: ' + st.endedReason);
if (Math.abs(st.totalMs - TOTAL) > 5) throw new Error('long turn lost time: ' + st.totalMs);

await new Promise((r) => setTimeout(r, 1400));
const disk = JSON.parse(await readFile(join(home, 'storages', 'dsh-reply-timer', 'samples.json'), 'utf8'));
const buckets = Object.entries(disk.samples).filter(([, arr]) => arr.includes(TOTAL));
console.log('sample buckets containing the long turn =', JSON.stringify(buckets.map(([k]) => k)));
if (buckets.length !== 1) throw new Error('the 75-minute turn never entered a sample bucket: ' + JSON.stringify(disk.samples));

const ledgers = disk.turnLedgers[sid] || {};
const key = Object.keys(ledgers)[0];
console.log('ledger =', key, '| totalMs =', ledgers[key] && ledgers[key].totalMs);
if (!key) throw new Error('the 75-minute turn produced no ledger');

Date.now = realNow;
for (const d of effects) { try { if (typeof d === 'function') d(); } catch {} }
await rm(home, { recursive: true, force: true });
console.log('OK: a 75-minute turn still lands in samples and turnLedgers');
