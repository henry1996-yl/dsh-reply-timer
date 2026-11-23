/**
 * dsh-reply-timer — Client half (v2 「自适应版」).
 *
 * v1 computed everything in the browser from the `sessions` list `running` bit.
 * That showed elapsed time but its "心跳说明没卡住" was false (the pulse only
 * proved browser JS was alive) and its stage / tool counts were guesses.
 *
 * v2 is a thin, honest renderer over the Host's `/reply-timer/state` snapshot:
 *   - the Host's `lastActivityAt` (fed by real `agent/assistant-stream` frames
 *     and `session/event` log entries) drives the heartbeat, so a genuine
 *     backend stall is reported as 疑似停滞 instead of "没卡住";
 *   - stage, tool count and the 首字/工具/生成 ledger come from the Host's
 *     measured values, never from list-row guesses;
 *   - the done ledger survives a browser refresh AND an app restart because the
 *     Host persists it to samples.json.
 *
 * Transport: same-origin relative GET against `document.baseURI`, exactly the
 * pattern dsh-notify-me / dsh-better-sidebar use for their plugin routes. In
 * the Electron `dsh-app://app/` shell the desktop forwards non-static paths to
 * the Host with the session cookie attached; no token handling needed here.
 *
 * Everything is registered inside `apply` via `ctx.effect` and disposed on
 * cleanup (HMR-safe). No CSS injection, no iframe, no harness UI primitives —
 * only `react` from the browser module table and inline styles using theme
 * tokens (`--dsw-alias-*`) with fallbacks.
 */
