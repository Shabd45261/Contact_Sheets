const registry = require('C:/HostDrives/D/Cloudstream/app/lib/providers');
(async () => {
  const p = registry.get('vegamovies-cncverse');
  console.log('host', p.host);
  const sw = Date.now();
  try {
    const idx = await p.indexStatus();
    console.log('indexStatus', idx, 'in', ((Date.now() - sw) / 1000).toFixed(1) + 's');
  } catch (e) {
    console.log('index ERR', e.message, 'in', ((Date.now() - sw) / 1000).toFixed(1) + 's');
  }
  const sw2 = Date.now();
  try {
    const r = await p.search('inception');
    console.log('search', r.items.length, 'in', ((Date.now() - sw2) / 1000).toFixed(1) + 's');
    console.log(r.items.slice(0, 5).map(x => x.title));
  } catch (e) {
    console.log('search ERR', e.message);
  }
})();
