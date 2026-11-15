const { request, stripTags } = require('../app/lib/util');
(async () => {
  const url = process.argv[2] || 'https://4khdhub.dad/crayon-shin-chan-action-mask-vs-leotard-devil-movie-2971/';
  const d = await request(url, { headers: { referer: 'https://4khdhub.dad/' } });
  console.log('HTTP', d.status, d.buffer.length);
  const h = d.text;
  const t = stripTags(h);
  const i = t.indexOf('Download');
  console.log('TEXT:', t.slice(Math.max(0, i - 200), i + 1200));
  console.log('\nLINKS:');
  for (const m of h.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const txt = stripTags(m[2]);
    if (/download|hubcloud|hubdrive|greenmotors|gofile|pixel/i.test(txt + ' ' + m[1])) console.log(txt.slice(0, 60), '->', m[1].slice(0, 160));
  }
})().catch(e => { console.error(e); process.exit(1); });
