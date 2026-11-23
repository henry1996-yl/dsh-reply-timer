/**
 * Replay a REAL session log through the host half.
 *
 * `_real-session.jsonl` holds 1289 durable SessionEvents exported from a live
 * DSH session (turn/start, step/start, user/message, tool/call, tool/result,
 * assistant/message with stream timing records, turn/end).
 *
 * The export is sanitized: only the fields this plugin actually reads survive —
 * event type, `seq`, `time`, turn/step numbers, tool callId + tool name, and
 * each assistant message's stream TIMING (chunk kinds plus `dt` deltas). Prose,
 * reasoning text, tool arguments, the session id and the working directory are
 * all dropped, so the fixture is a timing trace rather than a transcript.
 *
 * This is the fixture that caught the v2.1.0 bug where the user message that
 * OPENS a turn (appended ~35ms after `turn/start`) was treated as an
 * interjection and killed the turn 36ms in.
 *
 * The plugin timestamps everything with `Date.now()`, so the test pins a fake
 * clock to each event's own `time` — the same contract the live host provides.
 * Assistant frames are synthesized from each `assistant/message` record's
 * `time0` + cumulative `dt`, which is exactly what `agent/assistant-stream`
 * delivered live.
 */
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'dsh-replay-'));
process.env.DSH_HOME = home;

/* ---- fake clock: the plugin's only time source --------------------- */
let clock = 0;
const realNow = Date.now;
Date.now = () => clock;

const mod = await import(new URL('../index.js', import.meta.url).href);
const { apply, ROUTE } = mod;

const handlers = new Map();
const effects = [];
const routes = [];
const ctx = {
  logger: { warn: () => {} },
  on: (e, fn) => { handlers.set(e, fn); return () => handlers.delete(e); },
  effect: (fn) => { effects.push(fn()); return () => {}; },
  webServer: { register: (r) => { routes.push(r); return () => {}; } },
  connection: { requestRejection: () => undefined },
};
apply(ctx);

