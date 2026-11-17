'use strict';
(() => {
  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const api = async (path, opts) => {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };

  const UI_BUILD = '2026-11-12.10';
  const REQUIRED_API = 4;   // server /api/health must report api >= this
  const state = {
    providers: [], providerId: '', provider: null,
    results: [], detail: null, season: 1, quality: '',
    selected: new Set(), jobs: [], busy: false,
    interval: '', perSheet: '', sheets: '',
    captions: false, captionLang: '',
    wCenter: '', wBefore: '300', wAfter: '60', wInterval: '', wPerSheet: '', wSheets: '',
    focusEp: 0,                    // episode chip clicked most recently
    clipStart: '', clipDuration: '30',
    duration: 0, durationLabel: '', durationKey: '', _planInputs: null,
    durations: new Map(),          // client-side runtime cache: key -> {duration, label}
    durationFailedAt: 0,          // last probe failure time (throttles retries)
    pendingClipDownloads: new Set(), // clip job ids that should auto-download when ready
    pendingPdfDownloads: new Set(),  // PDF job ids that should auto-download when ready
  };

  function toast(msg, ok = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (ok ? ' ok' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 6000);
  }

  function showBanner(msg) {
    let b = document.getElementById('staleBanner');
    if (!b) { b = el('div', 'stale-banner'); b.id = 'staleBanner'; document.body.prepend(b); }
    b.textContent = msg;
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /* ---------------- providers ---------------- */
  async function loadProviders() {
    const { providers } = await api('/api/providers');
    state.providers = providers;
    const params = new URLSearchParams(location.search);
    const wanted = params.get('provider');
    state.providerId = (wanted && providers.some(p => p.id === wanted)) ? wanted : providers[0].id;
    renderProviderStrip();
    selectProvider(state.providerId, false);
  }

  function renderProviderStrip() {
    const strip = $('#providerStrip');
    strip.innerHTML = '';
    const order = ['moviebox', 'castle', 'youtube'];
    const sorted = state.providers.slice().sort((a, b) => {
      const d = order.indexOf(a.kind) - order.indexOf(b.kind);
      return d || a.name.localeCompare(b.name);
    });
    for (const p of sorted) {
      const b = el('button', 'prov-tab', p.short);
      b.type = 'button';
      b.title = `${p.name} — ${p.repo}/${p.file}`;
      b.style.setProperty('--dot', p.accent || '#ffb020');
      b.dataset.id = p.id;
      const dot = el('span', 'dot');
      b.prepend(dot);
      b.addEventListener('click', () => selectProvider(p.id));
      strip.appendChild(b);
    }
  }

  function selectProvider(id, reset = true) {
    state.providerId = id;
    state.provider = state.providers.find(p => p.id === id) || null;
    document.querySelectorAll('.prov-tab').forEach(b => b.classList.toggle('active', b.dataset.id === id));
    $('#brandSub').textContent = state.provider
      ? `${state.provider.name} · ${state.provider.repo}/${state.provider.file}`
      : 'Provider runtime & contact sheets';
    if (reset) {
      state.results = [];
      state.detail = null;
      state.selected.clear();
      $('#results').innerHTML = '';
      $('#searchStatus').textContent = '';
      renderDetail();
      const url = new URL(location.href);
      url.searchParams.set('provider', id);
      history.replaceState(null, '', url);
    }
  }

  /* ---------------- search ---------------- */
  /* A pasted YouTube link searches YouTube even when another provider tab is active. */
  function looksLikeYouTubeLink(q) {
    const s = String(q || '').trim();
    return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\S*$/i.test(s)
      || /^https?:\/\/(www\.|m\.)?youtu\.be\/\S+/i.test(s);
  }

  $('#searchForm').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('#query').value.trim();
    if (!q || !state.providerId) return;
    if (looksLikeYouTubeLink(q) && state.providerId !== 'youtube'
      && state.providers.some(p => p.id === 'youtube')) {
      selectProvider('youtube');
    }
    const status = $('#searchStatus');
    const provider = state.provider;
    const t0 = Date.now();
    status.className = 'search-status';
    status.innerHTML = `<span class="spinner"></span>Searching ${provider ? provider.short : ''}…`;
    const timer = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      status.innerHTML = `<span class="spinner"></span>Searching… ${s}s`;
    }, 500);
    try {
      const res = await api(`/api/search?provider=${encodeURIComponent(state.providerId)}&q=${encodeURIComponent(q)}`);
      clearInterval(timer);
      state.results = res.items || [];
      renderResults(res);
      status.className = 'search-status';
      status.textContent = `${state.results.length} result(s) in ${((res.ms || 0) / 1000).toFixed(1)}s`
        + (res.total ? ` · index ${res.total.toLocaleString()} titles` : '');
    } catch (err) {
      clearInterval(timer);
      status.className = 'search-status err';
      status.textContent = 'Search failed: ' + err.message;
    }
  });

  /* ---------------- video -> PDF ---------------- */
  /* Paste a YouTube link: the bridge downloads the whole video once, decodes
     every frame at the chosen fps, writes a PDF and deletes the images. */
  $('#pdfGo').addEventListener('click', async e => {
    e.preventDefault();
    const link = $('#pdfLink').value.trim();
    if (!link) return toast('Paste a YouTube video link first');
    const fps = Math.max(1, Math.min(30, Math.round(Number($('#pdfFps').value) || 30)));
    const width = Number($('#pdfWidth').value) || 640;
    const btn = $('#pdfGo');
    btn.disabled = true;
    btn.textContent = 'Queuing…';
    try {
      const res = await api(`/api/search?provider=youtube&q=${encodeURIComponent(link)}`);
      const item = (res.items || [])[0];
      if (!item) throw new Error('that link did not resolve to a YouTube video');
      if (item.type === 'series') throw new Error('that is a playlist — paste a single video link');
      const { job } = await api('/api/jobs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'youtube', id: item.id, title: item.title,
          type: 'movie', kind: 'pdf', fps, width,
        }),
      });
      state.pendingPdfDownloads.add(job.id);
      toast(`PDF queued: ${item.title} · ${fps} fps`, true);
      $('#pdfLink').value = '';
      loadJobs();
      document.getElementById('jobsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast('Could not queue PDF: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Make PDF';
    }
  });

  function renderResults(res) {
    const box = $('#results');
    box.innerHTML = '';
    if (!state.results.length) {
      box.innerHTML = '<div class="empty result-empty"><p>No matches. Try a different spelling, or paste a YouTube link.</p></div>';
      return;
    }
    for (const item of state.results) {
      const isYT = state.provider && state.provider.kind === 'youtube';
      const card = el('button', 'result' + (isYT ? ' yt' : ''));
      card.type = 'button';
      const thumb = el('div', 'thumb');
      if (item.poster) thumb.style.backgroundImage = `url("${item.poster}")`;
      else {
        thumb.classList.add('no-poster');
        thumb.appendChild(el('span', 'poster-letter', (item.title || '?').trim().charAt(0).toUpperCase()));
      }
      thumb.appendChild(el('span', 'type', item.type === 'series' ? 'Series' : isYT ? 'Video' : 'Movie'));
      const body = el('div', 'body');
      body.appendChild(el('strong', '', item.title || 'Untitled'));
      body.appendChild(el('small', '', [item.year, item.subtitle].filter(Boolean).join(' · ')));
      card.appendChild(thumb);
      card.appendChild(body);
      card.addEventListener('click', () => openDetail(item));
      box.appendChild(card);
    }
  }

  /* ---------------- detail ---------------- */
  async function openDetail(item) {
    const status = $('#searchStatus');
    status.innerHTML = '<span class="spinner"></span>Loading title…';
    try {
      const res = await api(`/api/detail?provider=${encodeURIComponent(state.providerId)}&id=${encodeURIComponent(item.id)}`);
      state.detail = res.detail;
      state.detail._providerId = state.providerId;
      state.detail._listItem = item;
      state.season = (state.detail.seasons && state.detail.seasons[0] && state.detail.seasons[0].season) || 0;
      state.quality = (state.detail.qualities && state.detail.qualities[0]) || '';
      state.selected.clear();
      state.focusEp = 0;
      renderDetail();
      status.textContent = '';
    } catch (e) {
      status.className = 'search-status err';
      status.textContent = 'Could not load title: ' + e.message;
    }
  }

  function currentSeasonObj() {
    const d = state.detail;
    if (!d || !Array.isArray(d.seasons)) return null;
    return d.seasons.find(s => Number(s.season) === Number(state.season)) || d.seasons[0] || null;
  }
  function currentEpisodes() {
    const s = currentSeasonObj();
    return (s && Array.isArray(s.episodes)) ? s.episodes : [];
  }

  /* The episode every single-episode feature (runtime, clip, preview) works on:
     the chip clicked last, else the lowest selected, else episode 1. */
  function primaryEpisode() {
    const d = state.detail;
    if (!d || d.type !== 'series') return 0;
    if (state.focusEp && state.selected.has(state.focusEp)) return state.focusEp;
    const sel = [...state.selected].sort((a, b) => a - b);
    return sel[0] || (currentEpisodes()[0] && currentEpisodes()[0].number) || 1;
  }

  /* ---- sheet plan: any two of interval / images-per-sheet / sheets ---- */
  function detailDurationKey() {
    const d = state.detail;
    if (!d) return '';
    const ep = primaryEpisode();
    return `${state.providerId}|${d.id}|${state.season}|${ep}|${state.quality || ''}`;
  }

  async function ensureDuration() {
    const d = state.detail;
    if (!d) return;
    const key = detailDurationKey();

    // Client-side cache: an episode already probed in this session fills instantly.
    const cached = state.durations.get(key);
    if (cached) {
      state.duration = cached.duration;
      state.durationLabel = cached.label;
      updatePlan();
      return;
    }
    if (state.durationKey === key && state.duration) return;
    if (state.durationKey === key && state.durationPending) return;
    // Throttle retries after a failure so typing does not spam the probe.
    if (state.durationKey === key && state.durationFailedAt
      && Date.now() - state.durationFailedAt < 5000) return;
    state.durationKey = key;
    state.durationPending = true;
    if (state._planInputs) state._planInputs.planHint.textContent = 'detecting runtime…';
    try {
      const ep = primaryEpisode();
      const q = state.quality ? `&quality=${state.quality}` : '';
      const r = await api(`/api/duration?provider=${encodeURIComponent(state.providerId)}&id=${encodeURIComponent(d.id)}&season=${state.season}&episode=${ep}${q}`);
      state.duration = r.duration || 0;
      state.durationLabel = r.durationLabel || '';
      state.durationFailedAt = 0;
      if (state.duration) state.durations.set(key, { duration: state.duration, label: state.durationLabel });
    } catch (e) {
      state.duration = 0;
      state.durationLabel = '';
      state.durationFailedAt = Date.now();
    } finally {
      state.durationPending = false;
      updatePlan();
    }
  }

  function computePlan(vals, dur) {
    let iv = Number(vals.interval) || 0;
    let per = Number(vals.perSheet) || 0;
    let n = Number(vals.sheets) || 0;
    let target = null, computed = 0;
    if (dur) {
      if (iv && per) { if (!n) { target = 'sheets'; computed = Math.max(1, Math.ceil(dur / (iv * per))); } }
      else if (iv && n) { if (!per) { target = 'perSheet'; computed = Math.max(1, Math.min(60, Math.ceil(dur / (iv * n)))); } }
      else if (per && n) { if (!iv) { target = 'interval'; computed = Math.max(0.1, Math.round((dur / (per * n)) * 10) / 10); } }
      else if (iv) { per = 30; n = Math.max(1, Math.ceil(dur / (iv * per))); }
      else if (per) { n = 1; iv = dur / per; }
      else if (n) { per = 30; iv = dur / (per * n); }
      else { per = 30; n = 1; iv = dur / per; target = 'interval'; computed = iv; }
    }
    if (target === 'sheets') n = computed;
    if (target === 'perSheet') per = computed;
    if (target === 'interval') iv = computed;
    return { interval: iv, perSheet: per, sheets: n, target, computed };
  }

  /* Read the three plan inputs. manualOnly drops auto-filled values so only what
     the person actually typed is sent to the server. */
  function readPlan(p, manualOnly) {
    if (!p) return { interval: 0, perSheet: 0, sheets: 0 };
    const rd = inp => (manualOnly && inp.dataset.auto === '1') ? 0 : (Number(inp.value) || 0);
    return { interval: rd(p.ivInput), perSheet: rd(p.perInput), sheets: rd(p.sheetsInput) };
  }
  function readPlanValues(manualOnly) { return readPlan(state._planInputs, manualOnly); }

  function refreshPlan(p, dur, label, pending, idleHint) {
    if (!p) return;
    const inputs = { interval: p.ivInput, perSheet: p.perInput, sheets: p.sheetsInput };
    for (const inp of Object.values(inputs)) {
      if (inp.dataset.auto === '1') { inp.value = ''; delete inp.dataset.auto; inp.classList.remove('auto'); }
    }
    const plan = computePlan(readPlan(p), dur);
    if (plan.target && plan.computed) {
      const inp = inputs[plan.target];
      inp.value = String(plan.computed);
      inp.dataset.auto = '1';
      inp.classList.add('auto');
    }
    const eff = readPlan(p);
    if (!dur) {
      p.planHint.textContent = pending ? 'detecting runtime…' : idleHint;
    } else {
      const ivVal = eff.interval || plan.interval;
      const iv = ivVal ? ivVal.toFixed(1) + 's' : 'auto';
      p.planHint.textContent = `${label} · ${eff.sheets || plan.sheets || 1} sheet(s) × ${eff.perSheet || plan.perSheet || 30} frames, every ${iv}`;
    }
  }

  function updatePlan() {
    const dur = Number(state.duration) || 0;
    refreshPlan(state._planInputs, dur, state.durationLabel || (dur ? fmtClock(dur) : ''),
      state.durationPending, 'runtime unknown — type to retry, or fill all three');
    updateWindowPlan();
  }

  /* Length in seconds of the window around the timestamp (clamped to the runtime when known). */
  function windowSpan() {
    const c = parseTime(state.wCenter, NaN);
    if (!Number.isFinite(c)) return 0;
    const b = Math.max(0, parseTime(state.wBefore, 0));
    const a = Math.max(0, parseTime(state.wAfter, 0));
    const start = Math.max(0, c - b);
    let end = c + a;
    if (state.duration) end = Math.min(end, state.duration - 0.5);
    return Math.max(0, end - start);
  }

  function updateWindowPlan() {
    const s = windowSpan();
    refreshPlan(state._winInputs, s, s ? fmtClock(s) + ' window' : '', false,
      'enter the timestamp and before/after seconds');
  }

  function renderDetail() {
    const body = $('#detailBody');
    const empty = $('#detailEmpty');
    if (!state.detail) {
      body.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    body.classList.remove('hidden');
    const d = state.detail;
    body.innerHTML = '';
    const isYT = state.provider && state.provider.kind === 'youtube';

    const top = el('div', 'detail-top');
    const poster = el('div', 'detail-poster' + (isYT ? ' yt' : ''));
    if (d.poster) poster.style.backgroundImage = `url("${d.poster}")`;
    else {
      poster.classList.add('no-poster');
      poster.appendChild(el('span', 'poster-letter', (d.title || '?').trim().charAt(0).toUpperCase()));
    }
    const meta = el('div', 'detail-meta');
    meta.appendChild(el('h3', '', d.title || 'Untitled'));
    meta.appendChild(el('div', 'sub', [d.year, d.type === 'series' ? 'Series' : isYT ? 'Video' : 'Movie',
      d.rating ? '★ ' + d.rating : '', (d.languages || []).slice(0, 3).join(', ')].filter(Boolean).join(' · ')));
    if (d.plot) meta.appendChild(el('div', 'plot', d.plot));
    const tags = el('div');
    tags.style.marginTop = '8px';
    for (const t of (d.tags || []).slice(0, 8)) tags.appendChild(el('span', 'tag', t));
    meta.appendChild(tags);
    top.appendChild(poster);
    top.appendChild(meta);
    body.appendChild(top);

    const controls = el('div', 'controls');
    const mkSection = (title, hint) => {
      const s = el('section', 'section');
      const head = el('div', 'section-head');
      head.appendChild(el('span', 'section-title', title));
      if (hint) head.appendChild(el('span', 'section-hint', hint));
      s.appendChild(head);
      controls.appendChild(s);
      return s;
    };
    const secSetup = mkSection('Source', 'quality · season · episodes');
    const secPlan = mkSection('Sheet plan', 'pick any two — the third is auto');
    const secCap = state.providerId === 'youtube'
      ? mkSection('Captions', "burn the video's own track into each tile") : null;
    const subKinds = ['moviebox', 'castle'];
    const secSubs = state.provider && subKinds.includes(state.provider.kind)
      ? mkSection('Subtitles', 'download a track as .srt or .vtt') : null;
    const secCreate = mkSection('Create', '');
    const secWin = mkSection('Window sheet', 'a slice around one timestamp');
    const secClip = mkSection('Clip', 'mp4 of the selected episode');

    // quality + season
    const row = el('div', 'control-row');
    if (d.qualities && d.qualities.length) {
      const lab = el('label', '', 'Quality');
      const sel = el('select');
      const auto = el('option', '', 'Auto (best)');
      auto.value = '';
      sel.appendChild(auto);
      for (const q of d.qualities) {
        const o = el('option', '', `${q}p`);
        o.value = String(q);
        sel.appendChild(o);
      }
      sel.value = state.quality ? String(state.quality) : '';
      sel.addEventListener('change', () => {
        state.quality = sel.value;
        state.durationKey = ''; state.duration = 0;
        updatePlan();
        ensureDuration();
      });
      row.appendChild(lab);
      row.appendChild(sel);
    }
    if (d.type === 'series' && d.seasons && d.seasons.length > 1) {
      const lab = el('label', '', 'Season');
      const sel = el('select');
      for (const s of d.seasons) {
        const o = el('option', '', s.name || `Season ${s.season}`);
        o.value = String(s.season);
        sel.appendChild(o);
      }
      sel.value = String(state.season);
      sel.addEventListener('change', () => {
        state.season = Number(sel.value);
        state.selected.clear();
        state.focusEp = 0;
        state.durationKey = ''; state.duration = 0;
        renderDetail();
      });
      row.appendChild(lab);
      row.appendChild(sel);
    }
    if (d.type === 'series') {
      const eps = currentEpisodes();
      const count = el('span', 'hint', `${eps.length} episode(s)`);
      row.appendChild(count);
    }
    secSetup.appendChild(row);

    // Sheet plan: pick any two of interval / images-per-sheet / number of sheets.
    const planRow = el('div', 'control-row plan-row');
    const mkNum = (key, placeholder, title, width, onChange = updatePlan) => {
      const inp = el('input');
      inp.type = 'number';
      inp.min = '1';
      inp.step = '1';
      inp.placeholder = placeholder;
      inp.title = title;
      inp.value = state[key];
      inp.className = 'num-input' + (width ? ' ' + width : '');
      inp.addEventListener('input', () => {
        state[key] = inp.value; inp.classList.remove('auto'); delete inp.dataset.auto; onChange();
        if (!state.duration) ensureDuration(); // typing retrains the runtime probe
      });
      inp.addEventListener('focus', () => { ensureDuration(); });
      return inp;
    };
    const ivInput = mkNum('interval', 'every … s', 'Seconds between snapshots', '');
    const perInput = mkNum('perSheet', 'images', 'Images per contact sheet (max 60)', '');
    const sheetsInput = mkNum('sheets', 'sheets', 'How many contact sheets', '');
    const planHint = el('span', 'hint plan-hint', 'pick any two — the third is auto');
    planRow.appendChild(ivInput);
    planRow.appendChild(el('span', 'hint', 's'));
    planRow.appendChild(perInput);
    planRow.appendChild(el('span', 'hint', 'per sheet'));
    planRow.appendChild(sheetsInput);
    planRow.appendChild(el('span', 'hint', 'sheets'));
    planRow.appendChild(planHint);
    secPlan.appendChild(planRow);

    // YouTube only: burn the video's own caption line into every snapshot.
    if (secCap) {
      const capRow = el('div', 'control-row caption-row');
      const capBox = el('input');
      capBox.type = 'checkbox';
      capBox.checked = !!state.captions;
      capBox.title = "Burn the video's own YouTube caption track into each tile";
      capBox.addEventListener('change', () => { state.captions = capBox.checked; });
      capRow.appendChild(capBox);
      const langSelect = el('select', 'caption-lang');
      langSelect.title = 'Caption track to burn in';
      const autoOpt = el('option', '', 'Auto (best available)');
      autoOpt.value = '';
      langSelect.appendChild(autoOpt);
      langSelect.value = state.captionLang || '';
      langSelect.addEventListener('change', () => { state.captionLang = langSelect.value; });
      capRow.appendChild(langSelect);
      const statusSpan = el('span', 'hint', 'loading tracks…');
      capRow.appendChild(statusSpan);
      secCap.appendChild(capRow);

      // Subtitle download row (YouTube only)
      const subRow = el('div', 'control-row caption-row');
      subRow.appendChild(el('span', 'hint', 'Download track:'));
      const fmtSelect = el('select', 'num-input');
      fmtSelect.title = 'Subtitle format';
      for (const f of ['srt', 'vtt']) {
        const o = el('option', '', f.toUpperCase());
        o.value = f;
        fmtSelect.appendChild(o);
      }
      subRow.appendChild(fmtSelect);
      const dlBtn = el('button', 'btn btn-sm', 'Download subtitles');
      dlBtn.type = 'button';
      dlBtn.addEventListener('click', async () => {
        const lang = langSelect.value || state.captionLang || '';
        const fmt = fmtSelect.value;
        const ep = (d.type === 'series') ? (primaryEpisode() || 0) : 0;
        const url = `/api/subtitles?provider=${encodeURIComponent(state.providerId)}&id=${encodeURIComponent(d.id)}&episode=${ep}&lang=${encodeURIComponent(lang)}&format=${fmt}`;
        await downloadUrl(url, `subtitles.${fmt}`);
      });
      subRow.appendChild(dlBtn);
      secCap.appendChild(subRow);

      loadCaptionTracks(langSelect, statusSpan);
    }

    // Runtime is probed once to drive the auto-calculation.
    if (state.durationKey !== detailDurationKey()) {
      state.duration = 0;
      state.durationLabel = '';
    }
    const planState = { ivInput, perInput, sheetsInput, planHint };
    state._planInputs = planState;
    updatePlan();

    if (d.type === 'series') {
      const selLabel = el('label', 'section-hint', '');
      const setSel = () => {
        const nums = [...state.selected].sort((a, b) => a - b);
        selLabel.textContent = 'Episodes — click to select one or more'
          + (nums.length ? ` (selected: ${nums.join(', ')})` : ' (none selected)');
      };
      setSel();
      secSetup.appendChild(selLabel);
      const grid = el('div', 'ep-grid');
      for (const ep of currentEpisodes()) {
        const c = el('button', 'ep-chip' + (state.selected.has(ep.number) ? ' active' : ''), String(ep.number));
        c.type = 'button';
        c.title = ep.title || `Episode ${ep.number}`;
        c.addEventListener('click', () => {
          if (state.selected.has(ep.number)) {
            state.selected.delete(ep.number);
            if (state.focusEp === ep.number) state.focusEp = 0;
          } else {
            state.selected.add(ep.number);
            state.focusEp = ep.number;
          }
          setSel();
          c.classList.toggle('active');
          state.durationKey = ''; state.duration = 0;
          updatePlan();
          ensureDuration();
        });
        grid.appendChild(c);
      }
      secSetup.appendChild(grid);
    }

    // actions
    const quick = el('div', 'quick-actions');
    if (d.type === 'series') {
      for (const n of [1, 2]) {
        const b = el('button', 'btn btn-sm', `Episode ${n}`);
        b.type = 'button';
        b.addEventListener('click', () => queueEpisodes([n], `ep${n}`));
        quick.appendChild(b);
      }
      const customRow = el('div', 'custom-row');
      const nInput = el('input');
      nInput.type = 'number'; nInput.min = '1'; nInput.value = '3';
      nInput.title = 'Episode number';
      const nBtn = el('button', 'btn btn-sm', 'Episode N');
      nBtn.type = 'button';
      nBtn.addEventListener('click', () => {
        const n = Number(nInput.value);
        if (!n || n < 1) return toast('Enter a valid episode number');
        queueEpisodes([n], 'custom');
      });
      customRow.appendChild(nInput);
      customRow.appendChild(nBtn);
      quick.appendChild(customRow);
      const all = el('button', 'btn btn-sm', `All episodes (S${String(state.season).padStart(2, '0')})`);
      all.type = 'button';
      all.addEventListener('click', () => {
        const nums = currentEpisodes().map(e => e.number);
        queueEpisodes(nums, 'all');
      });
      quick.appendChild(all);
      if (d.seasons.length > 1) {
        const allSeasons = el('button', 'btn btn-sm', 'All episodes · every season');
        allSeasons.type = 'button';
        allSeasons.addEventListener('click', () => {
          const items = [];
          for (const s of d.seasons) for (const e of (s.episodes || [])) items.push({ season: s.season, episode: e.number });
          queueItems(items, 'all-seasons');
        });
        quick.appendChild(allSeasons);
      }
      const selBtn = el('button', 'btn btn-primary btn-sm', 'Create for selected');
      selBtn.type = 'button';
      selBtn.addEventListener('click', () => {
        const nums = [...state.selected].sort((a, b) => a - b);
        if (!nums.length) return toast('Select at least one episode');
        queueEpisodes(nums, 'selected');
      });
      quick.appendChild(selBtn);
    } else {
      const b = el('button', 'btn btn-primary', 'Create contact sheet (whole movie)');
      b.type = 'button';
      b.addEventListener('click', () => queueItems([{ season: 0, episode: 0 }], 'movie'));
      quick.appendChild(b);
    }
    const preview = el('button', 'btn btn-ghost btn-sm', 'Preview stream URL');
    preview.type = 'button';
    preview.addEventListener('click', previewStream);
    quick.appendChild(preview);
    secCreate.appendChild(quick);

    // Window sheets: a time period around a fixed timestamp, with its own interval / per-sheet / sheets.
    const mkTxt = (key, placeholder, title) => {
      const inp = el('input');
      inp.type = 'text';
      inp.placeholder = placeholder;
      inp.title = title;
      inp.value = state[key];
      inp.className = 'num-input wide';
      inp.addEventListener('input', () => {
        state[key] = inp.value;
        updateWindowPlan();
        if (!state.duration) ensureDuration();
      });
      return inp;
    };
    const winRow = el('div', 'control-row plan-row win-row');
    winRow.appendChild(mkTxt('wCenter', 'around 2:44:30', 'Fixed timestamp — seconds, mm:ss or hh:mm:ss'));
    winRow.appendChild(el('span', 'hint', 'from'));
    winRow.appendChild(mkTxt('wBefore', '300', 'Seconds before the timestamp'));
    winRow.appendChild(el('span', 'hint', 's before ·'));
    winRow.appendChild(mkTxt('wAfter', '55', 'Seconds after the timestamp'));
    winRow.appendChild(el('span', 'hint', 's after'));
    secWin.appendChild(winRow);

    const winPlanRow = el('div', 'control-row plan-row win-row');
    winPlanRow.appendChild(el('label', '', 'Window plan'));
    const wIv = mkNum('wInterval', 'every … s', 'Seconds between snapshots inside the window', '', updateWindowPlan);
    const wPer = mkNum('wPerSheet', 'images', 'Images per window contact sheet (max 60)', '', updateWindowPlan);
    const wSh = mkNum('wSheets', 'sheets', 'How many window contact sheets', '', updateWindowPlan);
    const wHint = el('span', 'hint plan-hint', 'pick any two — the third is auto');
    winPlanRow.appendChild(wIv);
    winPlanRow.appendChild(el('span', 'hint', 's'));
    winPlanRow.appendChild(wPer);
    winPlanRow.appendChild(el('span', 'hint', 'per sheet'));
    winPlanRow.appendChild(wSh);
    winPlanRow.appendChild(el('span', 'hint', 'sheets'));
    const winBtn = el('button', 'btn btn-primary btn-sm', d.type === 'series' ? 'Window for selected' : 'Create window sheet');
    winBtn.type = 'button';
    winBtn.addEventListener('click', () => {
      const c = parseTime(state.wCenter, NaN);
      if (!Number.isFinite(c)) return toast('Enter the timestamp to centre the window on (e.g. 2:44:30)');
      const before = Math.max(0, parseTime(state.wBefore, 60));
      const after = Math.max(0, parseTime(state.wAfter, 60));
      if (before + after < 1) return toast('Window is empty — set seconds before/after');
      const k = readPlan(state._winInputs, true);
      const spec = {
        center: c, before, after,
        interval: k.interval || undefined, perSheet: k.perSheet || undefined, sheets: k.sheets || undefined,
      };
      let items;
      if (d.type === 'series') {
        const nums = [...state.selected].sort((a, b) => a - b);
        if (!nums.length) return toast('Select at least one episode');
        items = nums.map(n => ({ season: state.season, episode: n }));
      } else {
        items = [{ season: 0, episode: 0 }];
      }
      queueItems(items, 'window', { window: spec });
    });
    winPlanRow.appendChild(winBtn);
    winPlanRow.appendChild(wHint);
    secWin.appendChild(winPlanRow);
    state._winInputs = { ivInput: wIv, perInput: wPer, sheetsInput: wSh, planHint: wHint };
    updateWindowPlan();

    // Clip download: timestamp + duration, for any movie/episode
    const clipRow = el('div', 'control-row clip-row');
    const startInput = el('input');
    startInput.type = 'text';
    startInput.placeholder = 'start 0:00';
    startInput.title = 'Start time — seconds (125) or mm:ss (2:05) or hh:mm:ss';
    startInput.value = state.clipStart;
    startInput.className = 'num-input wide';
    startInput.addEventListener('input', () => { state.clipStart = startInput.value; });
    const durInput = el('input');
    durInput.type = 'text';
    durInput.placeholder = 'duration 30s';
    durInput.title = 'Clip length in seconds (max 900)';
    durInput.value = state.clipDuration;
    durInput.className = 'num-input';
    durInput.addEventListener('input', () => { state.clipDuration = durInput.value; });
    const clipBtn = el('button', 'btn btn-sm', 'Download clip');
    clipBtn.type = 'button';
    clipBtn.addEventListener('click', () => downloadClip(startInput, durInput));
    clipRow.appendChild(startInput);
    clipRow.appendChild(durInput);
    clipRow.appendChild(clipBtn);
    clipRow.appendChild(el('span', 'hint', 'mp4 · the selected episode, or E1'));
    secClip.appendChild(clipRow);

    const streamBox = el('div', 'stream-box hidden');
    streamBox.id = 'streamBox';
    secClip.appendChild(streamBox);

    // Subtitle download: every track the provider offers, as .srt or .vtt
    if (secSubs) {
      const subRow = el('div', 'control-row');
      let epInput = null;
      if (d.type === 'series') {
        subRow.appendChild(el('label', '', 'Episode'));
        epInput = el('input');
        epInput.type = 'number';
        epInput.min = '1';
        epInput.value = String(state.focusEp || 1);
        epInput.title = 'Episode number for the subtitle tracks';
        epInput.className = 'num-input';
        epInput.addEventListener('change', loadSubtitleTracks);
        subRow.appendChild(epInput);
      }
      const reloadBtn = el('button', 'btn btn-sm', 'Reload tracks');
      reloadBtn.type = 'button';
      reloadBtn.addEventListener('click', loadSubtitleTracks);
      subRow.appendChild(reloadBtn);
      subRow.appendChild(el('span', 'hint', 'one file per language the provider offers'));
      secSubs.appendChild(subRow);
      const subList = el('div', 'sub-list');
      secSubs.appendChild(subList);

      async function loadSubtitleTracks() {
        const season = d.type === 'series' ? Number(state.season) || 1 : 0;
        const episode = d.type === 'series' ? Math.max(1, Number(epInput.value) || 1) : 0;
        subList.innerHTML = '';
        const wait = el('div', 'hint', 'loading subtitle tracks…');
        subList.appendChild(wait);
        try {
          const res = await api(`/api/captions?provider=${encodeURIComponent(state.providerId)}`
            + `&id=${encodeURIComponent(d.id)}&season=${season}&episode=${episode}`);
          subList.innerHTML = '';
          const tracks = res.tracks || [];
          if (!tracks.length) {
            subList.appendChild(el('div', 'hint', 'this provider offers no subtitle files for this title'));
            return;
          }
          for (const t of tracks) {
            const line = el('div', 'sub-row');
            const name = el('span', 'sub-name', t.label || t.lang || 'Unknown');
            name.title = t.source ? `source: ${t.source}` : '';
            line.appendChild(name);
            if (t.isDefault) line.appendChild(el('span', 'chip strong', 'default'));
            if (t.isAI) line.appendChild(el('span', 'chip', 'AI'));
            const base = `${(d.title || 'subtitle').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.${t.label || t.lang}`.slice(0, 80);
            for (const fmt of ['srt', 'vtt']) {
              const b = el('button', 'btn btn-sm', fmt.toUpperCase());
              b.type = 'button';
              b.title = `Download this track as .${fmt}`;
              b.addEventListener('click', () => downloadUrl(
                `/api/subtitles?provider=${encodeURIComponent(state.providerId)}`
                + `&id=${encodeURIComponent(d.id)}&season=${season}&episode=${episode}`
                + `&lang=${encodeURIComponent(t.lang || t.label || '')}&format=${fmt}`
                + `&name=${encodeURIComponent(base)}`,
                `${base}.${fmt}`));
              line.appendChild(b);
            }
            subList.appendChild(line);
          }
        } catch (e) {
          subList.innerHTML = '';
          subList.appendChild(el('div', 'hint', 'no subtitle tracks: ' + e.message));
        }
      }
      loadSubtitleTracks();
    }
    body.appendChild(controls);

    // Auto-detect runtime so the sheet plan can fill in the third value.
    ensureDuration();
  }

  async function loadCaptionTracks(select, statusSpan) {
    const d = state.detail;
    if (!d || !select) return;
    const ep = (d.type === 'series') ? (primaryEpisode() || 0) : 0;
    try {
      const res = await api(`/api/captions?provider=${encodeURIComponent(state.providerId)}&id=${encodeURIComponent(d.id)}&episode=${ep}`);
      const tracks = res.tracks || [];
      select.innerHTML = '';
      const autoOpt = el('option', '', 'Auto (best available)');
      autoOpt.value = '';
      select.appendChild(autoOpt);
      const manualTracks = tracks.filter(t => t.source === 'manual');
      const autoTracks = tracks.filter(t => t.source === 'auto');
      if (manualTracks.length) {
        const g = el('optgroup', '');
        g.label = 'Manual';
        for (const t of manualTracks) {
          const opt = el('option', '', t.label.replace(' (manual)', ''));
          opt.value = `${t.lang}::${t.source}`;
          g.appendChild(opt);
        }
        select.appendChild(g);
      }
      if (autoTracks.length) {
        const g = el('optgroup', '');
        g.label = 'Auto-generated';
        for (const t of autoTracks) {
          const opt = el('option', '', t.label.replace(' (auto)', ''));
          opt.value = `${t.lang}::${t.source}`;
          g.appendChild(opt);
        }
        select.appendChild(g);
      }
      // Normalize a previously stored plain lang ("en") to a concrete track.
      let wanted = state.captionLang || '';
      if (wanted && !wanted.includes('::')) {
        const match = tracks.find(t => t.lang.toLowerCase() === wanted.toLowerCase()
          || t.lang.toLowerCase().startsWith(wanted.toLowerCase() + '-'));
        if (match) wanted = `${match.lang}::${match.source}`;
        else wanted = '';
      }
      if (wanted && [...select.options].some(o => o.value === wanted)) {
        select.value = wanted;
        state.captionLang = wanted;
      } else {
        select.value = '';
        state.captionLang = '';
      }
      if (statusSpan) {
        const m = manualTracks.length, a = autoTracks.length;
        statusSpan.textContent = tracks.length
          ? `${m} manual, ${a} auto-generated`
          : 'no captions on this video';
      }
    } catch (e) {
      if (statusSpan) statusSpan.textContent = 'could not load tracks: ' + e.message;
    }
  }

  function parseTime(value, fallback = 0) {
    if (value == null || value === '') return fallback;
    const s = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    const parts = s.split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return fallback;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  /* Clip download now runs as a job so progress is visible in the jobs panel;
     when the job finishes the mp4 is auto-saved by the browser. */
  async function downloadClip(startInput, durInput) {
    const d = state.detail;
    if (!d) return;
    const ep = primaryEpisode();
    const start = parseTime(startInput.value, 0);
    const duration = Math.min(900, Math.max(1, parseTime(durInput.value, 30)));
    const body = {
      provider: state.providerId, id: d.id, title: d.title, type: d.type,
      season: state.season, episode: ep, start, duration,
      quality: state.quality || null,
      items: [{ season: state.season, episode: ep }],
    };
    try {
      const res = await api('/api/clips', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      state.pendingClipDownloads.add(res.job.id);
      toast(`Clip queued (${fmtClock(start)} +${duration}s) — progress below`, true);
      loadJobs();
      document.getElementById('jobsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      toast('Could not queue clip: ' + e.message);
    }
  }

  /* Download a file via fetch + blob URL. More reliable than the `download`
     attribute alone: we get a real HTTP status, can surface a clear error, and
     avoid Chrome's "file isn't available on the site" for large/range-served
     files like the contact-sheet PDFs. */
  async function downloadUrl(url, filename) {
    if (!url) return;
    const name = filename || (url.split('/').pop().split('?')[0]) || 'download';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
      toast(`Saved ${name}`, true);
      return;
    } catch (e) {
      toast('Download failed: ' + e.message + ' — opening in a new tab instead');
      try { window.open(url, '_blank', 'noopener'); } catch {}
    }
  }

  /* Save a finished clip or PDF: browser download via fetch + blob. */
  function saveDownload(file, fallback = 'download') {
    if (!file || !file.url) return;
    const name = (file.path || file.url).split('/').pop().split('?')[0] || fallback;
    downloadUrl(file.url, name);
  }

  function fmtClock(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
  }

  async function previewStream() {
    const d = state.detail;
    const box = $('#streamBox');
    if (!d) return;
    const ep = primaryEpisode();
    box.classList.remove('hidden');
    box.textContent = 'Resolving…';
    try {
      const q = state.quality ? `&quality=${state.quality}` : '';
      const res = await api(`/api/streams?provider=${encodeURIComponent(state.providerId)}&id=${encodeURIComponent(d.id)}&season=${state.season}&episode=${ep}${q}`);
      const s = (res.streams || [])[0];
      box.textContent = s ? `${s.quality || '?'}p ${s.format || ''} · ${s.server || ''}\n${s.url}` : 'No stream returned';
    } catch (e) { box.textContent = 'Error: ' + e.message; }
  }

  function queueEpisodes(nums, mode) {
    const items = nums.map(n => ({ season: state.season, episode: n }));
    queueItems(items, mode);
  }

  async function queueItems(items, mode, extra = {}) {
    const d = state.detail;
    if (!d) return;
    try {
      // Only values the person typed are sent; auto-filled ones are derived server-side.
      const plan = extra.window ? { interval: 0, perSheet: 0, sheets: 0 } : readPlanValues(true);
      const body = {
        provider: state.providerId, id: d.id, title: d.title, type: d.type,
        season: state.season, items, episodes: items.map(x => x.episode),
        quality: state.quality || null, mode,
        interval: plan.interval || undefined,
        perSheet: plan.perSheet || undefined,
        sheets: plan.sheets || undefined,
        ...(state.captions && state.providerId === 'youtube'
          ? { captions: true, captionLang: state.captionLang || undefined }
          : {}),
        ...extra,
      };
      const res = await api('/api/jobs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      // An old server silently drops fields it does not know: detect that from the echo.
      if (res.job && (!('wantSheets' in res.job) || (extra.window && !res.job.window))) {
        showBanner('The server ignored part of this request \u2014 it is running OLD code. Run terminate.bat, then start.bat, then press Ctrl+F5.');
      }
      toast(`Queued ${items.length} episode(s) for ${d.title}${extra.window ? ' (window)' : ''}`, true);
      loadJobs();
    } catch (e) { toast('Could not queue: ' + e.message); }
  }

  /* ---------------- jobs ---------------- */
  async function loadJobs() {
    try {
      const { jobs } = await api('/api/jobs');
      state.jobs = jobs;
      renderJobs();
      // Auto-save clips the user asked for via the Download clip button.
      for (const j of jobs) {
        if (!state.pendingClipDownloads.has(j.id)) continue;
        if (j.status === 'done' && j.clips && j.clips.length) {
          state.pendingClipDownloads.delete(j.id);
          saveDownload(j.clips[0], 'clip.mp4');
          toast(`Clip ready — saving ${(j.clips[0].bytes / 1e6).toFixed(1)} MB`, true);
        } else if (j.status === 'failed' || j.status === 'cancelled') {
          state.pendingClipDownloads.delete(j.id);
          toast('Clip failed: ' + (j.message || 'unknown error'));
        }
      }
      for (const j of jobs) {
        if (!state.pendingPdfDownloads.has(j.id)) continue;
        if (j.status === 'done' && j.pdfs && j.pdfs.length) {
          state.pendingPdfDownloads.delete(j.id);
          saveDownload(j.pdfs[0], 'frames.pdf');
          toast(`PDF ready — saving ${(j.pdfs[0].bytes / 1e6).toFixed(1)} MB`, true);
        } else if (j.status === 'failed' || j.status === 'cancelled') {
          state.pendingPdfDownloads.delete(j.id);
          toast('PDF failed: ' + (j.message || 'unknown error'));
        }
      }
    } catch (e) { /* transient */ }
  }

  /* Shared handler for Cancel/Remove clicks. A 404 means the job id only
     existed in a previous server run (the server restarted since the page
     was rendered) — say so and refresh the panel instead of failing. */
  async function jobAction(j, action, okToast) {
    try {
      await api(`/api/jobs/${j.id}/${action}`, { method: 'POST' });
      if (okToast) toast(okToast, true);
    } catch (e) {
      if (/404|not found/i.test(e.message)) {
        toast(`"${j.title}" is from an earlier server run — it is already gone. Refreshing the panel.`);
      } else {
        toast(`Could not ${action}: ` + e.message);
      }
    }
    loadJobs();
  }

  async function removeJob(j) {
    const running = j.status === 'running' || j.status === 'queued';
    const label = j.title + (j.items && j.items.length && j.type === 'series'
      ? ` (${j.items.map(x => `S${String(x.season).padStart(2, '0')}E${String(x.episode).padStart(2, '0')}`).join(', ')})` : '');
    const msg = running
      ? `Cancel "${label}" and remove it from the panel?\n(It is still running, so its files are kept.)`
      : `Remove "${label}" from the panel and delete its generated files from disk?`;
    if (!window.confirm(msg)) return;
    await jobAction(j, 'remove', `Removed ${j.title}`);
  }

  function windowLabel(j) {
    const w = (j.plan && j.plan.window) || j.window;
    if (!w) return '';
    if (w.startLabel) return `window ${w.startLabel}\u2013${w.endLabel}`;
    if (w.center != null) return `window ${fmtClock(w.center)} (\u2212${w.before}s/+${w.after}s)`;
    return `window ${fmtClock(w.start)}\u2013${fmtClock(w.end)}`;
  }

  /* ---------------- sheet preview ---------------- */
  function openLightbox(sheet) {
    if (!sheet || !sheet.url) return;
    $('#lbTitle').textContent = sheet.label || 'Contact sheet';
    const bits = [
      sheet.durationLabel,
      sheet.cols && sheet.rows ? `${sheet.cols}×${sheet.rows} tiles` : '',
      sheet.count ? `${sheet.count} frames` : '',
      sheet.captions && sheet.captions.cues
        ? `captions ${sheet.captions.lang} · ${sheet.captions.cues} cues` : '',
    ].filter(Boolean);
    $('#lbMeta').textContent = bits.join(' · ');
    $('#lbImg').src = sheet.url;
    const dl = $('#lbDownload');
    dl.href = sheet.url;
    dl.download = (sheet.path || sheet.url).split('/').pop() || 'contact-sheet.jpg';
    $('#lbOpen').href = sheet.url;
    $('#lightbox').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    $('#lightbox').classList.add('hidden');
    $('#lbImg').removeAttribute('src');
    document.body.style.overflow = '';
  }
  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLightbox(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLightbox();
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)
      && document.getElementById('lightbox').classList.contains('hidden')) {
      e.preventDefault();
      $('#query').focus();
    }
  });

  function renderJobs() {
    const box = $('#jobs');
    const jobs = state.jobs || [];
    const sum = { running: 0, done: 0, failed: 0 };
    for (const j of jobs) {
      if (j.status === 'running' || j.status === 'queued') sum.running++;
      else if (j.status === 'done') sum.done++;
      else if (j.status === 'failed' || j.status === 'cancelled') sum.failed++;
    }
    const sumBox = $('#jobSummary');
    if (sumBox) {
      sumBox.innerHTML = '';
      if (!jobs.length) {
        sumBox.appendChild(el('span', 'sum-item', 'idle'));
      } else {
        if (sum.running) sumBox.appendChild(el('span', 'sum-item running', `${sum.running} running`));
        sumBox.appendChild(el('span', 'sum-item done', `${sum.done} done`));
        if (sum.failed) sumBox.appendChild(el('span', 'sum-item failed', `${sum.failed} failed`));
      }
    }

    /* Re-rendering every 2.5 s re-downloads thumbnails and drops hover/focus.
       Rebuild only when something shown on the card actually changed. */
    const sig = JSON.stringify(jobs.map(j => [j.id, j.status, j.progress, j.message,
      (j.sheets || []).length, (j.pdfs || []).length, (j.errors || []).length]));
    if (state._jobsSig === sig) return;
    state._jobsSig = sig;

    box.innerHTML = '';
    if (!jobs.length) {
      box.innerHTML = '<div class="empty" style="padding:34px"><p>No jobs yet. Pick a title and create a sheet, clip or PDF.</p></div>';
      return;
    }
    for (const j of jobs) {
      const card = el('div', 'job');
      const head = el('div', 'job-head');
      const main = el('div', 'job-main');
      main.appendChild(el('div', 'job-title', j.title || 'Untitled'));
      const meta = el('div', 'job-meta');
      const chips = [];
      if (j.kind === 'clip') chips.push(['clip', 'strong']);
      if (j.kind === 'pdf') chips.push([`pdf · ${j.fps} fps · ${j.frameWidth}px`, 'strong']);
      if (j.kind === 'pdf' && j.pdfs && j.pdfs[0]) chips.push([`${j.pdfs[0].pages.toLocaleString()} pages`, 'good']);
      if (j.providerName) chips.push([j.providerName, '']);
      if (j.repo) chips.push([j.repo, '']);
      if (j.items && j.items.length) {
        chips.push([j.type === 'series'
          ? j.items.map(x => `S${String(x.season).padStart(2, '0')}E${String(x.episode).padStart(2, '0')}`).join(', ')
          : 'Movie', '']);
      }
      const win = windowLabel(j);
      if (win) chips.push([win, '']);
      if (j.interval) chips.push([`every ${j.interval}s`, '']);
      if (j.kind !== 'clip' && j.perSheet) chips.push([`${j.perSheet}/sheet`, '']);
      if (j.kind !== 'clip' && j.wantSheets) chips.push([`${j.wantSheets} sheet${j.wantSheets === 1 ? '' : 's'}`, '']);
      if (j.kind !== 'clip' && j.captions) {
        if (j.captionsInfo && j.captionsInfo.cues) {
          chips.push([`captions ${j.captionsInfo.lang} · ${j.captionsInfo.cues} cues`, 'good']);
        } else if (j.captionsInfo && j.captionsInfo.error) {
          const msg = String(j.captionsInfo.error);
          const label = /429|Too Many/i.test(msg) ? 'captions rate-limited (429)' : 'captions unavailable';
          chips.push([label, '']);
        } else {
          chips.push(['captions on', '']);
        }
      }
      if (j.kind === 'clip' && j.clips && j.clips.length) {
        chips.push([j.clips.map(c => `${fmtClock(c.start)} +${Math.round(c.duration)}s`).join(', '), '']);
      }
      for (const [text, cls] of chips) meta.appendChild(el('span', 'chip' + (cls ? ' ' + cls : ''), text));
      main.appendChild(meta);

      const right = el('div', 'job-right');
      right.appendChild(el('span', 'job-state ' + j.status, j.status));
      if (j.kind === 'clip' && j.status === 'done' && j.clips && j.clips.length) {
        const sv = el('a', 'btn btn-sm', 'Save mp4');
        sv.href = j.clips[0].url;
        sv.download = (j.clips[0].path || j.clips[0].url).split('/').pop() || 'clip.mp4';
        sv.title = 'Save the clip again';
        right.appendChild(sv);
      }
      if (j.kind === 'pdf' && j.status === 'done' && j.pdfs && j.pdfs.length) {
        const sv = el('a', 'btn btn-sm', 'Save PDF');
        sv.href = j.pdfs[0].url;
        sv.download = (j.pdfs[0].path || j.pdfs[0].url).split('/').pop() || 'frames.pdf';
        sv.title = 'Save the PDF again';
        right.appendChild(sv);
      }
      if (j.status === 'running' || j.status === 'queued') {
        const c = el('button', 'btn btn-sm btn-danger', 'Cancel');
        c.type = 'button';
        c.addEventListener('click', () => jobAction(j, 'cancel'));
        right.appendChild(c);
      }
      const rm = el('button', 'btn btn-sm btn-ghost remove-btn', 'Remove');
      rm.type = 'button';
      rm.title = 'Remove this entry (finished jobs also delete their files)';
      rm.addEventListener('click', () => removeJob(j));
      right.appendChild(rm);
      right.appendChild(el('span', 'hint', fmtDate(j.createdAt)));
      head.appendChild(main); head.appendChild(right);
      card.appendChild(head);

      const bar = el('div', 'progress');
      const fill = el('span');
      fill.style.width = `${j.progress || 0}%`;
      bar.appendChild(fill);
      card.appendChild(bar);

      const msg = el('div', 'job-msg');
      msg.appendChild(el('span', '', j.message || ''));
      msg.appendChild(el('span', 'pct', `${j.progress || 0}%`));
      card.appendChild(msg);

      if (j.sheets && j.sheets.length) {
        const list = el('div', 'job-sheets');
        for (const s of j.sheets) {
          const sc = el('div', 'sheet-card');
          const img = el('img');
          img.src = s.url;
          img.alt = s.label || 'Contact sheet';
          img.loading = 'lazy';
          img.title = 'Click to preview';
          img.addEventListener('click', () => openLightbox(s));
          sc.appendChild(img);
          const dl = el('a', 'sheet-dl', '↓ JPG');
          dl.href = s.url;
          dl.download = (s.path || s.url).split('/').pop() || 'contact-sheet.jpg';
          dl.title = 'Download this sheet';
          dl.addEventListener('click', (e) => { e.preventDefault(); downloadUrl(dl.href, dl.download); });
          sc.appendChild(dl);
          const sb = el('div', 'sheet-bar');
          sb.appendChild(el('span', '', s.label || 'sheet'));
          sb.appendChild(el('span', '', s.durationLabel || ''));
          sc.appendChild(sb);
          list.appendChild(sc);
        }
        card.appendChild(list);
      }
      if (j.sheets && j.sheets.length) {
        const zipBtn = el('a', 'btn btn-sm btn-ghost', `Download all ${j.sheets.length} as ZIP`);
        zipBtn.href = `/api/jobs/${encodeURIComponent(j.id)}/zip`;
        zipBtn.download = `${(j.title || 'contact-sheets').replace(/[^\w.\- ]+/g, '_').trim()}.zip`;
        zipBtn.title = 'Download every contact sheet in this job as one zip file';
        zipBtn.addEventListener('click', (e) => { e.preventDefault(); downloadUrl(zipBtn.href, zipBtn.download); });
        zipBtn.style.marginTop = '2px';
        card.appendChild(zipBtn);
      }
      if (j.pdfs && j.pdfs.length) {
        const list = el('div', 'job-sheets');
        for (const pdf of j.pdfs) {
          const a = el('a', 'pdf-card');
          a.href = pdf.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.download = (pdf.path || pdf.url).split('/').pop() || 'frames.pdf';
          a.title = 'Open or save this PDF';
          a.addEventListener('click', (e) => { e.preventDefault(); downloadUrl(a.href, a.download); });
          a.appendChild(el('span', 'pdf-badge', 'PDF'));
          const txt = el('div');
          txt.appendChild(el('strong', '', `${pdf.pages.toLocaleString()} pages`));
          txt.appendChild(el('span', 'hint', `${pdf.fps} fps · ${pdf.width}px · ${(pdf.bytes / 1e6).toFixed(1)} MB`));
          a.appendChild(txt);
          list.appendChild(a);
        }
        card.appendChild(list);
      }
      if (j.errors && j.errors.length) {
        const e = el('div', 'job-errors', `${j.errors.length} error(s): ` +
          [...new Set(j.errors.map(x => x.message))].slice(0, 2).join(' | '));
        card.appendChild(e);
      }
      box.appendChild(card);
    }
  }

  $('#refreshJobs').addEventListener('click', loadJobs);

  /* ---------------- boot ---------------- */
  (async () => {
    const footer = $('#footerBuild');
    if (footer) footer.textContent = 'ui ' + UI_BUILD;
    try {
      const h = await api('/api/health');
      const pill = $('#health');
      pill.textContent = `online · ${h.providers} providers · ui ${UI_BUILD}`;
      pill.className = 'pill pill-ok';
      if (!h.api || h.api < REQUIRED_API || h.stale) {
        pill.className = 'pill pill-bad';
        showBanner(`This page is newer than the server answering it (pid ${h.pid || '?'}). That server is running OLD code, so Remove/Cancel, sheet plan, episode selection and window sheets will misbehave. Run terminate.bat, then start.bat, then press Ctrl+F5.`);
      }
      if (h.pid) {
        const since = h.startedAt ? new Date(h.startedAt).toLocaleTimeString() : 'unknown';
        pill.title = `server pid ${h.pid}, started ${since}, code from ${h.build}`;
      }
    } catch { /* server may still be starting */ }
    await loadProviders();
    await loadJobs();
    setInterval(loadJobs, 2500);
  })().catch(e => toast('Startup error: ' + e.message));
})();
