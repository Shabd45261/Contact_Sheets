const crypto = require('crypto');
const SECRET = Buffer.from(Buffer.from("NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==", 'base64').toString(), 'base64');
const HOST = 'https://apig.inmoviebox.com';
const CLIENT_BUILD = "1790144723381916466.632cf3fe507b339bc757f117f85b4c4a";
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const deviceId = crypto.randomBytes(16).toString('hex');
const clientInfo = JSON.stringify({package_name:"com.community.oneroom",version_name:"4.0.03.0930.03",version_code:50020132,os:"android",os_version:"14",device_id:deviceId,install_store:"official",gaid:"1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d",brand:"Google",model:"Pixel 8",system_language:"en",net:"NETWORK_WIFI",region:"IN",timezone:"Asia/Calcutta",sp_code:""});
const UA = "com.community.oneroom/50020132 (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)";
let token = null;

function sign(method, url, body, ct, accept) {
  const ts = Date.now();
  const u = new URL(url);
  const q = [...u.searchParams.entries()].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([k,v])=>k+'='+v).join('&');
  const cu = u.pathname + (q ? '?'+q : '');
  const bb = body != null ? Buffer.from(body) : null;
  const canon = [method.toUpperCase(), accept||'', ct||'', bb?String(bb.length):'', ts, bb?md5(bb.subarray(0,102400)):'', cu].join('\n');
  const sig = ts+'|2|'+crypto.createHmac('md5',SECRET).update(canon).digest('base64');
  return {ts, sig, xct: ts+','+md5(Buffer.from(String(ts).split('').reverse().join('')))};
}
async function call(method, path, body, opts={}) {
  const url = HOST + path;
  const ct = opts.ct ?? 'application/json; charset=utf-8';
  const accept = opts.accept ?? 'application/json';
  const {sig, xct} = sign(method, url, body, ct, accept);
  const headers = {'user-agent':UA, accept, 'content-type':ct, connection:'keep-alive','x-client-token':xct,'x-tr-signature':sig,'x-client-info':clientInfo,'x-client-status':'0','x-client-build':CLIENT_BUILD};
  if (opts.noAuth !== true && token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(url, {method, headers, body: body??undefined, signal: AbortSignal.timeout(30000)});
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (r.status !== 200) console.log('HTTP', r.status, path, String(t).slice(0,200));
  return j;
}
(async()=>{
  const login = await call('POST', '/wefeed-mobile-bff/user-api/visitor-login', '{}', {noAuth:true, accept:'application/json', ct:'application/json'});
  token = login?.data?.token;
  console.log('TOKEN', token ? token.slice(0,40) : login);
  const search = await call('POST', '/wefeed-mobile-bff/subject-api/search/v2', JSON.stringify({page:1, perPage:20, keyword:'Inception', restrictKid:0}));
  console.log('SEARCH keys', Object.keys(search), JSON.stringify(search).slice(0,1200));
  const item = (search.data?.items||search.data?.results||[])[0];
  console.log('ITEM', JSON.stringify(item, null, 1).slice(0,1500));
  if (item) {
    const sid = item.subjectId || item.id;
    const det = await call('GET', `/wefeed-mobile-bff/subject-api/get?subjectId=${sid}`);
    require('fs').writeFileSync('data/intel/mb_detail.json', JSON.stringify(det,null,1));
    console.log('DETAIL keys', Object.keys(det.data||{}), JSON.stringify(det).slice(0,1500));
    const play = await call('GET', `/wefeed-mobile-bff/subject-api/play-info?subjectId=${sid}`);
    require('fs').writeFileSync('data/intel/mb_play.json', JSON.stringify(play,null,1));
    console.log('PLAY', JSON.stringify(play).slice(0,2000));
    const res = await call('GET', `/wefeed-mobile-bff/subject-api/resource?subjectId=${sid}`);
    require('fs').writeFileSync('data/intel/mb_resource.json', JSON.stringify(res,null,1));
    console.log('RESOURCE', JSON.stringify(res).slice(0,2500));
  }
})();
