const fs=require('fs');
const src=fs.readFileSync('scripts/probe_moviebox_api.js','utf8');
// reuse call/sign by evaluating module-ish: simplest is to re-require by copying functions
eval(src.split('(async()=>{')[0].replace(/^const crypto/m,'const crypto'));
(async()=>{
  const login = await call('POST', '/wefeed-mobile-bff/user-api/visitor-login', '{}', {noAuth:true, accept:'application/json', ct:'application/json'});
  token = login.data.token;
  const sid='977486567826752424';
  for (const p of [
    `/wefeed-mobile-bff/subject-api/get?subjectId=${sid}`,
    `/wefeed-mobile-bff/subject-api/detail?subjectId=${sid}`,
    `/wefeed-mobile-bff/subject-api/season-info?subjectId=${sid}`,
    `/wefeed-mobile-bff/subject-api/play-info?subjectId=${sid}`,
    `/wefeed-mobile-bff/subject-api/resource?subjectId=${sid}`,
    `/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=${sid}`,
  ]) {
    const r = await call('GET', p);
    console.log('\n==',p, JSON.stringify(r).slice(0,1800));
  }
})();
