const { FourKHDHubProvider } = require('../app/lib/providers/fourkhdhub');
const { request } = require('../app/lib/util');
const { getBrowser } = require('../app/lib/browser');
(async () => {
  const p = new FourKHDHubProvider();
  const doc = await p.detail('https://4khdhub.dad/the-leopard-series-5628/');
  const g = p._pickGroup(doc, 1080);
  const item = g.items.find(x => x.episode === 1);
  for (const link of item.links) {
    console.log('\n=== link', link.label);
    try {
      const rec = await p._hubcloudDrive(link.url);
      console.log('drive', rec.drive);
      const phps = await p._driveLinks(rec.drive, link.url);
      console.log('phps', phps);
      for (const php of phps) {
        const r = await request(php, { headers: { referer: rec.drive, 'user-agent': 'Mozilla/5.0' } });
        const urls = [...new Set([...r.text.matchAll(/https?:\/\/[^"'<>\s]+/g)].map(x => x[0].replace(/&amp;/g, '&')))]
          .filter(u => /r2\.cloudflarestorage|pixeldrain|pixel\.hubcloud/i.test(u));
        console.log('php', r.status, urls.slice(0, 10));
      }
    } catch (e) { console.log('ERR', e.message); }
  }
  getBrowser().stop();
  process.exit(0);
})().catch(e => { console.error(e); try { getBrowser().stop(); } catch {} process.exit(1); });
