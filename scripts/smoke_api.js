const base = 'http://127.0.0.1:8787';
const j = async (p, o) => {
  const r = await fetch(base + p, o);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 300) }; }
};
(async () => {
  console.log('health', await j('/api/health'));
  const prov = await j('/api/providers');
  console.log('providers', prov.status, prov.body.providers?.map(p => p.id));
  const s = await j('/api/search?provider=moviebox-cncverse&q=inception');
  console.log('search', s.status, s.body.items?.length, s.body.ms);
  const item = s.body.items?.find(x => x.type === 'movie') || s.body.items?.[0];
  console.log('item', item && { id: item.id, title: item.title, type: item.type });
  if (!item) return;
  const d = await j('/api/detail?provider=moviebox-cncverse&id=' + encodeURIComponent(item.id));
  const det = d.body.detail || {};
  console.log('detail', d.status, det.title, det.type, 'qualities', det.qualities, 'seasons', (det.seasons || []).map(x => x.season + ':' + (x.episodes || []).length));
  const st = await j(`/api/streams?provider=moviebox-cncverse&id=${encodeURIComponent(item.id)}&season=0&episode=0`);
  console.log('streams', st.status, st.body.streams?.length, st.body.streams?.[0]?.url?.slice(0, 90), st.body.error || '');
})().catch(e => { console.error(e); process.exit(1); });
