const { request } = require('C:/HostDrives/D/Cloudstream/app/lib/util.js');

(async () => {
  const base = 'https://vegamovies.lease';
  const HDRS = { referer: base + '/', 'accept-language': 'en-US,en;q=0.9' };
  const idx = await request(base + '/sitemap_index.xml', { headers: { ...HDRS } });
  const all = [...idx.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
  const maps = all.filter(u => /post-sitemap\d*\.xml$/i.test(u));
  console.log('maps', maps.length);
  let urls = 0;
  for (const [i, m] of maps.entries()) {
    try {
      const r = await request(m, { headers: { ...HDRS } });
      const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].length;
      urls += locs;
      console.log(i + 1, m.split('/').pop(), 'status', r.status, 'len', r.text.length, 'locs', locs);
    } catch (e) {
      console.log(i + 1, m.split('/').pop(), 'ERR', e.message);
    }
  }
  console.log('total locs', urls);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
