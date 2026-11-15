const base = 'http://127.0.0.1:8787';
const j = async (p, o) => {
  const r = await fetch(base + p, o);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t), headers: r.headers }; } catch { return { status: r.status, body: t.slice(0, 300), headers: r.headers }; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');

async function waitJob(id) {
  for (let i = 0; i < 400; i++) {
    await sleep(2000);
    const r = await j('/api/jobs/' + id);
    const job = r.body.job;
    if (!job) throw new Error('job lost');
    if (i % 4 === 0 || ['done', 'failed', 'cancelled'].includes(job.status)) {
      console.log('  ', job.status, job.progress + '%', job.phase, '-', job.message);
    }
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
  }
  throw new Error('timeout');
}

(async () => {
  // 1. MovieBox movie sheet with a custom interval (seconds between snapshots)
  const s = await j('/api/search?provider=moviebox-cncverse&q=inception');
  const item = (s.body.items || []).find(x => x.type === 'movie') || s.body.items[0];
  console.log('\n[moviebox movie]', item.title, item.id);
  const jobRes = await j('/api/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'moviebox-cncverse', id: item.id, title: item.title, type: 'movie',
      season: 0, items: [{ season: 0, episode: 0 }], episodes: [0], interval: 300, mode: 'movie',
    }),
  });
  const job = await waitJob(jobRes.body.job.id);
  console.log('  sheets:', JSON.stringify(job.sheets?.[0]));
  console.log('  errors:', JSON.stringify(job.errors));

  // 2. Clip from a MovieBox series (Breaking Bad S01E01, 120s in, 20s long)
  console.log('\n[clip moviebox]');
  const t0 = Date.now();
  const c = await fetch(base + '/api/clip?provider=moviebox-cncverse&id=1382465867459478920&type=series&season=1&episode=1&start=120&duration=20&title=Breaking%20Bad%20%5BHindi%5D&download=1');
  console.log('  status', c.status, c.headers.get('content-type'), c.headers.get('content-length'), c.headers.get('x-clip-quality'), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (c.ok) {
    const buf = Buffer.from(await c.arrayBuffer());
    console.log('  bytes', buf.length, 'mp4?', buf.slice(4, 8).toString());
    fs.writeFileSync('data/intel/clip-test-mb.mp4', buf);
  } else console.log('  body', await c.text());

  // 3. Clip from CastleTV (720p HLS, 300s in, 15s long)
  console.log('\n[clip castle]');
  const t1 = Date.now();
  const c2 = await fetch(base + '/api/clip?provider=castletv-cncverse&id=6150388343775232&type=series&season=1&episode=1&start=300&duration=15&title=Breaking%20Bad&download=1');
  console.log('  status', c2.status, c2.headers.get('content-type'), c2.headers.get('content-length'), c2.headers.get('x-clip-quality'), `${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (c2.ok) {
    const buf = Buffer.from(await c2.arrayBuffer());
    console.log('  bytes', buf.length, 'mp4?', buf.slice(4, 8).toString());
    fs.writeFileSync('data/intel/clip-test-castle.mp4', buf);
  } else console.log('  body', await c2.text());
})().catch(e => { console.error(e); process.exit(1); });
