const { FourKHDHubProvider } = require('../app/lib/providers/fourkhdhub');
const { request } = require('../app/lib/util');
(async () => {
  const p = new FourKHDHubProvider();
  const id = 'https://4khdhub.dad/the-leopard-series-5628/';
  const doc = await p.detail(id);
  const g = p._pickGroup(doc, 1080);
  const item = g.items.find(x => x.episode === 1);
  console.log('group', g.quality, g.label);
  console.log('item', item.filename, item.size);
  console.log('links', item.links);
  const hc = item.links.find(l => /hubcloud/i.test(l.label)) || item.links[0];
  const rec = await p._hubcloudDrive(hc.url);
  console.log('drive', rec.drive);
  const phps = await p._driveLinks(rec.drive, hc.url);
  console.log('phps', phps);
  for (const php of phps) {
    const r = await request(php, { headers: { referer: rec.drive, 'user-agent': 'Mozilla/5.0' } });
    console.log('php status', r.status, 'len', r.buffer.length);
    for (const m of r.text.matchAll(/href="([^"]+)"/g)) {
      const u = m[1].replace(/&amp;/g, '&');
      if (/r2|pixel|download|\.mkv|\.zip|\/u\//i.test(u)) console.log('  HREF', u.slice(0, 220));
    }
    const all = [...r.text.matchAll(/https?:\/\/[^"'<>\s]+/g)].map(x => x[0]).filter(u => /r2|pixel/i.test(u));
    console.log('  URLS', [...new Set(all)].slice(0, 8).map(u => u.slice(0, 180)));
  }
})().catch(e => { console.error(e); process.exit(1); });
