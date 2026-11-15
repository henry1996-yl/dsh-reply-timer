/**
 * dsh-reply-timer — Host half (v2 「自适应版」).
 *
 * The minimal v1 lived entirely in the Client and watched the `sessions` list's
 * `running` bit. That could show elapsed time, but three things were NOT true:
 *   - the pulsing dot proved only that browser JS was alive, not that the model
 *     was streaming ("心跳说明没卡住" was a lie during a real backend stall);
 *   - stage / tool counts were guessed from list-row fields that don't carry
 *     them, so "正在生成 · 工具 2 次" essentially never appeared;
 *   - there was no historical reference for "预计还要多久".
 *
 * v2 moves the truth to the Host, where the events actually are:
 *   - `session/event` carries `turn/start`, `step/start`, `tool/call`,
 *     `tool/result`, `step/end`, `turn/end`, `approval/asked`, `user/message`
 *     (durable SessionEvent log types, proven by dsh-better-sidebar's event
 *     folding and dsh-notify-me's host-fallback). NOTE: `turn/start`/`turn/end`
 *     are NOT Host Events — they arrive only through this one feed.
 *   - `agent/assistant-stream` carries `frame.type: start|chunk|end` plus
 *     `payload.agent.session.id` (proven by dsh-better-sidebar:8178-8240).
 *     A `chunk` frame's inner `frame.chunk.type` is one of `block-start`,
 *     `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`,
 *     `finish`; `frame.time` is a Date.now() ms timestamp.
 *   - `api-session/status(sid, running)` is a fallback edge for turns that
 *     begin before this plugin is loaded.
 *
 * From those we compute, per session, with the Host's own Date.now():
 * elapsed, real tool count, real tool time, time-to-first-token, an HONEST
 * "last activity" timestamp (the heartbeat is derived from it, not from a
 * blind local interval), a suspected-stall flag, and a three-segment ledger
 * (首字 / 工具 / 生成) that partitions the wall time exactly. Tool intervals
 * are UNIONED (not summed), so parallel subagent / workflow / tool executions
 * do not inflate the 工具 number — that is the parallel-accounting behaviour.
 *
 * Completed turns are folded into small per-bucket history samples persisted
 * to `samples.json` next to this file, so the reference range survives a
 * browser refresh AND an app restart. `lastDone` keeps each session's most
 * recent ledger, so the 账本 also survives a refresh.
 *
 * The Client reads a snapshot through ONE read-only same-origin route,
 * `/reply-timer/state`, fenced by `ctx.connection.requestRejection` exactly as
 * dsh-better-sidebar fences `/sidebar/api` (lib/index.js:10054, 10167-10227).
 * The Client resolves the URL against `document.baseURI` (prefix-safe, works in
 * the Electron `dsh-app://app/` shell) — see client.js.
 *
 * No new session event types, no sessionProjections, no tools, no config schema.
 * Everything is registered inside `apply` via `ctx.effect` and returns its own
 * disposer, per dsh-doc practices.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES_FILE = join(HERE, 'samples.json');

export const ROUTE = '/reply-timer/state';
export const name = 'dsh-reply-timer';
export const inject = ['webServer', 'connection'];

/** No host activity for this long while running => suspected stall. */
const STALL_MS = 20000;
/** Force-close a running turn this long after its last activity (no turn/end). */
const WATCHDOG_MS = 120000;
/** Don't show a reference range until we have this many samples in a bucket. */
const MIN_SAMPLES = 5;
/** Keep only the most recent N durations per bucket. */
const MAX_SAMPLES = 20;
/** Bound the in-memory session table and the persisted lastDone map. */
const SESSION_CAP = 64;
/** Ignore absurd durations (a turn left running across a long suspend). */
const MAX_TURN_MS = 30 * 60 * 1000;
/** Visible model output chunk kinds (exclude usage / finish / block-end). */
const OUTPUT_CHUNKS = new Set(['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta']);

/* ------------------------------------------------------------------ *
 * Module state. `apply` resets the live table on (re)mount; listeners are
 * disposed by the effect cleanup so HMR cannot leak subscriptions.
 * ------------------------------------------------------------------ */
