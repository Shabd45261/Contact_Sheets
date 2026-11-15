const base = 'http://127.0.0.1:8787';
const j = async (p, o) => {
  const r = await fetch(base + p, o);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 400) }; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const s = await j('/api/search?provider=moviebox-cncverse&q=' + encodeURIComponent('breaking bad'));
  const item = (s.body.items || []).find(x => x.type === 'series');
  console.log('series item', item && item.title, item && item.id);
  const d = await j('/api/detail?provider=moviebox-cncverse&id=' + encodeURIComponent(item.id));
  const det = d.body.detail || {};
  console.log('detail', det.title, det.type, 'qualities', det.qualities);
  console.log('seasons', (det.seasons || []).map(x => `S${x.season}:${(x.episodes || []).length}ep`).join(' '));
  const st = await j(`/api/streams?provider=moviebox-cncverse&id=${encodeURIComponent(item.id)}&season=1&episode=1`);
  console.log('streams', st.status, st.body.streams?.length, st.body.streams?.[0]?.url?.slice(0, 100), st.body.error || '');

  const jobRes = await j('/api/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'moviebox-cncverse', id: item.id, title: det.title, type: 'series',
      season: 1, items: [{ season: 1, episode: 1 }], episodes: [1], quality: null, mode: 'ep1',
    }),
  });
  console.log('job create', jobRes.status, jobRes.body.job?.id, jobRes.body.error || '');
  const id = jobRes.body.job?.id;
  if (!id) return;
  for (let i = 0; i < 300; i++) {
    await sleep(2000);
    const r = await j('/api/jobs/' + id);
    const job = r.body.job;
    if (!job) { console.log('job lost'); break; }
    if (i % 3 === 0 || job.status === 'done' || job.status === 'failed') console.log(job.status, job.progress + '%', job.phase, '-', job.message);
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      console.log('sheets', JSON.stringify(job.sheets, null, 1).slice(0, 800));
      console.log('errors', JSON.stringify(job.errors).slice(0, 600));
      break;
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