window.__ModuleLoader__.load({
  id: 'dsh-reply-timer',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = null;
    try { React = require('react') || null; } catch (e) { React = null; }
    var h = React ? React.createElement : null;
    var useState = React && React.useState;
    var useEffect = React && React.useEffect;
    var useRef = React && React.useRef;
    var useSyncExternalStore = React && React.useSyncExternalStore;

    var ID = 'dsh-reply-timer';
    var NS = 'dsh-reply-timer';
    var SLOT = 'conversation.composer.dock';
    var ROUTE = '__dsh-reply-timer/state';
    var PREF_KEY = 'dsh-reply-timer:prefs';

    var reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------------------------------------------------------------- *
     * Locale dictionaries (zh primary, en fallback).
     * ---------------------------------------------------------------- */
    var ZH = {
      idle: '计时器 · 等待新一轮',
      thinking: '正在思考',
      generating: '正在生成',
      tool: '正在跑工具',
      paused: '等待确认',
      pending: '⏸ 等待你确认 · 计时已暂停',
      heartbeat: '模型仍在输出',
      lastActivity: '最后活动 {s} 前',
      stalled: '⚠ {s} 没有新输出 · 可能停滞',
      tools: '工具 {n} 次',
      donePrefix: '本轮',
      midTurn: '观测（中途接入）',
      endedInterrupted: '（已中断）',
      endedAborted: '（已中止）',
      endedError: '（出错）',
      total: '总耗时',
      firstToken: '首字',
      firstTokenMissing: '首字未观测到',
      toolTime: '工具耗时',
      genTime: '生成耗时',
      toolCount: '工具次数',
      pausedTime: '其中等待确认',
      toggleOn: '显示计时器',
      toggleOff: '计时器已关闭 · 点击开启',
      turnOffTimer: '关闭计时器',
      outsideHint: '点击插件外部或按 Esc 收起明细',
      expand: '点击展开明细',
      collapse: '点击收起',
      noData: '计时器待命',
    };
    var EN = {
      idle: 'Timer · waiting for a turn',
      thinking: 'Thinking',
      generating: 'Generating',
      tool: 'Running a tool',
      paused: 'Awaiting confirmation',
      pending: '⏸ Waiting for you · timer paused',
      heartbeat: 'Model is still streaming',
      lastActivity: 'last output {s} ago',
      stalled: '⚠ No output for {s} · may be stalled',
      tools: '{n} tools',
      donePrefix: 'Turn',
      midTurn: 'Observed (joined mid-turn)',
      endedInterrupted: '(interrupted)',
      endedAborted: '(aborted)',
      endedError: '(error)',
      total: 'Total',
      firstToken: 'First token',
      firstTokenMissing: 'First token not observed',
      toolTime: 'Tool time',
      genTime: 'Generation time',
      toolCount: 'Tool calls',
      pausedTime: 'of which waiting',
      toggleOn: 'Show timer',
      toggleOff: 'Timer off · click to enable',
      turnOffTimer: 'Turn off timer',
      outsideHint: 'Click outside the plugin or press Esc to close',
      expand: 'Click for details',
      collapse: 'Click to collapse',
      noData: 'Timer standby',
    };

    function fallbackDict(ctx) {
      var code = '';
      try {
        var snap = ctx && ctx.locale && ctx.locale.getSnapshot && ctx.locale.getSnapshot();
        code = (snap && (snap.locale || snap.lang || snap.code)) || '';
      } catch (e) {}
      if (!code) {
        try { code = ctx && ctx.locale && ctx.locale.getLocale && ctx.locale.getLocale(); } catch (e) {}
      }
      return typeof code === 'string' && code.toLowerCase().indexOf('zh') === 0 ? ZH : EN;
    }
    function makeT(ctx) {
      var dict = fallbackDict(ctx);
      return function (key, vars) {
        var str = dict[key] != null ? dict[key] : (ZH[key] != null ? ZH[key] : key);
        if (vars) {
          str = String(str).replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
          });
        }
        return str;
      };
    }

    /* ---------------------------------------------------------------- *
     * Formatting
     * ---------------------------------------------------------------- */
    function fmtMs(ms) {
      if (ms == null || !isFinite(ms) || ms < 0) ms = 0;
      var s = ms / 1000;
      if (s < 10) return (Math.round(s * 10) / 10).toFixed(1) + 's';
      if (s < 60) return Math.round(s) + 's';
      var m = Math.floor(s / 60);
      var r = Math.round(s % 60);
      return m + 'm' + (r < 10 ? '0' + r : r) + 's';
    }
    function fmtSecs(ms) {
      if (ms == null || !isFinite(ms) || ms < 0) ms = 0;
      var s = Math.round(ms / 1000);
      return s + 's';
    }

    /* ---------------------------------------------------------------- *
     * Preferences (persist across refresh; guarded — private mode etc.)
     * ---------------------------------------------------------------- */
    function readPrefs() {
      try {
        var raw = typeof window !== 'undefined' && window.localStorage
          ? window.localStorage.getItem(PREF_KEY) : null;
        if (raw) {
          var p = JSON.parse(raw);
          // Only the on/off setting is persisted. "expanded" is deliberately
          // NOT restored: a refresh must always start with a collapsed detail.
          if (p && typeof p === 'object') return { enabled: p.enabled !== false };
        }
      } catch (e) {}
      return { enabled: true };
    }
    function writePrefs(p) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(PREF_KEY, JSON.stringify({ enabled: p.enabled }));
        }
      } catch (e) {}
    }

    /* ---------------------------------------------------------------- *
     * External store: Host snapshot + local clock + UI prefs.
     * `getVersion()` is a number, so useSyncExternalStore's snapshot is
     * Object.is-stable and a bump always triggers exactly one re-render.
     * ---------------------------------------------------------------- */
    function createStore() {
      var listeners = [];
      var version = 0;
      var snap = null;
      var receiveAt = 0;
      var prefs = readPrefs();
      var currentSid = '';
      var lastSid = '';
      return {
        subscribe: function (cb) {
          listeners.push(cb);
          return function () {
            for (var i = 0; i < listeners.length; i++) {
              if (listeners[i] === cb) { listeners.splice(i, 1); break; }
            }
          };
        },
        getVersion: function () { return version; },
        bump: function () {
          version += 1;
          for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](); } catch (e) {}
          }
        },
        getSnap: function () { return snap; },
        setSnap: function (s) {
          snap = s;
          receiveAt = Date.now();
          if (s && s.sessions) {
            for (var sid in s.sessions) {
              if (s.sessions[sid] && s.sessions[sid].phase === 'running') lastSid = sid;
            }
          }
          this.bump();
        },
        getReceiveAt: function () { return receiveAt; },
        getCurrentSid: function () { return currentSid; },
        setCurrentSid: function (v) {
          if (typeof v === 'string' && v && v !== currentSid) { currentSid = v; this.bump(); }
        },
        getLastSid: function () { return lastSid; },
        // Only the on/off flag lives in the store (and in localStorage).
        // The detail's expanded/collapsed state is local React state in Widget,
        // so a refresh always starts collapsed and it never "sticks" open.
        getEnabled: function () { return prefs.enabled; },
        setEnabled: function (v) {
          prefs.enabled = !!v; writePrefs(prefs); this.bump();
        },
        hasRunning: function () {
          if (!snap || !snap.sessions) return false;
          for (var k in snap.sessions) {
            if (snap.sessions[k] && snap.sessions[k].phase === 'running') return true;
          }
          return false;
        },
      };
    }
    var store = createStore();

    /* ---------------------------------------------------------------- *
     * URL resolution — prefix-safe, like dsh-better-sidebar's hostRouteUrl.
     * document.baseURI carries the launch token / reverse-proxy prefix in the
     * Electron shell; force a trailing-slash directory base so a relative path
     * resolves correctly whether baseURI is "dsh-app://app/" or "/some/page".
     * ---------------------------------------------------------------- */
    function directoryBase(u) {
      var s = String(u || '').split('#')[0].split('?')[0];
      if (s.charAt(s.length - 1) !== '/') s = s.slice(0, s.lastIndexOf('/') + 1);
      return s;
    }
    function routeCandidates() {
      var out = [];
      // Root-absolute first: this is exactly dsh-notify-me's proven
      // `fetch("/__dsh-notify-me/...")` shape and matches the Host's registered
      // `/reply-timer/state` path directly on a normal http(s) Web GUI.
      out.push('/' + ROUTE);
      // Prefix-safe resolution against the page base (dsh-better-sidebar's
      // hostRouteUrl pattern) for reverse-proxied / Electron `dsh-app://app`
      // shells where a leading-slash path would land on the wrong prefix.
      try {
        var base = typeof document !== 'undefined' ? document.baseURI : '';
        if (base) {
          var resolved = new URL(ROUTE, directoryBase(base)).href;
          if (out.indexOf(resolved) < 0) out.push(resolved);
        }
      } catch (e) {}
      return out;
    }

    /* ---------------------------------------------------------------- *
     * Polling (Client -> Host, read-only GET).
     * ---------------------------------------------------------------- */
    function readEnvelope(text) {
      var data = JSON.parse(text);
      if (data && data.ok === true) return data.value;
      throw new Error('bad envelope');
    }
    function pollOnce() {
      var cands = routeCandidates();
      var i = 0;
      function attempt() {
        if (i >= cands.length) return Promise.resolve(null);
        var url = cands[i++];
        return fetch(url, {
          method: 'GET',
          cache: 'no-store',
          mode: 'same-origin',
          headers: { accept: 'application/json' },
        })
          .then(function (resp) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.text();
          })
          .then(readEnvelope)
          .then(function (value) { return value && value.sessions ? value : null; })
          .catch(function () { return attempt(); });
      }
      return attempt();
    }

    /* ---------------------------------------------------------------- *
     * Derive the view for the dock this widget belongs to.
     * Priority: slot props sessionId -> derived current session -> most recent.
     * A `live` state is `snap.sessions[sid]`; a `done` state may come from the
     * Host-persisted `snap.lastDone[sid]` (so the ledger survives refresh).
     * ---------------------------------------------------------------- */
    function sessionIdFromProps(p) {
      if (!p) return '';
      if (typeof p === 'string') return p;
      if (typeof p.sessionId === 'string' && p.sessionId) return p.sessionId;
      if (typeof p.sessionID === 'string' && p.sessionID) return p.sessionID;
      if (typeof p.id === 'string' && p.id) return p.id;
      if (p.session && typeof p.session.id === 'string') return p.session.id;
      if (p.conversation && typeof p.conversation.sessionId === 'string') return p.conversation.sessionId;
      return '';
    }
    /**
     * Fallback only. The authoritative session id comes from the slot's
     * session-scoped `inject` face (see the register() call in apply), which is
     * the documented contract for a scope:'session' slot. `ctx.sessions.list`
     * is NOT part of the Client `sessions` Service contract (retain / using /
     * retainInfo / refreshProjections / search / fork / scope / binding), so it
     * is probed defensively and never relied on for correctness.
     */
    function currentSessionId(ctx) {
      try {
        var list = ctx && ctx.sessions && ctx.sessions.list;
        if (list && typeof list.getSnapshot === 'function') {
          var st = list.getSnapshot();
          if (typeof st.current === 'string' && st.current) return st.current;
          var byId = st.byId || {};
          for (var id in byId) {
            var row = byId[id];
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
          }
        }
      } catch (e) {}
      return '';
    }
    function pickRaw(snap, preferredSid) {
      if (!snap) return null;
      var sessions = snap.sessions || {};
      var lastDone = snap.lastDone || {};
      // Once the slot tells us which session this dock belongs to, show ONLY
      // that session. Falling back to "some other running session" is what made
      // a multi-tab / multi-session GUI display a stranger's countdown, which is
      // worse than showing nothing.
      if (preferredSid) {
        var own = sessions[preferredSid];
        if (own && own.phase === 'running') return { raw: own, sid: preferredSid, live: true };
        if (own && own.phase === 'done' && (own.totalMs || 0) > 0) {
          return { raw: own, sid: preferredSid, live: true };
        }
        if (lastDone[preferredSid] && (lastDone[preferredSid].totalMs || 0) > 0) {
          return { raw: lastDone[preferredSid], sid: preferredSid, live: false };
        }
        return null;
      }
      var order = [];
      var cur = store.getCurrentSid();
      if (cur && order.indexOf(cur) < 0) order.push(cur);
      var last = store.getLastSid();
      if (last && order.indexOf(last) < 0) order.push(last);
      // A running session wins regardless of the dock we think we're in.
      for (var k in sessions) {
        if (sessions[k] && sessions[k].phase === 'running' && order.indexOf(k) < 0) order.push(k);
      }
      for (var j = 0; j < order.length; j++) {
        var sid = order[j];
        var s = sessions[sid];
        if (s && s.phase === 'running') return { raw: s, sid: sid, live: true };
        if (s && s.phase === 'done' && (s.totalMs || 0) > 0) return { raw: s, sid: sid, live: true };
      }
      for (var m = 0; m < order.length; m++) {
        var d = order[m];
        if (lastDone[d] && (lastDone[d].totalMs || 0) > 0) return { raw: lastDone[d], sid: d, live: false };
      }
      // Fall back to any single-session snapshot when we truly can't resolve.
      // Never surface an idle or zero-duration state (would render a fake chip).
      var sk = Object.keys(sessions);
      if (sk.length === 1) {
        var only = sessions[sk[0]];
        if (only && only.phase === 'running') return { raw: only, sid: sk[0], live: true };
        if (only && only.phase === 'done' && (only.totalMs || 0) > 0) return { raw: only, sid: sk[0], live: true };
      }
      var dk = Object.keys(lastDone);
      if (dk.length === 1 && (lastDone[dk[0]].totalMs || 0) > 0) {
        return { raw: lastDone[dk[0]], sid: dk[0], live: false };
      }
      return null;
    }
    function buildView(snap, preferredSid, t) {
      var picked = pickRaw(snap, preferredSid);
      if (!picked) return null;
      var raw = picked.raw;
      var sinceReceipt = Math.max(0, Date.now() - store.getReceiveAt());
      var running = picked.live && raw.phase === 'running';
      var v = {
        sid: picked.sid,
        phase: running ? 'running' : 'done',
        running: running,
        stage: raw.stage || 'thinking',
        toolCount: raw.toolCount || 0,
        currentTool: raw.currentTool || '',
        pending: !!raw.pending,
        startedMidTurn: !!raw.startedMidTurn,
        endedReason: raw.endedReason || '',
        totalMs: raw.totalMs || 0,
        ttftMs: raw.ttftMs == null ? null : raw.ttftMs,
        toolMs: raw.toolMs || 0,
        toolRealMs: raw.toolRealMs || 0,
        genMs: raw.genMs || 0,
        pausedMs: raw.pausedMs || 0,
        elapsedMs: 0,
        idleMs: 0,
        stalled: false,
      };
      if (running) {
        // The Host's elapsedMs already freezes during an approval wait; only
        // interpolate the local delta when the turn is actually progressing.
        v.elapsedMs = (raw.elapsedMs || 0) + (raw.pending ? 0 : sinceReceipt);
        v.idleMs = Math.max(0, (raw.idleMs || 0) + sinceReceipt);
        v.stalled =
          !!raw.stalled ||
          (raw.openTools === 0 && v.idleMs > (snap.stallMs || 60000));
      } else {
        v.elapsedMs = v.totalMs;
      }
      return v;
    }

    /* ---------------------------------------------------------------- *
     * Widget
     * ---------------------------------------------------------------- */
    // Color note: the whole widget now uses the theme PRIMARY text color
    // (near-black on a light theme, bright on a dark theme) instead of the
    // muted `text-secondary` gray. The old version stacked opacity 0.8/0.75/
    // 0.65 on top of that gray, which made the small text look washed out and
    // blurry. Hierarchy is now expressed with font-size / font-weight only --
    // never with transparency -- so every label stays at full contrast.
    var TEXT = 'var(--dsw-alias-text-primary, #1f1f1f)';
    var C = {
      wrap: {
        display: 'flex', flexDirection: 'column', gap: 4,
        padding: '4px 2px', fontSize: 12, lineHeight: 1.5,
        fontFamily: 'inherit',
        color: TEXT,
        fontWeight: 500,
        userSelect: 'none', cursor: 'pointer',
      },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 9px', borderRadius: 999,
        background: 'var(--dsw-alias-fill-tint, rgba(127,127,127,0.10))',
        width: 'fit-content', maxWidth: '100%',
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
      main: {
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        fontWeight: 700, color: TEXT,
      },
      sub: {
        fontSize: 11, paddingLeft: 16, color: TEXT,
      },
      detail: {
        marginTop: 2, padding: '8px 10px', borderRadius: 8,
        background: 'var(--dsw-alias-fill-tint, rgba(127,127,127,0.08))',
        display: 'flex', flexDirection: 'column', gap: 3,
        cursor: 'default', color: TEXT,
      },
      line: { display: 'flex', justifyContent: 'space-between', gap: 16 },
      lineKey: { fontWeight: 400, color: TEXT },
      lineVal: { fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: TEXT },
      hint: { fontSize: 11, paddingLeft: 16, color: TEXT },
      toggle: {
        marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 6,
        cursor: 'pointer', fontSize: 11, color: TEXT,
      },
      switch: {
        width: 26, height: 14, borderRadius: 999, position: 'relative',
        background: 'var(--dsw-alias-fill, rgba(127,127,127,0.3))', flex: '0 0 auto',
      },
      knob: {
        position: 'absolute', top: 2, width: 10, height: 10, borderRadius: '50%',
        background: TEXT, transition: 'left 120ms',
      },
    };
    function el(tag, props, kids) { return h(tag, props, kids); }

    function statusLine(v, t) {
      var parts = [];
      if (v.pending) {
        parts.push(t('pending'));
        return parts.join('');
      }
      if (v.running) {
        parts.push('⏳ ' + fmtMs(v.elapsedMs));
        parts.push(' · ' + t(v.stage === 'tool' ? 'tool' : v.stage === 'generating' ? 'generating' : v.stage === 'paused' ? 'paused' : 'thinking'));
        if (v.toolCount > 0) parts.push(' · ' + t('tools', { n: v.toolCount }));
      } else {
        var label = v.startedMidTurn ? t('midTurn') : t('donePrefix') + ' ' + fmtMs(v.totalMs);
        parts.push('✓ ' + label);
        var reason = v.endedReason;
        if (reason === 'interrupted') parts.push(t('endedInterrupted'));
        else if (reason === 'aborted') parts.push(t('endedAborted'));
        else if (reason === 'error' || reason === 'blocked' || reason === 'max-tokens') parts.push(t('endedError'));
      }
      return parts.join('');
    }
    function subLine(v, t) {
      if (!v.running) return '';
      if (v.stalled) return t('stalled', { s: fmtSecs(v.idleMs) });
      return t('heartbeat') + ' · ' + t('lastActivity', { s: fmtSecs(v.idleMs) });
    }
    function detailLines(v, t) {
      var lines = [];
      function add(k, val) {
        lines.push(el('div', { style: C.line, key: k }, [
          el('span', { style: C.lineKey, key: 'k' }, k),
          el('span', { style: C.lineVal, key: 'v' }, val),
        ]));
      }
      add(t('total'), fmtMs(v.running ? v.elapsedMs : v.totalMs));
      if (!v.running) {
        add(t('firstToken'), v.ttftMs == null ? t('firstTokenMissing') : fmtMs(v.ttftMs));
        add(t('toolTime'), fmtMs(v.toolMs));
        if (v.pausedMs > 0) add('  ' + t('pausedTime'), fmtMs(v.pausedMs));
        add(t('genTime'), fmtMs(v.genMs));
        add(t('toolCount'), String(v.toolCount));
      } else {
        add(t('toolCount'), String(v.toolCount) + (v.currentTool ? ' · ' + v.currentTool : ''));
      }
      return lines;
    }

    function Widget(props) {
      useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
      var t = props.t;
      // The dock is a session-scoped slot, so `sessionId` arrives through the
      // registration's `inject` face. ownerProps is kept as a last resort for
      // hosts that pass it through instead (it is [] on the current GUI).
      var preferredSid = sessionIdFromProps(props.sessionId) || sessionIdFromProps(props.ownerProps);
      var snap = store.getSnap();
      var enabled = store.getEnabled();
      var v = buildView(snap, preferredSid, t);

      // "expanded" is LOCAL, transient React state: it always starts collapsed
      // on mount/refresh and is never persisted. Closing by clicking outside
      // or pressing Esc is the expected popover behaviour (the old version
      // kept it in localStorage and could only be closed by re-clicking the
      // chip, which felt like it "wouldn't go away").
      var expandedPair = useState(false);
      var expanded = expandedPair[0];
      var setExpanded = expandedPair[1];
      var wrapRef = useRef(null);

      // Keep the derived current-session id fresh for multi-session docks.
      useEffect(function () {
        var sid = currentSessionId(props.ctx);
        if (sid) store.setCurrentSid(sid);
      });

      // While the detail is open, clicking OUTSIDE THE PLUGIN (anywhere else
      // on the page) or pressing Esc collapses it. A containment check on the
      // widget root is used instead of a full-screen overlay, so the rest of
      // the composer stays fully interactive. Deps are stable, so this is NOT
      // re-bound on the ~5 Hz clock ticks.
      useEffect(function () {
        if (!enabled || !expanded) return;
        function onOutside(e) {
          var node = wrapRef.current;
          var target = e.target;
          if (node && target && !node.contains(target)) setExpanded(false);
        }
        function onKey(e) {
          if (e.key === 'Escape' || e.key === 'Esc') setExpanded(false);
        }
        // window + capture: fires before any in-app handler can stop it, and
        // is the same target dsh-context uses for its outside-click dismiss.
        var win = typeof window !== 'undefined' ? window : null;
        if (!win) return;
        win.addEventListener('mousedown', onOutside, true);
        win.addEventListener('touchstart', onOutside, true);
        win.addEventListener('keydown', onKey, true);
        return function () {
          win.removeEventListener('mousedown', onOutside, true);
          win.removeEventListener('touchstart', onOutside, true);
          win.removeEventListener('keydown', onKey, true);
        };
      }, [enabled, expanded]);

      if (!enabled) {
        return el('div', { style: C.wrap, onClick: function () { store.setEnabled(true); }, title: t('toggleOff') },
          el('div', { style: C.chip }, t('toggleOff')));
      }

      var now = Date.now();
      var dotColor = v && v.stalled
        ? 'var(--dsw-alias-warning, #e0a848)'
        : v && !v.running
          ? 'var(--dsw-alias-success, #3aa675)'
          : 'var(--dsw-alias-brand, #4d8bff)';
      var dotOpacity = 1;
      if (v && v.running && !v.stalled) {
        dotOpacity = reduceMotion ? 0.9 : 0.35 + 0.65 * Math.abs(Math.sin(now / 450));
      }

      var main = v ? statusLine(v, t) : t('noData');
      var sub = v ? subLine(v, t) : '';

      var kids = [
        el('div', {
          style: C.chip,
          key: 'chip',
          onClick: function (e) { e.stopPropagation(); setExpanded(!expanded); },
          role: 'status',
          'aria-live': 'polite',
          title: expanded ? t('collapse') : t('expand'),
        }, [
          el('span', {
            style: Object.assign({}, C.dot, { background: dotColor, opacity: dotOpacity }),
            key: 'dot',
          }),
          el('span', { style: C.main, key: 'main' }, main),
        ]),
      ];
      if (sub) kids.push(el('div', { style: C.sub, key: 'sub' }, sub));
      if (expanded && v) {
        kids.push(el('div', { style: C.detail, key: 'detail' },
          detailLines(v, t).concat([
            el('div', { style: C.hint, key: 'outsideHint' }, t('outsideHint')),
            el('div', {
              style: C.toggle, key: 'toggle',
              onClick: function (e) { e.stopPropagation(); store.setEnabled(false); },
            }, [
              el('span', {
                style: Object.assign({}, C.switch, { background: 'var(--dsw-alias-brand, #4d8bff)' }),
                key: 'sw',
              }, el('span', { style: Object.assign({}, C.knob, { left: 14 }), key: 'knob' })),
              el('span', { key: 'lbl' }, t('turnOffTimer')),
            ]),
          ])));
      }

      return el('div', {
        ref: wrapRef,
        style: C.wrap,
        key: 'wrap',
      }, kids);
    }

    /* ---------------------------------------------------------------- *
     * Plugin entry
     * ---------------------------------------------------------------- */
    var inject = ['sessions', 'slots', 'locale'];

    function apply(ctx) {
      var disposed = false;
      var pollTimer = null;
      var tickTimer = null;
      var t = makeT(ctx);

      // Locale dictionaries (HMR-safe: the effect's disposer unregisters them).
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(function () { return ctx.locale.register(NS, { zh: ZH, en: EN }); },
            'dsh-reply-timer: locale dictionaries');
          if (typeof ctx.locale.bind === 'function') t = ctx.locale.bind(NS);
        }
      } catch (e) {}

      // Register the dock widget. Each slot registration is independent so a
      // host lacking one seat cannot lose the others. `inject` is what makes
      // the widget session-accurate: `conversation.composer.dock` is a
      // scope:'session' slot, so the Host hands the owning session id to the
      // registration's inject face (same shape as dsh-connect-workbuddy's
      // `inject: (sessionId) => ({ t, sessionId })`). Without it the widget has
      // no way to know which dock it was mounted in.
      try {
        if (h && ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.slots.inject(SLOT, function () {
            return ctx.slots.register(
              {
                name: SLOT,
                id: ID,
                order: 60,
                label: function () { return 'Reply Timer'; },
                inject: function (sessionId) {
                  return { t: t, sessionId: typeof sessionId === 'string' ? sessionId : '' };
                },
              },
              function (face) {
                return h(Widget, {
                  ctx: ctx,
                  t: (face && face.t) || t,
                  sessionId: (face && face.sessionId) || '',
                  ownerProps: face,
                });
              },
            );
          });
        }
      } catch (e) {}

      // Watchers + poll + heartbeat tick. Registered in one effect so cleanup
      // disposes everything; apply ALSO returns the same teardown for hosts
      // that use the return-value convention.
      function teardown() {
        if (disposed) return;
        disposed = true;
        if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
        if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
      }
      function schedulePoll() {
        if (disposed) return;
        // The Host snapshot is a coarse signal (phase / ledger / last activity);
        // smooth elapsed time comes from the local tick, not from the poll. A
        // 1 s period while running (was 400 ms = 2.5 req/s per tab) is plenty
        // and keeps a multi-tab GUI from hammering one Host route.
        var period = store.hasRunning() ? 1000 : 3000;
        pollTimer = setTimeout(function () {
          pollTimer = null;
          pollOnce()
            .then(function (value) {
              if (!disposed && value) store.setSnap(value);
            })
            .catch(function () {})
            .then(function () { if (!disposed) schedulePoll(); });
        }, period);
      }
      ctx.effect(function () {
        // Local tick: smooth pulse + live elapsed between polls.
        tickTimer = setInterval(function () {
          if (store.hasRunning()) store.bump();
        }, 250);
        // Kick off immediately, then self-reschedule with an adaptive period.
        pollOnce()
          .then(function (value) { if (!disposed && value) store.setSnap(value); })
          .catch(function () {})
          .then(function () { if (!disposed) schedulePoll(); });
        return teardown;
      }, 'dsh-reply-timer: poll + heartbeat');

      return teardown;
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
