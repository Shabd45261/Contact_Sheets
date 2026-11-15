const { request, stripTags } = require('../app/lib/util');
(async () => {
  const r = await request('https://4khdhub.dad/?s=leo', { headers: { referer: 'https://4khdhub.dad/' } });
  console.log('HTTP', r.status, r.buffer.length);
  const h = r.text;
  const cards = [...h.matchAll(/<a href="([^"]+)" class="movie-card"[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  console.log('cards', cards.length);
  for (const c of cards.slice(0, 8)) {
    const meta = [...c[3].matchAll(/<span class="movie-card-format">([^<]+)<\/span>/g)].map(m => m[1]);
    console.log(c[1], '|', c[2], '|', meta.join(', '));
  }
  if (cards[0]) {
    const url = new URL(cards[0][1], 'https://4khdhub.dad').toString();
    const d = await request(url, { headers: { referer: 'https://4khdhub.dad/' } });
    console.log('\nDETAIL', url, d.status, d.buffer.length);
    const t = stripTags(d.text);
    console.log(t.slice(0, 400));
    const h3s = [...d.text.matchAll(/<h[23][^>]*>([\s\S]{0,200}?)<\/h[23]>/g)].map(m => stripTags(m[1])).filter(Boolean);
    console.log('HEADINGS', h3s.slice(0, 25));
  }
})().catch(e => { console.error(e); process.exit(1); });
