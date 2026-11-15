'use strict';
/* Which MovieBox app identity does the API accept?
   Usage:  node scripts\probe_mb_update.js [title]
   Resolves one title once per candidate version and prints the duration of every file the
   API hands back. A ~20 s item (flagged "<-- notice clip") is the "version discontinued,
   please update" video: that candidate is rejected. Use the first line without the flag:

       set MB_VERSION_NAME=4.0.03.1028.03
       set MB_VERSION_CODE=<code from the accepted line>
       start_moviebox-cncverse-in.bat

   (or put the accepted values in app\lib\providers\moviebox.js as the defaults). */
const path = require('path');
const mbPath = path.join(__dirname, '..', 'app', 'lib', 'providers', 'moviebox.js');

// [version_name, version_code]. The 1028 codes are estimates; add the real one if you know it.
const CANDIDATES = [
  ['4.0.03.0930.03', 50020132],   // the old identity (expected to show the notice)
  ['4.0.03.1020.03', 50020133],
  ['4.0.03.1028.03', 50020134],
  ['4.0.03.1028.03', 50020135],   // current default
  ['4.0.03.1028.03', 50020136],
];

(async () => {
  const title = process.argv[2] || 'Inception';
  for (const [name, code] of CANDIDATES) {
    process.env.MB_VERSION_NAME = name;
    process.env.MB_VERSION_CODE = String(code);
    delete require.cache[require.resolve(mbPath)];
    const { MovieBox } = require(mbPath);
    const mb = new MovieBox();
    try {
      const found = await mb.search(title);
      const hit = found.items.find(x => x.type === 'movie') || found.items[0];
      if (!hit) { console.log(`${name} / ${code}: no search results`); continue; }
      const r = await mb.resource(hit.id);
      const files = ((r && r.list) || []).map(x => ({ label: `${x.resolution}p`, dur: Number(x.duration) || 0 }));
      if (!files.length) {
        const pi = await mb.playInfo(hit.id);
        for (const s of (pi && pi.streams) || []) files.push({ label: `${s.resolutions}p play-info`, dur: Number(s.duration) || 0 });
      }
      const notice = files.some(f => f.dur > 0 && f.dur < 45);
      console.log(`${name} / ${code}: ${files.map(f => `${f.label} ${f.dur}s`).join(', ') || 'no files'}${notice ? '   <-- notice clip' : ''}`);
    } catch (e) {
      console.log(`${name} / ${code}: ${e.message}`);
    }
  }
})();
