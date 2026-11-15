const { CastleProvider } = require('../app/lib/providers/castle');
(async () => {
  const p = new CastleProvider();
  const id = '6150388343775232';
  const pth = `/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&clientType=1&lang=en-US&movieId=${id}&packageName=com.external.castle`;
  const raw = await p._get(pth);
  const d = raw.data || {};
  console.log('keys:', Object.keys(d).join(', '));
  console.log('movieType', d.movieType, 'seasonNumber', d.seasonNumber, 'title', d.title);
  console.log('episodes:', (d.episodes || []).length);
  console.log('seasons:', JSON.stringify((d.seasons || []).map(s => ({
    number: s.number, movieId: s.movieId, isCurrent: s.isCurrent, desc: s.description, epCount: (s.episodes || []).length,
  })), null, 1));
  const s1 = (d.seasons || []).find(s => s.number === 1);
  if (s1 && s1.movieId && s1.movieId !== id) {
    const r2 = await p._get(`/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&clientType=1&lang=en-US&movieId=${s1.movieId}&packageName=com.external.castle`);
    const d2 = r2.data || {};
    console.log('\nS1 detail keys:', Object.keys(d2).join(', '));
    console.log('S1 movieType', d2.movieType, 'seasonNumber', d2.seasonNumber, 'title', d2.title);
    console.log('S1 episodes:', (d2.episodes || []).length, JSON.stringify((d2.episodes || [])[0] || {}, null, 1).slice(0, 900));
    console.log('S1 seasons:', JSON.stringify((d2.seasons || []).map(s => ({ number: s.number, movieId: s.movieId, isCurrent: s.isCurrent }))));
  }
  const ep0 = (d.episodes || [])[0];
  console.log('\nDETAIL seasons[0] ep sample:', JSON.stringify(((d.seasons || [])[0] || {}), null, 1).slice(0, 800));
  console.log('\ngetVideo probe...');
  try {
    const v = await p.getVideo(String(id), String(ep0 && ep0.id), ep0 && ep0.tracks && ep0.tracks[0] && ep0.tracks[0].languageId, 1080);
    console.log('getVideo:', JSON.stringify(v, null, 1).slice(0, 1200));
  } catch (e) { console.log('getVideo ERR', e.message); }
})().catch(e => { console.error(e); process.exit(1); });