let states = new Map();
let persisted = { samples: {}, lastDone: {}, turnLedgers: {} };
let loaded = Promise.resolve();
let saveTimer = null;

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */
function sessionIdOf(session) {
  const id = session?.id ?? session?.header?.id;
  return typeof id === 'string' && id.length > 0 ? id : '';
}
function streamSessionId(payload) {
  const a = payload?.agent;
  const id = a?.session?.id ?? a?.id ?? a?.sessionId ?? a?.session?.header?.id ?? payload?.session?.id;
  return typeof id === 'string' && id.length > 0 ? id : '';
}
function isSubagent(session) {
  return session?.header?.origin === 'subagent' || session?.origin === 'subagent';
}
function reasonOf(event) {
  const r = event?.data?.reason;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && typeof r.kind === 'string') return r.kind;
  return '';
}
function callIdOf(event) {
  const d = event?.data;
  // `tool/call` carries data.callId; a `tool/result` cites it on the RESULT
  // MESSAGE at data.message.source.callId (proven by dsh-better-sidebar:5843-5846).
  const id =
    d?.callId ?? d?.id ?? d?.toolCallId ?? d?.message?.source?.callId;
  return typeof id === 'string' && id.length > 0 ? id : 'seq:' + String(event?.seq ?? Math.random());
}
function toolNameOf(event) {
  const d = event?.data;
  for (const k of ['toolName', 'name', 'tool', 'function']) {
    if (typeof d?.[k] === 'string' && d[k].length > 0) return d[k];
  }
  return '';
}
function bucketOf(toolCount) {
  return toolCount === 0 ? 'plain' : toolCount <= 2 ? 'few' : 'many';
}
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
function mergedIntervals(list) {
  const sorted = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else out.push([s, e]);
  }
  return out;
}
function sumIntervals(list) {
  let total = 0;
  for (const [s, e] of list) total += e - s;
  return total;
}
function clipIntervals(list, t0, t1) {
  return mergedIntervals(
    list.map(([s, e]) => [Math.max(s, t0), Math.min(e, t1)]).filter(([s, e]) => e > s),
  );
}
/** `frame.time` is a Date.now() ms stamp; fall back to our own clock. */
function frameTime(frame, fallback) {
  const t = frame?.time;
  return typeof t === 'number' && Number.isFinite(t) && t > 1e12 ? t : fallback;
}

/* ------------------------------------------------------------------ *
 * Per-session state
 * ------------------------------------------------------------------ */
function blank(sid) {
  return {
    sid,
    phase: 'idle',
    startedAt: 0,
    endedAt: 0,
    firstFrameAt: 0,
    lastFrameAt: 0,
    lastActivityAt: 0,
    toolCount: 0,
    openTools: new Map(),      // callId -> { startedAt, name }
    toolIntervals: [],         // [start, end]
    currentTool: '',
    stage: 'thinking',
    pending: false,
    pendingSince: 0,
    pausedMs: 0,
    turn: null,                // turn number from `turn/start` (for turnTail)
    sawTurnStart: false,       // authoritative `turn/start` seen
    sawToolEvent: false,       // `tool/call` seen on session/event
    sawToolCallDelta: false,   // a `tool-call-delta` stream chunk seen
    startedMidTurn: false,     // plugin loaded (or turn began) after the real start
    endedReason: '',
    totalMs: 0,
    ttftMs: null,              // null = 没有观测到首字，不编数字
    toolMs: 0,
    toolRealMs: 0,
    genMs: 0,
  };
}
/**
 * Three-segment ledger. The partition is exact:
 *   首字 = non-tool time before the first streamed token
 *   工具 = all tool time + time spent waiting for the user's confirmation
 *   生成 = non-tool time after the first token, minus that waiting time
 * so (首字 + 工具 + 生成) == wall time (when a first token was observed).
 * When no frame was ever seen, 首字 is left null and 生成 is the residual —
 * we never invent a first-token number we did not measure.
 */
