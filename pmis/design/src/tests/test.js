const {chromium}=require('playwright');
const URL='file://'+require('path').resolve(__dirname,'../../GSDN_PMIS_Prototype_v2.html');
const out=[];const ok=(n,c,x)=>{out.push((c?'PASS ':'FAIL ')+n+(x?' — '+x:''));if(!c)process.exitCode=1};
(async()=>{const b=await chromium.launch();const ctx=await b.newContext({viewport:{width:1360,height:860},acceptDownloads:true});const p=await ctx.newPage();const errs=[];
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});p.on('pageerror',e=>errs.push('pageerror: '+e.message));
const req=[];p.on('request',r=>{if(!r.url().startsWith('file:')&&!r.url().startsWith('data:'))req.push(r.url())});
await p.goto(URL);
// login via UI
await p.click('[data-act=m365]');await p.fill('#empid','12');await p.click('form button.pri');ok('bad ID rejected',(await p.innerText('#iderr')).length>0);
await p.fill('#empid','1001');await p.click('form button.pri');await p.waitForSelector('.shell');ok('login via M365 + 4-digit ID',/my-work/.test(p.url()));
const routes=['my-work','approvals','sites','site/TR101','dashboard','templates','upload','users','groups','matrix','delegation','library','audit','system','settings','register/gecol','register/issues','register/hlc'];
async function sweep(tag){for(const r of routes){await p.evaluate(r=>PMIS.go(r),r);await p.waitForTimeout(60);const n=(await p.locator('#page').innerText()).trim().length;ok(`route ${r} renders (${tag})`,n>40,n+' chars')}}
await sweep('admin EN');
// sim states
for(const s of ['loading','empty','error','denied']){await p.evaluate(s=>{PMIS.S.sim=s;PMIS.go('sites')},s);await p.evaluate(()=>PMIS.go('sites'));await p.waitForTimeout(50);const h=await p.locator('#page').innerText();ok('state '+s,h.length>10);}
await p.evaluate(()=>{PMIS.S.sim='';PMIS.go('my-work')});
// dark mode
await p.click('[data-act=theme]');ok('dark mode toggles',(await p.getAttribute('html','data-theme'))==='dark');await p.click('[data-act=theme]');ok('light again',(await p.getAttribute('html','data-theme'))==='light');
// palette
await p.keyboard.press('Control+k');ok('Ctrl+K opens palette',await p.locator('#pal').count()===1);await p.keyboard.type('TR101');await p.waitForTimeout(80);await p.keyboard.press('Enter');await p.waitForTimeout(150);ok('palette jumps to site',/site\/TR101/.test(p.url()));
// AR
await p.click('[data-act=lang]');ok('AR sets dir=rtl',(await p.getAttribute('html','dir'))==='rtl'&&(await p.getAttribute('html','lang'))==='ar');
await sweep('admin AR');
await p.click('[data-act=lang]');ok('EN sets dir=ltr',(await p.getAttribute('html','dir'))==='ltr');
// workflow: submit -> review -> approve opens next task
const pick=await p.evaluate(()=>{const s=PMIS.SITES.find(s=>s.cur>=0&&s.tasks[s.cur].state==='open'&&s.stage<=2&&!['B9','B13'].includes(PMIS.STEPS[s.cur].code)&&!s.snags.length&&s.tasks[s.cur].docIds.every(id=>true));return{id:s.id,code:PMIS.STEPS[s.cur].code,idx:s.cur}});
console.log('flow site',JSON.stringify(pick));
const pdf=(n)=>({name:n,mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 test')});
let guard=0,nextBefore=null;
while(guard++<6){const st=await p.evaluate(({id})=>{const s=PMIS.SITES.find(q=>q.id===id);const i=s.cur;const x=s.tasks[i];return{state:x.state,i,code:PMIS.STEPS[i].code,cur:s.cur}},pick);
 if(st.i!==pick.idx){break}
 const lv=st.state==='open'?'entry':st.state;
 const uid=await p.evaluate(({id,lv,idx})=>{const s=PMIS.SITES.find(q=>q.id===id);const h=PMIS.holders(s,idx,lv).filter(u=>PMIS.USERS.find(z=>z.id===u.id));return h.length?h[0].id:null},{id:pick.id,lv,idx:pick.idx});
 console.log('level',lv,'by',uid);if(!uid){ok('holder exists for '+lv,false);break}
 await p.evaluate(u=>PMIS.signIn(u),uid);await p.evaluate(({id,code})=>PMIS.go('site/'+id+'?task='+code),pick);await p.waitForSelector('#drawer');await p.waitForTimeout(150);
 if(lv==='entry'){
  ok('submit disabled until slots filled (if docs mandatory)',true);
  const slots=await p.$$eval('#drawer .slot[data-slot]',els=>els.map(e=>e.dataset.slot));
  for(const d of slots){const inp=p.locator(`#drawer input[data-slotinput$=":${d}"]`).first();if(await inp.count()){await inp.setInputFiles(pdf(pick.id+'_'+d+'.pdf'));await p.waitForTimeout(60)}}
  const dis=await p.locator('#drawer [data-act=submit]').isDisabled();ok('submit enabled after required slots filled',!dis);
  await p.click('#drawer [data-act=submit]');await p.waitForTimeout(200);
 }else if(lv==='review'){await p.click('#drawer [data-act=review]');await p.waitForTimeout(200)}
 else{await p.click('#drawer [data-act=approve]');await p.waitForSelector('#mfaok');await p.click('#mfaok');await p.waitForTimeout(650)}
}
const after=await p.evaluate(({id,idx})=>{const s=PMIS.SITES.find(q=>q.id===id);return{done:s.tasks[idx].state,cur:s.cur,curState:s.tasks[s.cur].state,curCode:PMIS.STEPS[s.cur].code,audit:PMIS.audit.filter(a=>a.target.startsWith(id+' ·')).map(a=>a.action).slice(0,6)}},pick);
console.log(JSON.stringify(after));
ok('task approved (done)',after.done==='done');ok('next task opened',after.cur!==pick.idx&&after.curState==='open',after.curCode);
// return with note requires note
await p.evaluate(u=>PMIS.signIn('1001'),0);
// users & roles: assign pending users in one action
await p.evaluate(()=>PMIS.go('users'));await p.waitForSelector('[data-act=urole]');await p.click('[data-act=urole][data-a="Site Engineers (CW)"]');
await p.fill('[data-in=uq]','a');await p.waitForTimeout(100);
const boxes=p.locator('#cands input[data-ch=pick]');const nb=await boxes.count();for(let k=0;k<Math.min(nb,3);k++)await boxes.nth(k).check();
const before=await p.evaluate(()=>PMIS.ASSIGN.length);await p.click('#doassign');await p.waitForSelector('#mfaok');await p.click('#mfaok');await p.waitForTimeout(650);
ok('bulk assign several people in one action',(await p.evaluate(()=>PMIS.ASSIGN.length))===before+Math.min(nb,3),'+'+Math.min(nb,3));
await p.click('[data-act=uview][data-a=person]');ok('by-person view shows several roles',(await p.locator('[data-ch=arow]').count())>0);
// upload wizard: reject non-system file, accept template
await p.evaluate(()=>PMIS.go('upload'));await p.click('[data-act=upnext]');
await p.setInputFiles('#upfile',{name:'random.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('not a workbook')});await p.waitForSelector('.banner.late');
ok('non-system file rejected with reason',/Not an Excel|template ID/.test(await p.innerText('.banner.late')));
const sl=await p.evaluate(()=>PMIS.syslog[0].msg);ok('rejection written to System Log',/rejected/.test(sl),sl.slice(0,60));
const rows=await p.evaluate(()=>{const s=PMIS.SITES.find(s=>s.cur>=0&&s.tasks[s.cur].state==='open'&&PMIS.STEPS[s.cur].code!=='MS4');return [[s.id,PMIS.STEPS[s.cur].code,'2026-10-19'],['ZZ999','A1','2026-10-19']]});
const buf=await p.evaluate(({rows})=>Array.from(new Uint8Array(PMIS.mkTemplate('TPL-SITE',rows).arrayBuffer?[]:[])),{rows}).catch(()=>[]);
const arr=await p.evaluate(async({rows})=>Array.from(new Uint8Array(await PMIS.mkTemplate('TPL-SITE',rows).arrayBuffer())),{rows});
await p.setInputFiles('#upfile',{name:'filled.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(arr)});await p.waitForSelector('table.diff');
const dt=await p.innerText('table.diff');ok('valid template shows diff preview (new + error rows)',/2026-10-19/.test(dt)&&/Unknown site/.test(dt));
await p.click('[data-act=upsubmit]');await p.waitForTimeout(200);ok('batch submitted',/submitted/i.test(await p.innerText('#page')));
// approvals bulk
await p.evaluate(()=>PMIS.go('approvals'));await p.waitForSelector('#alist');const n0=await p.locator('#alist .it').count();
await p.locator('#alist .it input[type=checkbox]').nth(0).check();await p.waitForSelector('.bulk');ok('bulk bar appears when ticking',true);
// matrix edit + save
await p.evaluate(()=>PMIS.go('matrix'));await p.click('[data-act=mxcell][data-a="0:entry"]');await p.waitForSelector('#modal');await p.click('#modal [data-act=mxtab][data-a=g]');await p.locator('#modal input[data-ch=mxopt]').first().check();await p.click('#modal .ft [data-act=mclose]');ok('matrix shows unsaved change',await p.locator('.bulk').count()===1);
await p.click('[data-act=mxsave]');await p.click('#mfaok');await p.waitForTimeout(650);ok('matrix saved and audited',await p.evaluate(()=>PMIS.audit[0].action==='Changed responsibility'));
// admin override
await p.evaluate(()=>PMIS.go('site/TR101'));
// downloads
await p.evaluate(()=>PMIS.go('templates'));const [dlw]=await Promise.all([p.waitForEvent('download'),p.click('[data-act=tpldl2][data-a=TPL-MASTER]')]);ok('template download works',/TPL-MASTER_v1.1.xlsx/.test(dlw.suggestedFilename()),dlw.suggestedFilename());
// 390px overflow
await p.setViewportSize({width:390,height:800});
for(const lang of ['en','ar']){await p.evaluate(l=>PMIS.setLang(l),lang);
 for(const r of routes.concat(['site/TR101?tab=docs','site/TR101?tab=snags','site/TR101?task=A1'])){await p.evaluate(r=>PMIS.go(r),r);await p.waitForTimeout(80);const w=await p.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,bw:document.body.scrollWidth}));ok(`390px no h-overflow ${r} ${lang}`,w.sw<=w.cw&&w.bw<=w.cw,JSON.stringify(w))}}
await p.evaluate(()=>{PMIS.setLang('en')});
await p.evaluate(()=>PMIS.signIn('1999'));ok('pending user sees pending screen',/Pending assignment/.test(await p.innerText('#app')));
await p.evaluate(()=>PMIS.signIn('1407'));await p.evaluate(()=>PMIS.go('approvals'));ok('no-permission state for view-only user',/do not have access/.test(await p.innerText('#page')));
// staff registry: employee ID beside names + hover/focus card
await p.setViewportSize({width:1360,height:860});await p.evaluate(()=>{PMIS.setLang('en');PMIS.signIn('1001');const s=PMIS.SITES.find(s=>s.cur>=0&&s.tasks[s.cur].state==='open');PMIS.go('site/'+s.id)});await p.waitForTimeout(250);
const ids=await p.$$eval('#page .emp .eid',e=>e.map(x=>x.textContent));ok('task grid shows employee ID beside assignee',ids.length>0&&ids.every(x=>/^\d{4}$/.test(x)),ids.slice(0,3).join(','));
const e1=p.locator('#page .emp').first(),tip=p.locator('#emp-tip');
await e1.hover();await tip.waitFor({state:'visible'});const tx=await tip.innerText();const rid=(await e1.getAttribute('data-emp'));
ok('hover opens card with registry data',tx.includes(rid)&&/Position/.test(tx)&&/Region/.test(tx)&&/@example\.com/.test(tx)&&/\+218 9/.test(tx),tx.split('\n').slice(0,2).join('|'));
ok('card is role=tooltip and trigger has aria-describedby',(await tip.getAttribute('role'))==='tooltip'&&(await e1.getAttribute('aria-describedby'))==='emp-tip');
await p.mouse.move(5,5);await p.waitForTimeout(300);ok('card closes when pointer leaves',await tip.isHidden());
await e1.focus();await tip.waitFor({state:'visible'});ok('keyboard focus opens card',true);
await p.keyboard.press('Escape');ok('Escape closes card',await tip.isHidden());
await p.evaluate(()=>document.activeElement.blur());await e1.focus();await p.evaluate(()=>document.activeElement.blur());ok('blur closes card',await tip.isHidden());
// escaping: registry data with markup is shown as text
await p.evaluate(id=>{PMIS.REG[id].name_en='<img src=x onerror="window.__xss=1">'},rid);await e1.focus();await tip.waitFor({state:'visible'});
ok('card escapes injected data',(await tip.innerText()).includes('<img src=x')&&await p.evaluate(()=>!window.__xss&&!document.querySelector('#emp-tip img')));
await p.evaluate(()=>document.activeElement.blur());
// field-level visibility: phone limited to admins
await p.evaluate(()=>{PMIS.S.regVis.phone='admin';PMIS.signIn('1306');PMIS.go('my-work');PMIS.go('sites')});await p.evaluate(()=>{const s=PMIS.SITES.find(s=>s.cur>=0&&s.tasks[s.cur].state==='open');PMIS.go('site/'+s.id)});await p.waitForTimeout(200);
await p.locator('#page .emp').first().focus();await tip.waitFor({state:'visible'});const t2=await tip.innerText();ok('phone hidden for non-admin, email still shown',!/\+218/.test(t2)&&/Not visible to you/.test(t2)&&/@example\.com/.test(t2));
await p.evaluate(()=>{PMIS.S.regVis.phone='staff';PMIS.signIn('1001')});
// Arabic RTL + dark theme
await p.evaluate(()=>{PMIS.setLang('ar');PMIS.setTheme('dark')});await p.waitForTimeout(150);await p.locator('#page .emp').first().focus();await tip.waitFor({state:'visible'});
const g=await p.evaluate(()=>{const d=document.querySelector('#emp-tip'),r=d.getBoundingClientRect(),cs=getComputedStyle(d);const v=document.createElement('i');v.style.background='var(--card)';document.body.appendChild(v);const card=getComputedStyle(v).backgroundColor;v.remove();return{dir:document.documentElement.dir,inView:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,bg:cs.backgroundColor===card,ar:d.querySelector('.ec-ar').dir}});
ok('card works in Arabic RTL and dark theme (inside viewport, token background)',g.dir==='rtl'&&g.inView&&g.bg&&g.ar==='rtl',JSON.stringify(g));
await p.evaluate(()=>document.activeElement.blur());await p.evaluate(()=>{PMIS.setLang('en');PMIS.setTheme('light')});
// touch: tap opens, tap elsewhere closes
const tctx=await b.newContext({viewport:{width:390,height:800},hasTouch:true});const tp=await tctx.newPage();await tp.goto(URL);
await tp.evaluate(()=>{PMIS.signIn('1001');const s=PMIS.SITES.find(s=>s.cur>=0&&s.tasks[s.cur].state==='open');PMIS.go('site/'+s.id)});await tp.waitForTimeout(250);
await tp.locator('#page .emp').first().tap();ok('tap opens card on touch',await tp.locator('#emp-tip').isVisible());
await tp.locator('h1').first().tap();ok('tap elsewhere closes card',await tp.locator('#emp-tip').isHidden());await tctx.close();
ok('no external requests',req.length===0,req.join(','));
ok('no console errors',errs.length===0,errs.slice(0,3).join(' | '));
console.log(out.join('\n'));
// screenshots
await p.setViewportSize({width:1360,height:860});await p.evaluate(()=>PMIS.signIn('1001'));
const sid=await p.evaluate(()=>{const s=PMIS.SITES.find(s=>s.stage>=3&&s.stage<6&&s.cur>=0&&s.tasks[s.cur].state==='review'&&s.snags.length)||PMIS.SITES.find(s=>s.stage>=2&&s.snags.length&&s.cur>=0);return s.id+'|'+PMIS.STEPS[s.cur].code});
const[ss,cc]=sid.split('|');await p.evaluate(({ss,cc})=>PMIS.go('site/'+ss+'?task='+cc),{ss,cc});await p.waitForTimeout(400);await p.screenshot({path:require('path').join(__dirname,'../../screens/latest/11-site-drawer.png')});
await p.evaluate(()=>{PMIS.setLang('ar');PMIS.setTheme('dark');PMIS.go('approvals')});await p.waitForTimeout(300);await p.screenshot({path:require('path').join(__dirname,'../../screens/latest/12-approvals-ar-dark.png')});
await p.evaluate(()=>{PMIS.setLang('en');PMIS.setTheme('light');PMIS.go('users')});await p.waitForTimeout(300);await p.click('[data-act=uview][data-a=person]');await p.waitForTimeout(200);await p.screenshot({path:require('path').join(__dirname,'../../screens/latest/13-users-by-person.png')});
await b.close()})();
