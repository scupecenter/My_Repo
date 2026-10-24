const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1360,height:860}});const errs=[];
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});p.on('pageerror',e=>errs.push('pageerror: '+e.message+'\n'+(e.stack||'').split('\n').slice(0,3).join('\n')));
await p.goto('file:///home/user/my_repo/pmis/design/GSDN_PMIS_Prototype_v2.html');await p.waitForTimeout(300);
console.log('login ok',await p.locator('.login').count());
await p.evaluate(()=>PMIS.signIn('1001'));await p.waitForTimeout(200);
const routes=['my-work','approvals','sites','dashboard','templates','upload','users','groups','matrix','delegation','library','audit','system','register/gecol','register/issues','register/hlc'];
for(const r of routes){await p.evaluate(r=>PMIS.go(r),r);await p.waitForTimeout(120);const n=await p.locator('#page').innerText();console.log(r,n.length)}
console.log(errs.join('\n')||'no errors');await b.close()})();
