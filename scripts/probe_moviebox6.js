const crypto=require('crypto'),{execFileSync}=require('child_process');
const b64='NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==';
const alt='WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ==';
const md5=b=>crypto.createHash('md5').update(b).digest('hex');
const did=crypto.randomBytes(16).toString('hex');
const ci=JSON.stringify({package_name:'com.community.oneroom',version_name:'4.0.03.0930.03',version_code:50020132,os:'android',os_version:'14',device_id:did,install_store:'official',gaid:'1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d',brand:'Google',model:'Pixel 8',system_language:'en',net:'NETWORK_WIFI',region:'IN',timezone:'Asia/Calcutta',sp_code:''});
const ua='com.community.oneroom/50020132 (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)';
const variants={};
for (const [n,b] of [['def',b64],['alt',alt]]) {
  const one=Buffer.from(b,'base64');
  variants[n+'_one']=one;
  variants[n+'_ascii']=Buffer.from(one.toString('utf8'),'utf8');
  try { variants[n+'_two']=Buffer.from(one.toString('utf8'),'base64'); } catch(e){}
  try { variants[n+'_oneBuf']=one; } catch(e){}
}
const url='https://apig.inmoviebox.com/wefeed-mobile-bff/user-api/visitor-login';
const body='{}',ct='application/json',accept='application/json';
function send(key){
  const ts=Date.now();
  const canon=['POST',accept,ct,String(Buffer.byteLength(body)),ts,md5(Buffer.from(body)),new URL(url).pathname].join('\n');
  const h={'user-agent':ua,accept,'content-type':ct,connection:'keep-alive','x-client-token':ts+','+md5(Buffer.from(String(ts).split('').reverse().join(''))),'x-tr-signature':ts+'|2|'+crypto.createHmac('md5',key).update(canon).digest('base64'),'x-client-info':ci,'x-client-status':'0','x-client-build':'1790144723381916466.632cf3fe507b339bc757f117f85b4c4a'};
  const args=['-s','--max-time','15','-X','POST',url,'-w','|%{http_code}'];for(const[k,v]of Object.entries(h))args.push('-H',k+': '+v);args.push('--data-binary',body);
  try{return execFileSync('curl.exe',args,{encoding:'utf8'});}catch(e){return 'ERR '+e.message;}
}
for (const [name,key] of Object.entries(variants)) {
  const out=send(key); const code=out.split('|').pop();
  console.log(name, code, out.slice(0,160));
}
