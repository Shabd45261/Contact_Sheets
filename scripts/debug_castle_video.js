const { CastleProvider } = require('../app/lib/providers/castle');
(async () => {
  const p = new CastleProvider();
  const mid = '6146180944568320'; // Breaking Bad season 1
  const ep = '6146180946042880';  // S01E01
  for (const res of [1, 2, 3]) {
    for (const lang of [1018, 1003, undefined]) {
      try {
        const v = await p.getVideo(mid, ep, lang, res);
        console.log(`res=${res} lang=${lang}`, JSON.stringify(v).slice(0, 400));
        if (v && v.videoUrl) {
          console.log('  free candidates:', p.freeCandidates(v.videoUrl).slice(0, 4));
          return;
        }
      } catch (e) { console.log(`res=${res} lang=${lang} ERR`, e.message); }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
