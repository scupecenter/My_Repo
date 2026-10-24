const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1360,height:900}});const errs=[];
p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await p.goto('file:///home/user/my_repo/pmis/design/GSDN_PMIS_Prototype_v2.html');
await p.screenshot({path:'shots/login.png'});
await p.evaluate(()=>PMIS.signIn('1001'));
const sid=await p.evaluate(()=>{const s=PMIS.SITES.find(s=>s.stage>=3&&s.stage<6&&s.cur>=0&&s.tasks[s.cur].state==='review')||PMIS.SITES.find(s=>s.stage>=3);return s.id});console.log(sid);
await p.evaluate(s=>PMIS.go('site/'+s),sid);await p.waitForTimeout(300);await p.screenshot({path:'shots/site.png',fullPage:true});
for(const r of ['approvals','sites','matrix','users','dashboard','library']){await p.evaluate(r=>PMIS.go(r),r);await p.waitForTimeout(200);await p.screenshot({path:'shots/'+r+'.png'})}
console.log(errs.join('\n')||'none');await b.close()})();
