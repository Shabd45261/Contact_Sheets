const crypto = require('crypto');
const { execFileSync } = require('child_process');
const SECRET = "NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==";
const CLIENT_BUILDS = ["1790144723381916466.632cf3fe507b339bc757f117f85b4c4a", "1793366173719104383.d7a1fb415ac995ca890664b0f01e4099-1793366048368718383.dbf44f9f0efa9b445e4f194092a71f01"];
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const deviceId = crypto.randomBytes(16).toString('hex');
const clientInfo = JSON.stringify({package_name:"com.community.oneroom",version_name:"4.0.03.0930.03",version_code:50020132,os:"android",os_version:"14",device_id:deviceId,install_store:"official",gaid:"1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d",brand:"Google",model:"Pixel 8",system_language:"en",net:"NETWORK_WIFI",region:"IN",timezone:"Asia/Calcutta",sp_code:""});
const UA = "com.community.oneroom/50020132 (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)";
function canonical(method, accept, ct, url, body, ts) {
  const u = new URL(url);
  const pairs = [...u.searchParams.entries()].sort((a,b)=> a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k,v])=>k+'='+v).join('&');
  const cu = u.pathname + (pairs ? '?'+pairs : '');
  const bb = body ? Buffer.from(body,'utf8') : null;
  const bh = bb ? md5(bb.subarray(0,102400)) : '';
  const bl = bb ? String(bb.length) : '';
  return method.toUpperCase()+'\n'+(accept||'')+'\n'+(ct||'')+'\n'+bl+'\n'+ts+'\n'+bh+'\n'+cu;
}
function mkheaders(method, url, body, ct='application/json') {
  const ts = Date.now();
  const xct = String(ts)+','+md5(Buffer.from(String(ts).split('').reverse().join(''),'utf8'));
  const sig = ts+'|2|'+crypto.createHmac('md5', Buffer.from(SECRET,'base64')).update(canonical(method,'',ct,url,body,ts)).digest('base64');
  return {'user-agent': UA, 'accept': '', 'content-type': ct, 'connection':'keep-alive','x-client-token': xct, 'x-tr-signature': sig, 'x-client-info': clientInfo,'x-client-status':'0', 'x-client-build': CLIENT_BUILDS[0]};
}
function curl(method, url, body) {
  const h = mkheaders(method, url, body);
  const args = ['-s','--max-time','25','-X',method,url,'-w','\nHTTP:%{http_code}'];
  for (const [k,v] of Object.entries(h)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('--data-binary', body);
  try { return execFileSync('curl.exe', args, {encoding:'utf8'}); } catch(e) { return 'ERR '+e.message; }
}
const base = 'https://apig.inmoviebox.com/wefeed-mobile-bff';
(async()=>{
  console.log('--- visitor-login POST {} ---'); console.log(curl('POST', base+'/user-api/visitor-login', '{}').slice(0,500));
  console.log('--- visitor-login POST empty ---'); console.log(curl('POST', base+'/user-api/visitor-login', '').slice(0,300));
  console.log('--- visitor-login GET ---'); console.log(curl('GET', base+'/user-api/visitor-login', null).slice(0,300));
  console.log('--- search w/o token ---'); console.log(curl('POST', base+'/subject-api/search/v2', JSON.stringify({page:1,perPage:20,keyword:'Inception',restrictKid:0})).slice(0,300));
})();
