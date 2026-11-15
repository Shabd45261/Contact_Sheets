const { request, stripTags } = require('../app/lib/util');
(async () => {
  const url = 'https://4khdhub.dad/the-leopard-series-5628/';
  const d = await request(url, { headers: { referer: 'https://4khdhub.dad/' } });
  const h = d.text;
  const start = h.indexOf('episodes-list');
  const seg = h.slice(start, start + 6000);
  console.log(seg.replace(/\s+/g, ' ').slice(0, 4000));
})().catch(e => { console.error(e); process.exit(1); });