const events = (await readFile(join(HERE, '_real-session.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (events.length < 500) throw new Error('fixture too small: ' + events.length);

const session = { id: 'session-replay', header: {} };
const emit = (name, ...args) => {
  const fn = handlers.get(name);
  if (!fn) throw new Error('no handler for ' + name);
  fn(...args);
};

/* ---- synthesize the live stream frames from stored records --------- */
const CHUNK_OF = {
  'text-chunks': 'text-delta',
  'reasoning-chunks': 'reasoning-delta',
  'tool-call-chunks': 'tool-call-delta',
};
function framesOf(rec) {
  if (rec.type === 'chunk') return [{ time: rec.time, chunk: rec.chunk }];
  const kind = CHUNK_OF[rec.type];
  if (!kind) return [];
  const out = [];
  let t = rec.time0;
  for (let i = 0; i < (rec.dt?.length ?? 0); i += 1) {
    t += rec.dt[i] || 0;
    out.push({ time: t, chunk: { type: kind, index: rec.index, text: '', argumentsDelta: '' } });
  }
  return out;
}

const turnStarts = new Map(); // turn -> timestamp
const turnEnds = new Map();   // turn -> {at, reason}
const toolsByTurn = new Map(); // turn -> number of tool/call events in the log
let applied = 0;

for (const ev of events) {
  clock = ev.time;
  if (ev.type === 'turn/start') turnStarts.set(ev.data.turn, ev.time);
  if (ev.type === 'turn/end') turnEnds.set(ev.data.turn, { at: ev.time, reason: ev.data.reason });
  if (ev.type === 'tool/call') toolsByTurn.set(ev.data.turn, (toolsByTurn.get(ev.data.turn) || 0) + 1);

  if (ev.type === 'assistant/message') {
    // Stream chunks carry their own `time`, which is EARLIER than the commit
    // time of the message that stores them (the model streamed first, the log
    // record was appended after). The plugin reads `frame.time`, not Date.now,
    // so deliver them at their true timestamps and only advance the clock
    // afterwards — that is exactly what the live `agent/assistant-stream` feed
    // did. Dropping "past" frames here would silently erase every first token.
    const frames = (ev.data.stream || []).flatMap(framesOf).sort((a, b) => a.time - b.time);
    for (const f of frames) {
      emit('agent/assistant-stream', { agent: session, frame: { type: 'chunk', chunk: f.chunk, time: f.time } });
      applied += 1;
    }
    clock = ev.time;
  }
  emit('session/event', session, ev);
}
console.log('replayed events =', events.length, '| synthesized frames =', applied);

/* ---- read the snapshot through the real route handler -------------- */
clock = events[events.length - 1].time;
let body = null;
const res = {
  writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
  end(t) { body = JSON.parse(t); },
};
routes[0].handler({ method: 'GET', headers: {} }, res);
const snap = body.value;

await new Promise((r) => { const d = setTimeout(r, 1400); effects.push(() => clearTimeout(d)); });
const diskPath = join(home, 'storages', 'dsh-reply-timer', 'samples.json');
if (!existsSync(diskPath)) throw new Error('no samples.json at ' + diskPath);
const disk = JSON.parse(await readFile(diskPath, 'utf8'));

/* ---- assertions ---------------------------------------------------- */
const ledgers = Object.values(disk.turnLedgers['session-replay'] || {});
console.log('persisted turn ledgers =', ledgers.length);

let failures = 0;
const fail = (msg) => { failures += 1; console.log('  FAIL', msg); };

for (const [turn, startAt] of turnStarts) {
  const end = turnEnds.get(turn);
  const led = ledgers.find((l) => l.turn === turn);
  if (!end) {
    console.log(`  turn ${turn}: still running at log end (no turn/end) — no ledger expected`);
    if (led) fail(`turn ${turn} produced a ledger for a turn that never ended`);
    continue;
  }
  if (!led) { fail(`turn ${turn} ${end.reason.kind}: no ledger written`); continue; }
  const real = end.at - startAt;
  console.log(
    `  turn ${turn} ${end.reason.kind}: real ${real}ms | ledger ${led.totalMs}ms ` +
    `(ttft ${led.ttftMs} tool ${led.toolMs} gen ${led.genMs} tools ${led.toolCount}) reason=${led.endedReason}`,
  );
  if (led.endedReason !== end.reason.kind) fail(`turn ${turn} reason ${led.endedReason} != ${end.reason.kind}`);
  // The whole point of the bug: a seconds-long turn must not collapse to a
  // 2-digit millisecond figure.
  if (Math.abs(led.totalMs - real) > 1500) fail(`turn ${turn} duration ${led.totalMs} vs real ${real}`);
  if (led.totalMs < 1000 && real >= 1000) fail(`turn ${turn} collapsed to ${led.totalMs}ms`);
  const seg = (led.ttftMs || 0) + led.toolMs + led.genMs;
  if (Math.abs(seg - led.totalMs) > 2) fail(`turn ${turn} ledger does not partition: ${seg} vs ${led.totalMs}`);
  const realTools = toolsByTurn.get(turn) || 0;
  if (led.toolCount !== realTools) fail(`turn ${turn} toolCount ${led.toolCount} != ${realTools} tool/call events`);
  // First token: turns 1-2 streamed through this plugin's whole life, so a null
  // ttft there means frames were lost.
  if (turn <= 2 && led.ttftMs === null) fail(`turn ${turn} lost every stream frame (ttft is null)`);
}

const ledgerCount = Object.values(disk.turnLedgers || {}).reduce((n, m) => n + Object.keys(m).length, 0);
console.log('turn ledgers =', ledgerCount);
if (ledgerCount === 0) fail('no turn ledgers were recorded (the v2.1.0 symptom)');
if (disk.lastDone['session-replay'] === undefined) fail('lastDone missing');

// A completed turn must be the one that lands in lastDone at the end of the log.
const finalTurn = Math.max(...turnStarts.keys());
if (turnEnds.has(finalTurn)) console.log('final turn =', finalTurn, 'ended', turnEnds.get(finalTurn).reason.kind);

for (const d of effects) { try { if (typeof d === 'function') d(); } catch { /* ignore */ } }
Date.now = realNow;
await rm(home, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nOK: real-session replay — every completed turn kept its true duration and entered turnLedgers');
