const { request } = require('../app/lib/util');
(async () => {
  const url = 'https://4khdhub.dad/crayon-shin-chan-action-mask-vs-leotard-devil-movie-2971/';
  const d = await request(url, { headers: { referer: 'https://4khdhub.dad/' } });
  const h = d.text;
  const i = h.indexOf('Download Links');
  console.log(h.slice(i, i + 2600).replace(/\s+/g, ' '));
})().catch(e => { console.error(e); process.exit(1); });