function computeLedger(st) {
  const t0 = st.startedAt;
  const tN = st.endedAt;
  const total = Math.max(0, tN - t0);
  const union = clipIntervals(st.toolIntervals, t0, tN);
  const toolReal = sumIntervals(union);
  const paused = Math.max(0, st.pausedMs);
  const hasFrame = st.firstFrameAt > 0;

  let ttftMs = null;
  let genMs;
  if (hasFrame) {
    const ff = Math.min(Math.max(st.firstFrameAt, t0), tN);
    const preTool = sumIntervals(clipIntervals(union, t0, ff));
    ttftMs = Math.max(0, ff - t0 - preTool);
    genMs = Math.max(0, tN - ff - (toolReal - preTool));
  } else {
    genMs = Math.max(0, total - toolReal);
  }
  // Approval waiting is folded into the 工具/等待 bucket so the three numbers
  // still add up; it is also reported separately as pausedMs for the UI.
  const toolMs = toolReal + paused;
  genMs = Math.max(0, genMs - paused);

  st.totalMs = total;
  st.ttftMs = ttftMs;
  st.toolMs = toolMs;
  st.toolRealMs = toolReal;
  st.genMs = genMs;
}
function closeOpenTools(st, now) {
  for (const [, info] of st.openTools) st.toolIntervals.push([info.startedAt, now]);
  st.openTools.clear();
  st.currentTool = '';
}

/* ------------------------------------------------------------------ *
 * Persistence (survives browser refresh AND app restart)
 * ------------------------------------------------------------------ */
function loadPersisted() {
  return readFile(SAMPLES_FILE, 'utf8')
    .then((text) => {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          persisted = {
            samples: parsed.samples && typeof parsed.samples === 'object' ? parsed.samples : {},
            lastDone: parsed.lastDone && typeof parsed.lastDone === 'object' ? parsed.lastDone : {},
            turnLedgers:
              parsed.turnLedgers && typeof parsed.turnLedgers === 'object' ? parsed.turnLedgers : {},
          };
        }
      } catch {
        /* corrupt file: start fresh rather than crash the host */
      }
    })
    .catch(() => {});
}
function scheduleSave() {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void loaded.then(() =>
      writeFile(SAMPLES_FILE, JSON.stringify(persisted), 'utf8').catch(() => {}),
    );
  }, 800);
}
function recordSample(st) {
  if (!(st.totalMs > 0) || st.totalMs > MAX_TURN_MS) return;
  // Only fully-observed, normally-completed turns become history samples.
  if (st.startedMidTurn) return;
  if (st.endedReason !== '' && st.endedReason !== 'completed') return;
  // If a provider streamed tool-call deltas but never emitted `tool/call` /
  // `tool/result` session events, our tool bookkeeping is incomplete: bucketing
  // this turn would pollute a history bucket with a wrong tool count. Skip it.
  if (st.sawToolCallDelta && !st.sawToolEvent) return;
  const bucket = bucketOf(st.toolCount);
  const arr = persisted.samples[bucket] || (persisted.samples[bucket] = []);
  arr.push(Math.round(st.totalMs));
  if (arr.length > MAX_SAMPLES) arr.shift();
  scheduleSave();
}
function persistDone(st) {
  persisted.lastDone[st.sid] = {
    totalMs: st.totalMs,
    ttftMs: st.ttftMs,
    toolMs: st.toolMs,
    toolRealMs: st.toolRealMs,
    genMs: st.genMs,
    toolCount: st.toolCount,
    pausedMs: st.pausedMs,
    endedReason: st.endedReason,
    endedAt: st.endedAt,
    startedMidTurn: st.startedMidTurn,
  };
  const keys = Object.keys(persisted.lastDone);
  if (keys.length > SESSION_CAP) delete persisted.lastDone[keys[0]];
  // A per-turn ledger lets the Client attach the 账本 to that turn's tail even
  // after a refresh. Keyed by `sid:turn` (or `sid:endedAt` when the turn number
  // was not observed), capped per session.
  if (!st.startedMidTurn && st.totalMs > 0 && st.totalMs <= MAX_TURN_MS) {
    const key = st.sid + ':' + (st.turn != null ? 't' + st.turn : 'e' + st.endedAt);
    const ledgers = persisted.turnLedgers[st.sid] || (persisted.turnLedgers[st.sid] = {});
    ledgers[key] = {
      turn: st.turn,
      endedAt: st.endedAt,
      totalMs: st.totalMs,
      ttftMs: st.ttftMs,
      toolMs: st.toolMs,
      toolRealMs: st.toolRealMs,
      genMs: st.genMs,
      toolCount: st.toolCount,
      pausedMs: st.pausedMs,
      endedReason: st.endedReason,
    };
    const lk = Object.keys(ledgers);
    if (lk.length > 12) delete ledgers[lk[0]];
    const sk = Object.keys(persisted.turnLedgers);
    if (sk.length > SESSION_CAP) delete persisted.turnLedgers[sk[0]];
  }
  scheduleSave();
}
function historyOf(bucket) {
  const arr = (persisted.samples?.[bucket] || [])
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice()
    .sort((a, b) => a - b);
  const n = arr.length;
  if (n < MIN_SAMPLES) return { n, ready: false };
  const at = (q) => arr[Math.min(n - 1, Math.max(0, Math.floor((n - 1) * q)))];
  return { n, ready: true, lo: at(0.2), median: at(0.5), hi: at(0.8) };
}

