const fs = require('fs');
const { VegaMoviesProvider } = require('../app/lib/providers/vegamovies');
const html = fs.readFileSync('data/intel/vg_post.html', 'utf8');
const p = new VegaMoviesProvider();
const groups = p._groups(html, 'https://vegamovies.lease/download-misty-green-2026-english-full-movie-480p-720p-1080p-web-dl/');
console.log('groups', groups.length);
for (const g of groups) console.log(g.quality, '|', g.heading, '|', g.servers.map(s => s.label + '=' + s.url).join(' ; '));
console.log('--- headings with p ---');
for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]{0,300}?)<\/h\1>/g)) {
  const t = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\d{3,4}p/i.test(t)) console.log('H' + m[1], '|', t.slice(0, 200));
}
console.log('--- type markers ---');
console.log('season-colon', /Season\s*:/i.test(html), 'series-name', /Series Name/i.test(html), 'episode-colon', /Episode\s*:/i.test(html));
