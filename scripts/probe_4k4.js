const { request, stripTags } = require('../app/lib/util');
(async () => {
  const url = 'https://4khdhub.dad/the-leopard-series-5628/';
  const d = await request(url, { headers: { referer: 'https://4khdhub.dad/' } });
  const h = d.text;
  const idxs = [...h.matchAll(/class="season-item episode-item/g)].map(m => m.index);
  console.log('items', idxs.length, idxs.slice(0, 8));
  const start = idxs[0];
  const seg = h.slice(start, start + 5000).replace(/<svg[\s\S]*?<\/svg>/g, '');
  console.log(seg.replace(/\s+/g, ' ').slice(0, 4000));
})().catch(e => { console.error(e); process.exit(1); });