/* ------------------------------------------------------------------ *
 * Event handlers
 * ------------------------------------------------------------------ */
function beginTurn(sid, now, midTurn) {
  if (!states.has(sid) && states.size >= SESSION_CAP) {
    const oldest = states.keys().next().value;
    if (oldest !== undefined) states.delete(oldest);
  }
  const fresh = blank(sid);
  fresh.phase = 'running';
  fresh.startedAt = now;
  fresh.lastActivityAt = now;
  fresh.stage = 'thinking';
  fresh.startedMidTurn = midTurn === true;
  states.set(sid, fresh);
  return fresh;
}
function endTurn(st, now, reason) {
  if (st.phase !== 'running') return;
  if (st.pending) {
    st.pausedMs += Math.max(0, now - st.pendingSince);
    st.pending = false;
  }
  closeOpenTools(st, now);
  st.phase = 'done';
  st.endedAt = now;
  st.endedReason = reason || 'completed';
  st.lastActivityAt = now;
  computeLedger(st);
  recordSample(st);
  persistDone(st);
}
function clearPending(st, now) {
  if (!st.pending) return;
  st.pausedMs += Math.max(0, now - st.pendingSince);
  st.pending = false;
  st.pendingSince = 0;
}
function handleSessionEvent(session, event) {
  const sid = sessionIdOf(session);
  if (sid === '' || isSubagent(session)) return;
  const type = event?.type;
  if (typeof type !== 'string') return;
  const now = Date.now();

  // `turn/start` is authoritative and MUST be handled before the
  // `phase !== 'running'` guard below, otherwise it can never begin a turn.
  if (type === 'turn/start') {
    const existing = states.get(sid);
    if (existing === undefined || existing.phase !== 'running' || !existing.sawTurnStart) {
      // Frames or `api-session/status` may have opened a provisional turn.
      // `turn/start` is the authoritative boundary, so (re)start from here and
      // drop the "joined mid-turn" flag — this turn's samples are trustworthy.
      beginTurn(sid, now, false);
    }
    const cur = states.get(sid);
    const turnNo = event?.data?.turn;
    cur.turn = Number.isFinite(turnNo) ? turnNo : null;
    cur.sawTurnStart = true;
    cur.lastActivityAt = now;
    return;
  }

  // IMPORTANT: do NOT mint a state for sessions that are not in a turn. A chat
  // node / user message event on an idle session must never create a blank
  // `phase:'idle'` row, or the Client would render a fake "本轮 0.0s".
  // Some providers never emit `turn/start`; a tool/call, step/start or
  // assistant/message while idle means we joined a turn already in progress.
  let cur = states.get(sid);
  if (
    (cur === undefined || cur.phase !== 'running') &&
    (type === 'tool/call' || type === 'step/start' || type === 'assistant/message')
  ) {
    cur = beginTurn(sid, now, true);
  }
  if (cur === undefined || cur.phase !== 'running') return;
  cur.lastActivityAt = now;

  // Any real progress ends an approval wait.
  if (cur.pending && type !== 'approval/asked') clearPending(cur, now);

  switch (type) {
    case 'turn/end':
      endTurn(cur, now, reasonOf(event));
      break;
    case 'tool/call': {
      const id = callIdOf(event);
      const name = toolNameOf(event);
      cur.toolCount += 1;
      cur.sawToolEvent = true;
      cur.openTools.set(id, { startedAt: now, name });
      cur.currentTool = name;
      cur.stage = 'tool';
      break;
    }
    case 'tool/result': {
      const id = callIdOf(event);
      let info = cur.openTools.get(id);
      // Some providers put the callId on the result MESSAGE, not on data.
      if (info === undefined && cur.openTools.size === 1) {
        info = cur.openTools.values().next().value;
      }
      // With several open tools, an unknown callId would mis-attribute the
      // interval, so skip that result rather than invent a pairing.
      if (info === undefined) break;
      const startedAt = info.startedAt;
      cur.toolIntervals.push([startedAt, now]);
      for (const [key, value] of cur.openTools) {
        if (value === info) { cur.openTools.delete(key); break; }
      }
      if (cur.openTools.size === 0) {
        cur.currentTool = '';
        cur.stage = cur.firstFrameAt > 0 ? 'generating' : 'thinking';
      } else {
        cur.currentTool = cur.openTools.values().next().value?.name || '';
      }
      break;
    }
    case 'step/start':
      if (cur.openTools.size === 0) cur.stage = cur.firstFrameAt > 0 ? 'generating' : 'thinking';
      break;
    case 'approval/asked':
      if (!cur.pending) {
        cur.pending = true;
        cur.pendingSince = now;
        cur.stage = 'paused';
      }
      break;
    case 'user/message':
      // A real user interjection closes the turn we were watching.
      if (event?.data?.source?.kind === 'user') endTurn(cur, now, 'interrupted');
      break;
    default:
      break;
  }
}
function handleStream(payload) {
  const sid = streamSessionId(payload);
  if (sid === '') return;
  const frame = payload?.frame;
  const type = frame?.type;
  if (type !== 'start' && type !== 'chunk' && type !== 'end') return;
  const now = Date.now();
  let st = states.get(sid);
  if (st === undefined || st.phase !== 'running') {
    // Frames can arrive before `turn/start` (or before this plugin mounted).
    st = beginTurn(sid, now, true);
  }
  const at = frameTime(frame, now);
  st.lastActivityAt = at;
  if (type !== 'chunk') return;  // 'start' is only the opening marker
  st.lastFrameAt = at;
  const chunkType = frame?.chunk?.type;
  if (chunkType === 'tool-call-delta') st.sawToolCallDelta = true;
  // A tool-call-delta marks the start of a tool invocation; visible prose /
  // reasoning is the "first token". Count both as real output activity.
  if (OUTPUT_CHUNKS.has(chunkType) && st.firstFrameAt === 0) st.firstFrameAt = at;
  clearPending(st, at);
  if (st.openTools.size === 0) st.stage = 'generating';
}
function handleStatus(sid, running) {
  if (typeof sid !== 'string' || sid === '') return;
  const now = Date.now();
  const st = states.get(sid);
  if (running === true) {
    // Only a real transition opens a fallback turn; repeated status(true)
    // broadcasts are NOT activity and must not mask a genuine stall.
    if (st === undefined || st.phase !== 'running') beginTurn(sid, now, true);
  } else if (
    running === false &&
    st?.phase === 'running' &&
    !st.sawTurnStart &&
    now - st.startedAt > 1000
  ) {
    // Only the fallback path trusts status(false); an authoritative turn has
    // its own `turn/end`. The 1s guard ignores a spurious immediate `false`.
    endTurn(st, now, 'completed');
  }
}
/** Safety net: a turn with no activity at all for WATCHDOG_MS is over. */
function watchdog() {
  const now = Date.now();
  for (const [, st] of states) {
    if (st.phase === 'running' && now - st.lastActivityAt > WATCHDOG_MS) {
      endTurn(st, now, 'interrupted');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Snapshot exposed to the Client
 * ------------------------------------------------------------------ */
function publicState(st, now) {
  const running = st.phase === 'running';
  const extraPaused = st.pending ? Math.max(0, now - st.pendingSince) : 0;
  const elapsedMs = running
    ? Math.max(0, now - st.startedAt - st.pausedMs - extraPaused)
    : st.totalMs;
  const idleMs = running ? Math.max(0, now - st.lastActivityAt) : 0;
  return {
    sid: st.sid,
    phase: st.phase,
    startedAt: st.startedAt,
    endedAt: st.endedAt,
    elapsedMs,
    totalMs: st.totalMs,
    ttftMs: st.ttftMs,
    toolMs: st.toolMs,
    toolRealMs: st.toolRealMs,
    genMs: st.genMs,
    pausedMs: st.pausedMs,
    toolCount: st.toolCount,
    openTools: st.openTools.size,
    currentTool: st.currentTool,
    stage: st.stage,
    pending: st.pending,
    firstFrameAt: st.firstFrameAt,
    lastActivityAt: st.lastActivityAt,
    idleMs,
    // A tool is legitimately allowed to run a long time without emitting
    // frames; only flag a suspected stall when no tool is open.
    stalled: running && st.openTools.size === 0 && idleMs > STALL_MS,
    startedMidTurn: st.startedMidTurn,
    endedReason: st.endedReason,
  };
}
function snapshot() {
  watchdog();
  const now = Date.now();
  const sessions = {};
  for (const [sid, st] of states) sessions[sid] = publicState(st, now);
  return {
    serverNow: now,
    stallMs: STALL_MS,
    minSamples: MIN_SAMPLES,
    sessions,
    lastDone: persisted.lastDone || {},
    turnLedgers: persisted.turnLedgers || {},
    history: {
      plain: historyOf('plain'),
      few: historyOf('few'),
      many: historyOf('many'),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */
export function apply(ctx) {
  states = new Map();
  loaded = loadPersisted();

  // Event feed: global events need no injected service, so start collecting
  // immediately even if the web server is not ready yet.
  ctx.effect(() => {
    const offs = [];
    const on = (eventName, fn) => {
      try {
        const off = ctx.on(eventName, fn);
        if (typeof off === 'function') offs.push(off);
      } catch (error) {
        ctx.logger?.warn?.(
          `dsh-reply-timer: cannot subscribe ${eventName}: ${String(error?.message ?? error)}`,
        );
      }
    };
    const safe = (fn) => (...args) => {
      try {
        fn(...args);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-reply-timer: event handler failed: ${String(error?.message ?? error)}`);
      }
    };
    on('session/event', safe(handleSessionEvent));
    on('agent/assistant-stream', safe(handleStream));
    on('api-session/status', safe(handleStatus));
    on('session/disposed', safe((session) => {
      const sid = sessionIdOf(session);
      if (sid !== '') states.delete(sid);
    }));
    const watchdogTimer = setInterval(watchdog, 30000);
    return () => {
      clearInterval(watchdogTimer);
      for (const off of offs) {
        try { off(); } catch { /* ignore */ }
      }
    };
  }, 'dsh-reply-timer: host event feed');

  // Read-only same-origin endpoint. `connection.requestRejection` is the same
  // admission gate dsh-better-sidebar uses; the GUI page is already trusted.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => {
          try {
            const rejection = ctx.connection?.requestRejection?.(req);
            if (rejection !== undefined && rejection !== null) {
              writeJson(res, 403, { ok: false, error: 'forbidden' });
              return;
            }
            if (req.method !== 'GET') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }
            writeJson(res, 200, { ok: true, value: snapshot() });
          } catch (error) {
            try {
              writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
            } catch { /* headers already sent */ }
          }
        },
      }),
    'dsh-reply-timer: /reply-timer/state route',
  );

  return () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  };
}
