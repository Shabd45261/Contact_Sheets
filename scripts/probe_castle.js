const crypto = require('crypto');
const HOST = 'https://api.hlowb.com';
const SUP = 'T!BgJB';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const HEAD = { 'user-agent': UA, 'accept': 'application/json', 'referer': 'https://www.castleapp.com/', origin: 'https://www.castleapp.com' };

function deriveKey(b64) {
  const raw = Buffer.from(b64, 'base64');
  const km = Buffer.concat([raw, Buffer.from(SUP, 'ascii')]);
  return km.length >= 16 ? km.subarray(0, 16) : Buffer.concat([km, Buffer.alloc(16 - km.length)]);
}
function decrypt(b64, keyB64) {
  const key = deriveKey(keyB64);
  const d = crypto.createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
}
async function getSecKey() {
  const r = await fetch(`${HOST}/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en-US`, { headers: HEAD });
  const j = await r.json();
  return j.data;
}
(async () => {
  const key = await getSecKey();
  console.log('KEY', key);
  const kw = process.argv[2] || 'leo';
  const searchUrl = `${HOST}/film-api/v1.1.0/movie/searchByKeyword?channel=IndiaA&clientType=1&clientType=1&keyword=${encodeURIComponent(kw)}&lang=en-US&mode=1&packageName=com.external.castle&page=1&size=10`;
  const r = await fetch(searchUrl, { headers: HEAD });
  const t = await r.text();
  console.log('SEARCH HTTP', r.status, 'len', t.length);
  let dec;
  try { dec = decrypt(t, key); } catch (e) { console.log('decrypt err', e.message, t.slice(0, 200)); return; }
  require('fs').writeFileSync('data/intel/castle_search.json', dec);
  const j = JSON.parse(dec);
  console.log('SEARCH', JSON.stringify(j).slice(0, 1500));
  const item = j.data && j.data.rows && j.data.rows[2];
  if (!item) return console.log('no item', Object.keys(j.data || {}));
  const id = item.id || item.movieId;
  const detailsUrl = `${HOST}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&clientType=1&lang=en-US&movieId=${id}&packageName=com.external.castle`;
  const r2 = await fetch(detailsUrl, { headers: HEAD });
  const t2 = await r2.text();
  let d2; try { d2 = decrypt(t2, key); } catch (e) { console.log('detail decrypt err', e.message, t2.slice(0,300)); return; }
  require('fs').writeFileSync('data/intel/castle_detail.json', d2);
  const j2 = JSON.parse(d2);
  console.log('DETAIL', JSON.stringify(j2).slice(0, 2500));
  const d = j2.data || {};
  const ep = (d.episodes || [])[0] || {};
  const body = JSON.stringify({ mode: '1', appMarket: 'GuanWang', clientType: '1', woolUser: 'false', apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475', androidVersion: '13', movieId: String(id), episodeId: String(ep.id || ep.episodeId || 0), isNewUser: 'true', resolution: '1080', packageName: 'com.external.castle' });
  const r3 = await fetch(`${HOST}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=com.external.castle&channel=IndiaA&lang=en-US`, { method: 'POST', headers: { ...HEAD, 'content-type': 'application/json; charset=utf-8' }, body });
  const t3 = await r3.text();
  let d3; try { d3 = decrypt(t3, key); } catch (e) { console.log('video decrypt err', e.message, t3.slice(0,300)); return; }
  require('fs').writeFileSync('data/intel/castle_video.json', d3);
  console.log('VIDEO', d3.slice(0, 3000));
})();
