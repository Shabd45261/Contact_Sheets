const base = 'http://127.0.0.1:8787';
const j = async (p, o) => {
  const r = await fetch(base + p, o);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200), headers: r.headers }; }
};
const step = async (label, fn) => {
  const t = Date.now();
  try { const r = await fn(); console.log(`\n[${label}] OK ${((Date.now() - t) / 1000).toFixed(1)}s`, r); return r; }
  catch (e) { console.log(`\n[${label}] FAIL ${((Date.now() - t) / 1000).toFixed(1)}s`, e.message); }
};
(async () => {
  await step('sheet url', async () => {
    const r = await fetch(base + '/sheets/extensions/cncverse/contact-sheets/MovieBox/Breaking%20Bad%20%5BHindi%5D/S01E01/contact-sheet.jpg');
    return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
  });

  await step('castle search', async () => {
    const s = await j('/api/search?provider=castletv-cncverse&q=breaking%20bad');
    const it = (s.body.items || [])[0];
    return { status: s.status, count: s.body.items?.length, first: it && [it.title, it.type, it.id] };
  });

  await step('castle detail+stream', async () => {
    const s = await j('/api/search?provider=castletv-cncverse&q=breaking%20bad');
    const it = (s.body.items || []).find(x => x.type === 'series') || (s.body.items || [])[0];
    const d = await j('/api/detail?provider=castletv-cncverse&id=' + encodeURIComponent(it.id));
    const det = d.body.detail || {};
    const st = await j(`/api/streams?provider=castletv-cncverse&id=${encodeURIComponent(it.id)}&season=1&episode=1`);
    return {
      title: det.title, type: det.type,
      seasons: (det.seasons || []).map(x => `S${x.season}:${(x.episodes || []).length}`),
      streams: (st.body.streams || []).slice(0, 3).map(x => [x.quality, x.url.slice(0, 80)]),
      error: st.body.error,
    };
  });

  await step('4khdhub search', async () => {
    const s = await j('/api/search?provider=4khdhub-phisher&q=leopard');
    const it = (s.body.items || [])[0];
    return { status: s.status, count: s.body.items?.length, first: it && [it.title, it.type, it.id] };
  });

  await step('4khdhub detail+stream', async () => {
    const s = await j('/api/search?provider=4khdhub-phisher&q=leopard');
    const it = (s.body.items || [])[0];
    const d = await j('/api/detail?provider=4khdhub-phisher&id=' + encodeURIComponent(it.id));
    const det = d.body.detail || {};
    const st = await j(`/api/streams?provider=4khdhub-phisher&id=${encodeURIComponent(it.id)}&season=1&episode=1`);
    return {
      title: det.title, type: det.type, groups: (det.groups || []).map(g => g.quality + ':' + g.items.length),
      streams: (st.body.streams || []).slice(0, 3).map(x => [x.quality, x.format, x.url.slice(0, 90)]),
      error: st.body.error,
    };
  });

  await step('vegamovies search', async () => {
    const s = await j('/api/search?provider=vegamovies-cncverse&q=misty%20green');
    return { status: s.status, count: s.body.items?.length, total: s.body.total, ms: s.body.ms, first: s.body.items?.[0] };
  });

  await step('vegamovies detail+stream', async () => {
    const url = 'https://vegamovies.lease/download-misty-green-2026-english-full-movie-480p-720p-1080p-web-dl/';
    const d = await j('/api/detail?provider=vegamovies-cncverse&id=' + encodeURIComponent(url));
    const det = d.body.detail || {};
    const st = await j(`/api/streams?provider=vegamovies-cncverse&id=${encodeURIComponent(url)}&season=0&episode=0`);
    return {
      title: det.title, type: det.type, qualities: det.qualities,
      groups: (det.groups || []).map(g => g.quality + ':' + g.servers.length),
      streams: (st.body.streams || []).map(x => [x.quality, x.url.slice(0, 90)]),
      error: st.body.error,
    };
  });
})().catch(e => { console.error(e); process.exit(1); });
