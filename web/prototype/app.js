/* TermAgent web view prototype, v4.
   No dependencies. State here is simulated; production reads it from the durable event cursor. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)');

  const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  const layout = $('#layout');
  const feed = $('#feed');
  const inner = $('#feedInner');

  /* ---------- Toast ---------- */
  const toastEl = $('#toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2200);
  }

  /* ---------- Theme ---------- */
  const lightQuery = matchMedia('(prefers-color-scheme: light)');
  let themePref = store.get('termagent:theme', 'dark');
  function applyTheme() {
    const t = themePref === 'system' ? (lightQuery.matches ? 'light' : 'dark') : themePref;
    document.documentElement.dataset.theme = t;
    $('meta[name="theme-color"]').content = t === 'light' ? '#ffffff' : '#000000';
  }
  lightQuery.addEventListener('change', () => { if (themePref === 'system') applyTheme(); });
  applyTheme();

  /* ---------- Views, drawer, sheet ---------- */
  function setView(view) {
    layout.dataset.view = view;
    $$('.tabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  }
  $('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) setView(tab.dataset.view);
  });
  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { closeSheet(); setView(open.dataset.open); }
    const t = e.target.closest('[data-toast]');
    if (t) toast(t.dataset.toast);
  });

  const side = $('#side');
  const scrim = $('#scrim');
  const setDrawer = (open) => {
    side.classList.toggle('is-open', open);
    scrim.classList.toggle('is-on', open);
  };
  $('#menuBtn').addEventListener('click', () => setDrawer(true));
  $('#sideClose').addEventListener('click', () => setDrawer(false));
  scrim.addEventListener('click', () => setDrawer(false));

  $('#sessions').addEventListener('click', (e) => {
    const btn = e.target.closest('.session-btn');
    if (!btn) return;
    $$('.session-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    setDrawer(false);
    if (!btn.querySelector('.dot[data-s="running"]')) toast('This prototype has one transcript');
  });
  $('#sessionSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    let shown = 0;
    $$('.session-btn').forEach((b) => {
      const hit = b.dataset.title.toLowerCase().includes(q);
      b.hidden = !hit;
      if (hit) shown++;
    });
    $$('.group-label').forEach((g) => { g.hidden = q.length > 0; });
    $('#sessionsEmpty').hidden = shown > 0;
  });
  $('#newSession').addEventListener('click', () => { setDrawer(false); toast('New session flow is not part of this prototype'); });

  const sheet = $('#sheet');
  const sheetScrim = $('#sheetScrim');
  let sheetReturnFocus = null;
  function openSheet(title, html) {
    sheetReturnFocus = document.activeElement;
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    sheet.classList.add('is-open');
    sheetScrim.classList.add('is-on');
    $('#sheetClose').focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!sheet.classList.contains('is-open')) return;
    sheet.classList.remove('is-open');
    sheetScrim.classList.remove('is-on');
    sheetReturnFocus?.focus?.({ preventScroll: true });
  }
  $('#sheetClose').addEventListener('click', closeSheet);
  sheetScrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeSheet();
    setDrawer(false);
    hideSlash();
  });

  /* ---------- Feed behaviour: follow the live edge, jump back with Latest ---------- */
  const jump = $('#jump');
  let stick = true;
  const gap = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight;
  feed.addEventListener('scroll', () => {
    stick = gap() < 80;
    jump.classList.toggle('is-visible', gap() > 160);
  }, { passive: true });
  new ResizeObserver(() => { if (stick) feed.scrollTop = feed.scrollHeight; }).observe(inner);
  jump.addEventListener('click', () => {
    feed.scrollTo({ top: feed.scrollHeight, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  });
  const toBottom = () => { stick = true; feed.scrollTop = feed.scrollHeight; };

  /* ---------- Tool disclosure and copy ---------- */
  inner.addEventListener('click', (e) => {
    const head = e.target.closest('.tool-head');
    if (head) {
      const card = head.closest('.tool');
      head.setAttribute('aria-expanded', String(card.classList.toggle('is-open')));
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const text = copy.closest('.tool').querySelector('.term').innerText.replace(/^\$ /, '');
      navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy is blocked in this browser'));
      return;
    }
    if (e.target.closest('[data-stop]')) stopRun();
  });

  /* ---------- Simulated run engine ---------- */
  const SCENARIOS = {
    health: {
      label: 'Verifying existing service',
      plan: ['Inspect existing service', 'Verify health endpoint', 'Confirm stable background process', 'Report final state'],
      step: 3,
      activity: { title: 'Health probe', sub: 'curl :6446/health' },
      cmd: 'for i in 1 2 3; do curl -fsS http://127.0.0.1:6446/health; echo; sleep 2; done',
      desc: 'Probe the health endpoint three times, two seconds apart, to confirm the process is stable.',
      lines: [
        '{"status":"ok","service":"proxy","uptime":1842}',
        '{"status":"ok","service":"proxy","uptime":1844}',
        '{"status":"ok","service":"proxy","uptime":1846}',
        '3 of 3 probes returned 200',
      ],
      note: 'Working tree clean. No file changes were needed.',
      final: 'The proxy is healthy and the existing process is still serving <code>:6446</code>. I left it untouched.',
      proofs: ['Health 200', 'Process alive', 'Tree clean'],
    },
    logs: {
      label: 'Checking service log',
      plan: ['Locate service log', 'Search for restart entries', 'Report result'],
      step: 2,
      activity: { title: 'Log search', sub: 'grep restart server.log' },
      cmd: "grep -ci 'restart' server/server.log",
      desc: 'Count restart entries in the service log.',
      lines: ['0'],
      final: 'There are no restart entries in <code>server/server.log</code>. The process has run since its first start at 22:03.',
      proofs: ['0 restarts', 'Log readable'],
    },
    demo: {
      label: 'Handling your prompt',
      plan: ['Read prompt', 'Report result'],
      step: 1,
      activity: { title: 'Prompt received', sub: 'prototype only' },
      cmd: '# no runtime attached',
      desc: 'This prototype is not connected to an agent.',
      lines: ['Prototype only. Your message was not sent anywhere.'],
      final: 'This is a design prototype, so there is no agent behind it. In the real app this is where the run would continue.',
      proofs: [],
    },
  };

  const run = {
    no: 18, state: 'idle', scn: SCENARIOS.health, step: 3, lineIdx: 0, card: null,
    elapsed: 0, resumedAt: 0, toolMs: 0, toolResumedAt: 0, ticker: null,
  };
  const data = {
    seq: 244,
    tools: 1,
    queue: ['Check the service log for recent restarts'],
    activity: [
      { title: 'Workspace scan', sub: 'read 14 files', at: Date.now() - 9000, s: 'done' },
      { title: 'Port ownership', sub: "ss -ltnp | grep ':6446'", at: Date.now() - 4000, s: 'done' },
    ],
  };

  const elapsedMs = () => run.elapsed + (run.state === 'running' ? Date.now() - run.resumedAt : 0);
  const toolElapsed = () => run.toolMs + (run.state === 'running' ? Date.now() - run.toolResumedAt : 0);
  const fmtClock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fmtAgo = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 2 ? 'now' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`; };

  function renderRunbar() {
    const s = run.state;
    const total = run.scn.plan.length;
    $('#runbar').dataset.state = s;
    $('#runDot').dataset.s = s === 'running' ? 'running' : s === 'done' ? 'done' : 'warn';
    $('#runLabel').textContent = s === 'done' ? 'Run complete' : s === 'stopped' ? 'Stopped' : run.scn.label;
    $('#runStep').textContent =
      s === 'done' ? `${total} of ${total} steps` : s === 'stopped' ? 'Input is still available' : `Step ${run.step} of ${total}`;
    $('#runClock').textContent = fmtClock(elapsedMs());

    const btn = $('#stopBtn');
    const resume = s === 'stopped';
    btn.className = resume ? 'btn' : 'btn btn-danger';
    btn.innerHTML = `${icon(resume ? 'play' : 'stop')}<span>${resume ? 'Resume' : 'Stop'}</span>`;

    $('#runProgress').innerHTML = run.scn.plan.map((_, i) => {
      const cls = s === 'done' || i < run.step - 1 ? 'done' : i === run.step - 1 ? (s === 'stopped' ? 'paused' : 'active') : '';
      return `<i class="${cls}"></i>`;
    }).join('');

    $('#inspTitle').textContent = `Run ${run.no}`;
    $('#inspSub').textContent = s === 'done' ? 'Complete' : s === 'stopped' ? 'Stopped' : run.scn.label;
  }

  function renderPlan() {
    const done = run.state === 'done';
    const list = $('#plan');
    list.classList.toggle('is-paused', run.state === 'stopped');
    list.innerHTML = run.scn.plan.map((label, i) => {
      const st = done || i < run.step - 1 ? 'done' : i === run.step - 1 ? 'current' : 'todo';
      return `<li data-s="${st}"><span class="pi">${icon('check')}</span><span>${esc(label)}</span></li>`;
    }).join('');
  }

  function renderActivity() {
    $('#timeline').innerHTML = [...data.activity].reverse().map((a) => {
      const dot = a.s === 'running' ? 'running' : a.s === 'stopped' ? 'warn' : 'done';
      return `<li><span class="dot" data-s="${dot}"></span><div><strong>${esc(a.title)}</strong><small>${esc(a.sub)}</small></div><time>${fmtAgo(Date.now() - a.at)}</time></li>`;
    }).join('');
  }

  function renderEvidence() {
    $('#kvTools').textContent = String(data.tools + (run.card && run.state !== 'done' ? 1 : 0));
    $('#kvTasks').textContent = run.state === 'running' ? '1 active' : 'None active';
    $('#kvSeq').textContent = `seq ${data.seq}`;
  }

  function renderQueue() {
    const q = $('#queue');
    if (!data.queue.length) { q.hidden = true; return; }
    q.hidden = false;
    q.innerHTML =
      `<span class="q-label">Queued</span><span class="q-text">${esc(data.queue[0])}</span>` +
      (data.queue.length > 1 ? `<span class="q-more">+${data.queue.length - 1}</span>` : '') +
      `<button class="icon-btn" type="button" id="queueCancel" aria-label="Remove queued message">${icon('x')}</button>`;
  }
  $('#queue').addEventListener('click', (e) => {
    if (e.target.closest('#queueCancel')) { data.queue.shift(); renderQueue(); toast('Removed from queue'); }
  });

  const renderAll = () => { renderRunbar(); renderPlan(); renderActivity(); renderEvidence(); renderQueue(); };

  function toolState(card, state) {
    card.dataset.state = state;
    const slot = $('.tool-state', card);
    slot.innerHTML = state === 'running' ? icon('spinner', 'spin') : state === 'stopped' ? icon('minus') : icon('check');
  }

  function appendUser(text) {
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    el.textContent = text;
    inner.appendChild(el);
  }

  function startRun(scn, opts = {}) {
    clearInterval(run.ticker);
    run.scn = scn;
    run.step = scn.step;
    run.lineIdx = 0;
    run.elapsed = opts.offsetMs || 0;
    run.resumedAt = Date.now();
    run.toolMs = 0;
    run.toolResumedAt = Date.now();
    run.state = 'running';
    if (scn !== SCENARIOS.health) run.no += 1;

    const card = document.createElement('article');
    card.className = 'tool is-open';
    card.innerHTML =
      `<button class="tool-head" type="button" aria-expanded="true">${icon('terminal', 'tool-ico')}` +
      `<span class="tool-cmd">${esc(scn.cmd)}</span><span class="tool-state"></span><time class="tool-time">0s</time>${icon('chevron-down', 'chev')}</button>` +
      `<div class="tool-body"><div><p class="tool-desc">${esc(scn.desc)}</p>` +
      `<pre class="term" aria-live="off"><code><span class="ps">$</span> <span class="cmd">${esc(scn.cmd)}</span>\n<span class="out"></span><span class="caret"></span></code></pre>` +
      `<div class="tool-foot"><button class="link-btn" type="button" data-copy>Copy output</button><button class="link-btn danger" type="button" data-stop>Stop</button></div></div></div>`;
    toolState(card, 'running');
    inner.appendChild(card);
    run.card = card;

    data.activity.push({ title: scn.activity.title, sub: scn.activity.sub, at: Date.now(), s: 'running' });
    renderAll();
    toBottom();
    run.ticker = setInterval(tick, 1500);
    ticking.start();
  }

  function tick() {
    if (run.state !== 'running') return;
    const scn = run.scn;
    if (run.lineIdx < scn.lines.length) {
      $('.out', run.card).textContent += scn.lines[run.lineIdx++] + '\n';
      data.seq += 1;
      renderEvidence();
      return;
    }
    finishRun();
  }

  function finishRun() {
    clearInterval(run.ticker);
    const scn = run.scn;
    const secs = (toolElapsed() / 1000).toFixed(1);
    run.elapsed = elapsedMs();
    run.state = 'done';
    $('.caret', run.card)?.remove();
    $('.tool-time', run.card).textContent = `${secs}s`;
    $('[data-stop]', run.card)?.remove();
    toolState(run.card, 'done');
    run.card.classList.remove('is-open');
    $('.tool-head', run.card).setAttribute('aria-expanded', 'false');
    data.activity[data.activity.length - 1].s = 'done';
    data.tools += 1;
    data.seq += 1;
    run.card = null;

    if (scn.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.innerHTML = `${icon('branch')}<span>${esc(scn.note)}</span><button class="link-btn" type="button" data-open="files">View changes</button>`;
      inner.appendChild(note);
    }
    const msg = document.createElement('div');
    msg.className = 'msg msg-agent';
    msg.innerHTML = `<p>${scn.final}</p>` +
      (scn.proofs.length ? `<div class="proofs">${scn.proofs.map((p) => `<span class="proof">${icon('check')}${esc(p)}</span>`).join('')}</div>` : '');
    inner.appendChild(msg);

    renderAll();
    if (data.queue.length) setTimeout(dispatchQueued, 1400);
  }

  function dispatchQueued() {
    if (run.state !== 'done' || !data.queue.length) return;
    const text = data.queue.shift();
    appendUser(text);
    startRun(/service log/i.test(text) ? SCENARIOS.logs : SCENARIOS.demo);
  }

  function stopRun() {
    if (run.state !== 'running') return;
    clearInterval(run.ticker);
    run.elapsed = elapsedMs();
    run.toolMs = toolElapsed();
    run.state = 'stopped';
    $('.caret', run.card)?.remove();
    toolState(run.card, 'stopped');
    data.activity[data.activity.length - 1].s = 'stopped';
    renderAll();
    toast('Stopped. You can resume or send a new message.');
  }

  function resumeRun() {
    if (run.state !== 'stopped') return;
    run.state = 'running';
    run.resumedAt = Date.now();
    run.toolResumedAt = Date.now();
    $('code', run.card).insertAdjacentHTML('beforeend', '<span class="caret"></span>');
    toolState(run.card, 'running');
    data.activity[data.activity.length - 1].s = 'running';
    run.ticker = setInterval(tick, 1500);
    renderAll();
  }

  $('#stopBtn').addEventListener('click', () => (run.state === 'stopped' ? resumeRun() : stopRun()));

  /* One-second clock for the run timer, tool timer and relative times */
  const ticking = {
    id: null,
    start() {
      if (this.id) return;
      this.id = setInterval(() => {
        $('#runClock').textContent = fmtClock(elapsedMs());
        if (run.card && run.state === 'running') $('.tool-time', run.card).textContent = `${Math.floor(toolElapsed() / 1000)}s`;
        renderActivity();
      }, 1000);
    },
  };

  /* ---------- Composer ---------- */
  const input = $('#input');
  const send = $('#send');
  const slash = $('#slash');
  const COMMANDS = [
    ['/compact', 'Summarize context and keep active work'],
    ['/undo', 'Revert the latest turn'],
    ['/diff', 'Show changed files'],
    ['/verify', 'Re-run health checks'],
    ['/details', 'Open run details'],
  ];

  function fit() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 168) + 'px';
    send.disabled = input.value.trim() === '';
  }
  function hideSlash() { slash.hidden = true; }
  function updateSlash() {
    const v = input.value;
    if (!v.startsWith('/') || /\s/.test(v)) return hideSlash();
    const hits = COMMANDS.filter(([c]) => c.startsWith(v.toLowerCase()));
    if (!hits.length) return hideSlash();
    slash.innerHTML = hits.map(([c, d]) => `<button type="button" role="option" data-cmd="${c}"><b>${c}</b><span>${esc(d)}</span></button>`).join('');
    slash.hidden = false;
  }
  slash.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    input.value = b.dataset.cmd + ' ';
    hideSlash();
    fit();
    input.focus();
  });

  input.addEventListener('input', () => { fit(); updateSlash(); });
  input.addEventListener('keydown', (e) => {
    const submit = e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!coarse.matches || e.metaKey || e.ctrlKey);
    if (submit) { e.preventDefault(); submitPrompt(); }
  });
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); submitPrompt(); });

  function submitPrompt() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    fit();
    hideSlash();

    if (text === '/details') { setView('activity'); return; }

    if (run.state === 'running') {
      data.queue.push(text);
      renderQueue();
      toast('Queued. It runs after the current step.');
      return;
    }
    appendUser(text);
    startRun(SCENARIOS.demo);
  }

  const MODES = ['Build', 'Plan', 'Ask'];
  let mode = 0;
  $('#modeBtn').addEventListener('click', () => {
    mode = (mode + 1) % MODES.length;
    $('#modeLabel').textContent = MODES[mode];
    $('#modeBtn').setAttribute('aria-label', `Mode: ${MODES[mode]}. Tap to change.`);
  });
  $('#attachBtn').addEventListener('click', () => toast('Context picker is not part of this prototype'));

  /* ---------- Options sheet, permissions, focus mode ---------- */
  const inspectorBtn = $('#inspectorBtn');
  inspectorBtn.addEventListener('click', () => {
    const on = layout.dataset.inspector !== 'on';
    layout.dataset.inspector = on ? 'on' : 'off';
    inspectorBtn.setAttribute('aria-pressed', String(on));
  });

  function optionsMarkup() {
    const focus = document.body.classList.contains('is-focus');
    return `
      <p class="sheet-section">Appearance</p>
      <div class="seg" role="group" aria-label="Theme">
        ${['system', 'light', 'dark'].map((t) => `<button type="button" data-set-theme="${t}" aria-pressed="${themePref === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      </div>
      <p class="sheet-section">Session</p>
      <button class="menu-row only-wide-row" type="button" data-action="focus" role="switch" aria-checked="${focus}">${icon('focus')}<span>Focus mode</span><i class="switch"></i></button>
      <button class="menu-row" type="button" data-action="permissions">${icon('shield')}<span>Permission history</span>${icon('chevron-right')}</button>
      <p class="sheet-section">Prototype</p>
      <button class="menu-row" type="button" data-action="reconnect">${icon('wifi-off')}<span>Preview reconnect state</span></button>
      <button class="menu-row" type="button" data-action="replay">${icon('replay')}<span>Replay run</span></button>`;
  }
  $('#moreBtn').addEventListener('click', () => openSheet('Options', optionsMarkup()));
  $('#permBtn').addEventListener('click', openPermissions);

  function openPermissions() {
    openSheet('Permissions', `
      <div class="empty" style="padding:8px 10px 12px"><strong>No pending requests</strong><p>The agent is not waiting on you. Requests appear here and as a prompt above the composer.</p></div>
      <p class="sheet-section">Earlier decisions</p>
      <div class="decision"><div><strong>bash: ss -ltnp</strong><small>Allowed once at 22:41</small></div></div>
      <div class="decision"><div><strong>bash: curl 127.0.0.1:6446</strong><small>Allowed by rule at 22:42</small></div></div>`);
  }

  $('#sheetBody').addEventListener('click', (e) => {
    const themeBtn = e.target.closest('[data-set-theme]');
    if (themeBtn) {
      themePref = themeBtn.dataset.setTheme;
      store.set('termagent:theme', themePref);
      applyTheme();
      $$('[data-set-theme]', $('#sheetBody')).forEach((b) => b.setAttribute('aria-pressed', String(b === themeBtn)));
      return;
    }
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (act === 'focus') {
      const on = document.body.classList.toggle('is-focus');
      e.target.closest('[data-action]').setAttribute('aria-checked', String(on));
    } else if (act === 'permissions') openPermissions();
    else if (act === 'reconnect') { closeSheet(); previewReconnect(); }
    else if (act === 'replay') { closeSheet(); replay(); }
  });

  /* ---------- Connection state ---------- */
  const banner = $('#banner');
  let hideBanner;
  function setConnection(online, quiet) {
    clearTimeout(hideBanner);
    if (!online) {
      banner.dataset.s = 'warn';
      banner.innerHTML = `${icon('spinner', 'spin')}<span>Connection lost. Retrying. Messages you send are kept and delivered on reconnect.</span>`;
      banner.hidden = false;
    } else if (!banner.hidden) {
      banner.dataset.s = 'done';
      banner.innerHTML = `${icon('check')}<span>Reconnected. Replayed events from seq ${data.seq}.</span>`;
      hideBanner = setTimeout(() => { banner.hidden = true; }, quiet ? 2400 : 3200);
    }
  }
  addEventListener('offline', () => setConnection(false));
  addEventListener('online', () => setConnection(true));
  function previewReconnect() {
    setView('session');
    setConnection(false);
    setTimeout(() => setConnection(true, true), 2600);
  }

  /* ---------- Replay ---------- */
  function replay() {
    clearInterval(run.ticker);
    run.card = null;
    run.no = 18;
    data.seq = 244;
    data.tools = 1;
    data.queue = ['Check the service log for recent restarts'];
    data.activity = data.activity.slice(0, 2).map((a, i) => ({ ...a, at: Date.now() - (9000 - i * 5000) }));
    // Keep the static opening (date, prompt, reply, first tool, reply); drop everything the run appended.
    [...inner.children].slice(5).forEach((n) => n.remove());
    setView('session');
    startRun(SCENARIOS.health, { offsetMs: 42000 });
  }

  /* ---------- Boot ---------- */
  fit();
  toBottom();
  startRun(SCENARIOS.health, { offsetMs: 42000 });
})();
