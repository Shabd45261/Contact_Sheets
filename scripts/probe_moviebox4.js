const crypto = require('crypto');
const { execFileSync } = require('child_process');
const SECRETS = {
  def: Buffer.from("NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==", 'base64'),
  alt: Buffer.from("WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ==", 'base64'),
};
const CLIENT_BUILDS = ["1790144723381916466.632cf3fe507b339bc757f117f85b4c4a", "1793366173719104383.d7a1fb415ac995ca890664b0f01e4099-1793366048368718383.dbf44f9f0efa9b445e4f194092a71f01"];
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const deviceId = crypto.randomBytes(16).toString('hex');
const clientInfo = JSON.stringify({package_name:"com.community.oneroom",version_name:"4.0.03.0930.03",version_code:50020132,os:"android",os_version:"14",device_id:deviceId,install_store:"official",gaid:"1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d",brand:"Google",model:"Pixel 8",system_language:"en",net:"NETWORK_WIFI",region:"IN",timezone:"Asia/Calcutta",sp_code:""});
const UA = "com.community.oneroom/50020132 (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)";
function canonical(method, accept, ct, url, body, ts) {
  const u = new URL(url);
  const pairs = [...u.searchParams.entries()].sort((a,b)=> a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k,v])=>k+'='+v).join('&');
  const cu = u.pathname + (pairs ? '?'+pairs : '');
  const bb = body != null ? Buffer.from(body,'utf8') : null;
  const bh = bb ? md5(bb.subarray(0,102400)) : '';
  const bl = bb ? String(bb.length) : '';
  return method.toUpperCase()+'\n'+(accept||'')+'\n'+(ct||'')+'\n'+bl+'\n'+ts+'\n'+bh+'\n'+cu;
}
function mkheaders(method, url, body, ct, accept, key) {
  const ts = Date.now();
  const xct = String(ts)+','+md5(Buffer.from(String(ts).split('').reverse().join(''),'utf8'));
  const sig = ts+'|2|'+crypto.createHmac('md5', key).update(canonical(method,accept,ct,url,body,ts)).digest('base64');
  return {'user-agent': UA, 'accept': accept, 'content-type': ct, 'connection':'keep-alive','x-client-token': xct, 'x-tr-signature': sig, 'x-client-info': clientInfo,'x-client-status':'0', 'x-client-build': CLIENT_BUILDS[0]};
}
function curl(method, url, body, ct, accept, key) {
  const h = mkheaders(method, url, body, ct, accept, key);
  const args = ['-s','--max-time','20','-X',method,url,'-w','|%{http_code}'];
  for (const [k,v] of Object.entries(h)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('--data-binary', body);
  try { return execFileSync('curl.exe', args, {encoding:'utf8'}); } catch(e) { return 'ERR '+e.message; }
}
const url = 'https://apig.inmoviebox.com/wefeed-mobile-bff/user-api/visitor-login';
const bodies = [
  '{}',
  JSON.stringify({device_id:deviceId}),
  JSON.stringify({package_name:"com.community.oneroom",device_id:deviceId}),
  JSON.stringify({deviceId:deviceId}),
  JSON.stringify({device_id:deviceId,package_name:"com.community.oneroom",version_code:50020132}),
  JSON.stringify({package_name:"com.community.oneroom",version_name:"4.0.03.0930.03",version_code:50020132,device_id:deviceId}),
  '',
];
for (const body of bodies) {
  for (const ct of ['application/json','application/json; charset=utf-8']) {
    for (const accept of ['', '*/*']) {
      for (const keyName of ['def','alt']) {
        const out = curl('POST', url, body, ct, accept, SECRETS[keyName]);
        const code = out.split('|').pop();
        if (code !== '407') console.log('HIT', code, {body:body.slice(0,50), ct, accept, keyName}, out.slice(0,250));
      }
    }
  }
}
console.log('done');
