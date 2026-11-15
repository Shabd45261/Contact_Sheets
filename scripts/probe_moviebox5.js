const crypto=require('crypto'),{execFileSync}=require('child_process');
const KEYS={def:Buffer.from('NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==','base64'),alt:Buffer.from('WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ==','base64')};
const md5=b=>crypto.createHash('md5').update(b).digest('hex');
const did=crypto.randomBytes(16).toString('hex');
const ci=JSON.stringify({package_name:'com.community.oneroom',version_name:'4.0.03.0930.03',version_code:50020132,os:'android',os_version:'14',device_id:did,install_store:'official',gaid:'1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d',brand:'Google',model:'Pixel 8',system_language:'en',net:'NETWORK_WIFI',region:'IN',timezone:'Asia/Calcutta',sp_code:''});
const ua='com.community.oneroom/50020132 (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)';
const url='https://apig.inmoviebox.com/wefeed-mobile-bff/user-api/visitor-login';
function send(body,ct,accept,keyName,withUser){
  const ts=Date.now();
  const canon=['POST',accept,ct,body==null?'':String(Buffer.byteLength(body)),ts,body==null?'':md5(Buffer.from(body)),new URL(url).pathname].join('\n');
  const h={'user-agent':ua,accept,'content-type':ct,connection:'keep-alive','x-client-token':ts+','+md5(Buffer.from(String(ts).split('').reverse().join(''))),'x-tr-signature':ts+'|2|'+crypto.createHmac('md5',KEYS[keyName]).update(canon).digest('base64'),'x-client-info':ci,'x-client-status':'0','x-client-build':'1790144723381916466.632cf3fe507b339bc757f117f85b4c4a'};
  if(withUser) h['x-user']=JSON.stringify({token:''});
  const args=['-s','--max-time','15','-X','POST',url,'-w','|%{http_code}'];for(const[k,v]of Object.entries(h))args.push('-H',k+': '+v);if(body!=null)args.push('--data-binary',body);
  try{return execFileSync('curl.exe',args,{encoding:'utf8'});}catch(e){return 'ERR '+e.message;}
}
const bodies=[null,'','{}',ci,JSON.stringify({device_id:did}),JSON.stringify({package_name:'com.community.oneroom',device_id:did})];
for(const body of bodies)for(const ct of ['application/json','application/json; charset=utf-8'])for(const accept of ['application/json',''])for(const k of ['def','alt']){
  const out=send(body,ct,accept,k,false); const code=out.split('|').pop();
  if(code!=='407') console.log('DIFF',code,{b:body&&body.slice(0,40),ct,accept,k},out.slice(0,300));
}
console.log('done');
