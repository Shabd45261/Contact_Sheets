const base = 'http://127.0.0.1:8787';
const j = async (p, o) => {
  const r = await fetch(base + p, o);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200) }; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function roundtrip(label, provider, query) {
  const t0 = Date.now();
  const s = await j(`/api/search?provider=${provider}&q=${encodeURIComponent(query)}`);
  const items = (s.body.items || []);
  const item = items.find(x => x.type === 'series') || items[0];
  if (!item) return console.log(`\n[${label}] SEARCH FAIL ${s.status}`, s.body.error || items.length);
  const d = await j(`/api/detail?provider=${provider}&id=${encodeURIComponent(item.id)}`);
  const det = d.body.detail || {};
  const season = det.type === 'series' ? (det.seasons?.[0]?.season ?? 1) : 0;
  const ep = det.type === 'series' ? 1 : 0;
  const st = await j(`/api/streams?provider=${provider}&id=${encodeURIComponent(item.id)}&season=${season}&episode=${ep}`);
  const streams = st.body.streams || [];
  console.log(`\n[${label}] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('  search   ', s.status, items.length, 'results');
  console.log('  detail   ', d.status, '|', det.title, '|', det.type, '| q:', det.qualities, '| seasons:', (det.seasons || []).map(x => `S${x.season}:${(x.episodes || []).length}`).join(','));
  console.log('  streams  ', st.status, streams.length, streams[0] ? `${streams[0].quality}p ${streams[0].format || ''} ${streams[0].url.slice(0, 70)}` : (st.body.error || ''));
  return { item, det, streams, season, ep };
}

(async () => {
  const h = await j('/api/health');
  console.log('health', h.status, h.body.providers, 'providers');

  for (const [label, provider] of [['MovieBox phisher', 'moviebox-phisher'], ['MovieBox cncverse', 'moviebox-cncverse'], ['MovieBox IN', 'moviebox-cncverse-in']]) {
    await roundtrip(label, provider, 'inception');
  }

  const mv = await roundtrip('MovieBox series', 'moviebox-cncverse', 'breaking bad');

  const castle = await roundtrip('CastleTV', 'castletv-cncverse', 'breaking bad');

  // one real sheet from Castle to prove the whole path
  if (castle && castle.streams.length) {
    const body = {
      provider: 'castletv-cncverse', id: castle.item.id, title: castle.det.title,
      type: castle.det.type, season: castle.season,
      items: [{ season: castle.season, episode: 1 }], episodes: [1], mode: 'ep1',
    };
    const jr = await j('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const id = jr.body.job?.id;
    console.log('\n[castle job]', jr.status, id, jr.body.error || '');
    for (let i = 0; i < 240 && id; i++) {
      await sleep(2000);
      const r = await j('/api/jobs/' + id);
      const job = r.body.job;
      if (!job) break;
      if (i % 5 === 0 || ['done', 'failed', 'cancelled'].includes(job.status)) {
        console.log('  ', job.status, job.progress + '%', job.phase, '-', job.message);
      }
      if (['done', 'failed', 'cancelled'].includes(job.status)) {
        console.log('   sheets:', JSON.stringify(job.sheets));
        if (job.sheets?.[0]?.url) {
          const img = await fetch(base + job.sheets[0].url);
          console.log('   sheet http', img.status, img.headers.get('content-type'), (await img.arrayBuffer()).byteLength, 'bytes');
        }
        console.log('   errors:', JSON.stringify(job.errors).slice(0, 400));
        break;
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
