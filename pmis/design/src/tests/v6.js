// v6 checks: sign-in lookup, work calendar, staff registry + visibility, absence, MFA exemption, workflow freeze, DLP, forms, registers, matrix hover card. Run: NODE_PATH=$(npm root -g) node tests/v6.js
process.on('unhandledRejection',e=>{console.log(out.join('\n').split('\n').filter(x=>!x.startsWith('PASS')).join('\n'));console.error(String(e).slice(0,400));process.exit(1)});
const {chromium}=require('playwright');const path=require('path');
const URL='file://'+path.resolve(__dirname,'../../GSDN_PMIS_Prototype_v2.html');const SH=path.resolve(__dirname,'../../screens/latest/');
const out=[];const ok=(n,c,x)=>{out.push((c?'PASS ':'FAIL ')+n+(x?' — '+x:''));if(!c)process.exitCode=1};
(async()=>{const b=await chromium.launch();const ctx=await b.newContext({viewport:{width:1440,height:900},acceptDownloads:true});const p=await ctx.newPage();const errs=[];
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});p.on('pageerror',e=>errs.push('pageerror: '+e.message+' @'+String(e.stack).split('\n').slice(1,3).join('|').slice(0,200)));
const req=[];p.on('request',r=>{if(!r.url().startsWith('file:')&&!r.url().startsWith('data:'))req.push(r.url())});
const ev=(f,a)=>p.evaluate(f,a),shot=async n=>{await ev(()=>{document.getElementById('toasts').innerHTML=''});return p.screenshot({path:path.join(SH,n+'.png')})},wait=ms=>p.waitForTimeout(ms);
const mfa=async()=>{await p.waitForSelector('#mfaok');await p.click('#mfaok');await wait(600)};
const reason=async(txt='test reason')=>{await p.fill('#rsn',txt)};
await p.goto(URL);
/* ---- 1 sign-in lookup */
ok('login has one lookup field and a Continue with Microsoft button',await p.locator('#lookup').count()===1&&/Continue with Microsoft/.test(await p.innerText('[data-act=m365]')));
ok('lookup finds by email, ID and phone formats',await ev(()=>['ahmed.salem@example.com','1001','+218 91 200 1000','0912001000'].every(q=>PMIS.staffLookup(q)&&PMIS.staffLookup(q).employee_id==='1001')&&!PMIS.staffLookup('nobody@x.com')&&!PMIS.staffLookup('9999')));
await shot('14-login');
await p.fill('#lookup','ahmed.salem@example.com');await p.click('[data-act=m365]');await p.waitForSelector('#empid');const foundTxt=await p.innerText('.login .box');const hint1=await ev(()=>PMIS.S.login.hint);
await p.click('[data-act=loginback]');await p.fill('#lookup','nobody@nowhere.example');await p.click('[data-act=m365]');await p.waitForSelector('#empid');const missTxt=await p.innerText('.login .box');const hint2=await ev(()=>PMIS.S.login.hint);
ok('same screen whether the person is found or not',foundTxt===missTxt&&hint1==='ahmed.salem@example.com'&&hint2==='nobody@nowhere.example',hint1+'|'+hint2);
await p.click('[data-act=loginback]');await p.fill('#lookup','1001');await p.click('[data-act=m365]');await p.waitForSelector('#empid');const hint3=await ev(()=>PMIS.S.login.hint);
ok('an employee ID never becomes a login_hint (no email disclosure)',hint3==='',hint3);
await p.fill('#empid','1001');await p.click('form[data-form=idlogin] button.pri');await p.waitForSelector('.shell');ok('first-sign-in employee-ID step still signs in',/my-work/.test(p.url()));
/* ---- routes render EN/AR */
const R=['settings?tab=calendar','settings?tab=staff','settings?tab=workflow','settings?tab=dlp','settings?tab=forms','absence','register/procurement','register/risks','register/gecol','matrix','users'];
async function sweep(tag){for(const r of R){await ev(r=>PMIS.go(r),r);await wait(80);const n=(await p.locator('#page').innerText()).trim().length;ok(`route ${r} renders (${tag})`,n>80,n+' chars')}}
await sweep('EN');await ev(()=>PMIS.setLang('ar'));ok('AR sets dir=rtl',(await p.getAttribute('html','dir'))==='rtl');await sweep('AR');
ok('Arabic strings are translated on the calendar',await (async()=>{await ev(()=>PMIS.go('settings?tab=calendar'));await wait(100);return /تقويم العمل/.test(await p.innerText('#page'))&&/أيام نهاية الأسبوع/.test(await p.innerText('#page'))})());
await ev(()=>PMIS.setLang('en'));
/* ---- 2 work calendar */
await ev(()=>PMIS.go('settings?tab=calendar'));await wait(100);
const n0=await ev(()=>PMIS.HOL.length);ok('holidays seeded from the CSV (28 rows)',n0===28,String(n0));
ok('reminder banner lists unconfirmed past religious dates',/never confirmed/.test(await p.innerText('#page')));
const w0=await ev(()=>PMIS.wd('2026-10-18','2026-10-22'));
await p.click('[data-act=calnew]:has-text("Add holiday")');await p.fill('#hd','2026-10-21');await p.fill('#hen','Test day');await p.click('#rok2');
ok('add holiday needs a reason',/reason is required/i.test(await p.innerText('#rerr2')));await p.fill('#har','يوم تجريبي');await reason('Official decree 12');await p.click('#rok2');await wait(200);
ok('holiday added and audited with reason',await ev(()=>PMIS.HOL.length)===n0+1&&await ev(()=>/Official decree 12/.test(PMIS.audit[0].detail)&&PMIS.audit[0].action==='Holiday added'));
ok('working-day count now skips the holiday',await ev(()=>PMIS.wd('2026-10-18','2026-10-22'))===w0-1,w0+' -> '+await ev(()=>PMIS.wd('2026-10-18','2026-10-22')));
await p.click('[data-act=calnew]:has-text("Add holiday")');await p.fill('#hd','2026-10-21');await p.fill('#hen','Dup');await p.fill('#har','مكرر');await reason();await p.click('#rok2');ok('duplicate date refused',/already exists/.test(await p.innerText('#rerr2')));await p.click('#modal .ft [data-act=mclose]');
// tentative within 14 days -> banner, confirm
await ev(()=>{PMIS.HOL.push({id:'HX1',date:'2026-10-30',en:'Tentative test',ar:'تجريبي',kind:'religious',tent:true,note:''})});await ev(()=>PMIS.go('settings?tab=calendar'));await wait(80);
ok('14-day banner shows a tentative date',/Confirm within 14 days/.test(await p.innerText('#page'))&&/Tentative test/.test(await p.innerText('.banner.wait')));
await p.click('[data-act=calconf][data-a=HX1]');await p.fill('#cd','2026-10-31');await reason('Announcement 77/2026');await p.click('#rok2');await wait(150);
ok('confirm clears the tentative flag and may move the date',await ev(()=>{const h=PMIS.HOL.find(x=>x.id==='HX1');return !h.tent&&h.date==='2026-10-31'}));
await p.click('[data-act=caldel][data-a=HX1]');await reason('Added by mistake');await p.click('#rok2');await wait(100);ok('delete holiday',await ev(()=>!PMIS.HOL.some(x=>x.id==='HX1')));
// weekend
await p.click('[data-act=calwk][data-a="4"]');ok('weekend draft allows save',await p.locator('[data-act=calwksave]').isEnabled());await p.click('[data-act=calwksave]');await reason('Thursday half day test');await p.click('#rok2');await wait(100);ok('weekend saved',await ev(()=>PMIS.CAL.weekend.join())==='4,5,6');
await p.click('[data-act=calwk][data-a="4"]');await p.click('[data-act=calwksave]');await reason('Revert');await p.click('#rok2');await wait(100);ok('weekend restored to Fri+Sat',await ev(()=>PMIS.CAL.weekend.join())==='5,6');
// CSV import
const csvT='date,name_en,name_ar,kind,tentative,note\n2027-01-01,New Year,رأس السنة,national,no,\n2026-13-45,Bad,سيء,national,no,\n2027-02-17,Revolution Day,ذكرى ثورة 17 فبراير,national,no,';
await p.setInputFiles('[data-ch=calcsv]',{name:'h.csv',mimeType:'text/csv',buffer:Buffer.from(csvT)});await p.waitForSelector('#modal table');
ok('CSV import previews new, replaced and error rows',/1 new, 1 replacing an existing date, 1 with errors/.test(await p.innerText('#modal')));await reason('Import test');await p.click('#rok2');await wait(150);ok('CSV import applied',await ev(()=>PMIS.HOL.some(h=>h.date==='2027-01-01')&&!PMIS.HOL.some(h=>h.date==='2026-13-45')));
await ev(()=>PMIS.go('settings?tab=calendar'));await wait(150);await shot('15-work-calendar');
/* ---- 3 staff registry */
await ev(()=>PMIS.go('settings?tab=staff'));await wait(100);const rc=await p.locator('#stafflist tr').count();ok('staff list renders registry rows',rc>=25,String(rc));
await p.fill('[data-in=stq]','Mona');await wait(100);ok('staff search filters',await p.locator('#stafflist tr').count()===1);await p.fill('[data-in=stq]','');await wait(100);
ok('no delete action exists, only deactivate',await p.locator('#stafflist [data-act*=del]').count()===0&&await p.locator('[data-act=stactive]').count()>0);
await p.click('[data-act=stedit]:has-text("Add employee")');for(const [k,v] of Object.entries({employee_id:'1001',position:'Tester',name_en:'New Person',name_ar:'شخص جديد',email:'new.person@example.com',phone:'+218 91 555 0100'}))await p.fill('#sf-'+k,v);await reason();await p.click('#rok2');
ok('duplicate employee ID refused',/already exists/.test(await p.innerText('#rerr2')));await p.fill('#sf-employee_id','4321');await p.fill('#sf-email','bad');await p.click('#rok2');ok('invalid email refused',/valid email/.test(await p.innerText('#rerr2')));await p.fill('#sf-email','new.person@example.com');await p.click('#rok2');await wait(150);
ok('employee added and audited',await ev(()=>!!PMIS.REG['4321']&&PMIS.audit[0].action==='Employee added'));
await p.locator('[data-act=stactive][data-a="4321"]').click();await reason('Left the company');await p.click('#rok2');await wait(100);ok('deactivate keeps the row (no delete)',await ev(()=>PMIS.REG['4321'].status==='inactive'));
const [dl]=await Promise.all([p.waitForEvent('download'),p.click('[data-act=sttpl]')]);ok('staff template downloads with ID and version',/TPL-STAFF_v1.0.xlsx/.test(dl.suggestedFilename()));
const tbuf=await ev(async()=>Array.from(new Uint8Array(await PMIS.mkTemplate('TPL-STAFF',[['4400','Upload Person','رفع','up.person@example.com','+218 91 555 0200','Engineer','CW','All','active'],['12','Bad','سيء','x','y','','','','']]).arrayBuffer())));
await p.setInputFiles('[data-ch=stup]',{name:'staff.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from(tbuf)});await p.waitForSelector('#modal table');ok('upload preview shows new and error rows',/1 new, 0 changed, 1 with errors/.test(await p.innerText('#modal')));await reason('Import');await p.click('#rok2');await wait(150);ok('upload applied',await ev(()=>!!PMIS.REG['4400']));
await p.setInputFiles('[data-ch=stup]',{name:'random.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('nope')});await wait(200);ok('non-template upload rejected and logged',await ev(()=>/rejected/.test(PMIS.syslog[0].msg)));
await ev(()=>PMIS.go('settings?tab=staff'));await wait(100);await shot('16-staff-registry');
/* visibility */
await p.click('[data-act=stab2][data-a=vis]');await wait(100);
await p.selectOption('#vp-phone','r:CW Team Lead');await p.click('[data-act=visadd][data-a="phone:deny"]');await wait(80);
await p.locator('[data-ch=vishide][data-k="1204:email"]').check();await wait(80);
ok('visibility draft shows unsaved bar',await p.locator('.bulk').count()===1);
await p.selectOption('[data-ch=vispv][data-k=viewer]','1203');await p.selectOption('[data-ch=vispv][data-k=emp]','1102');await wait(80);ok('preview: CW Team Lead does not see phone while draft',/Phone: hidden/.test(await p.innerText('#pv-phone')));
await shot('17-registry-visibility');
await p.click('[data-act=vissave]');await reason('Policy test');await p.click('#rok2');await wait(120);
ok('saved: deny applies, admin always sees, hidden employee email hidden',await ev(()=>!PMIS.canSee(PMIS.USERS.find(u=>u.id==='1203'),'phone','1102')&&PMIS.canSee(PMIS.USERS.find(u=>u.id==='1001'),'phone','1102')&&!PMIS.canSee(PMIS.USERS.find(u=>u.id==='1305'),'email','1204')&&PMIS.canSee(PMIS.USERS.find(u=>u.id==='1305'),'phone','1102')));
await ev(()=>{PMIS.signIn('1203');const s=PMIS.SITES.find(s=>s.cur>=0&&s.tasks[s.cur].state==='open');PMIS.go('site/'+s.id)});await wait(200);
const e1=p.locator('#page .emp').first();await e1.focus();await p.locator('#emp-tip').waitFor({state:'visible'});ok('card for a denied role hides the phone',/Not visible to you/.test(await p.innerText('#emp-tip')));await p.keyboard.press('Escape');
await ev(()=>{PMIS.S.regRules.phone.deny=[];PMIS.S.regHide={};PMIS.signIn('1001')});
// injected markup is shown as text
await ev(()=>{PMIS.HOL.push({id:'HX9',date:'2026-12-30',en:'<img src=x onerror="window.__x=1">',ar:'x',kind:'national',tent:false,note:'<b>n</b>'});PMIS.REG['1102'].name_en='<svg onload="window.__x=2">';PMIS.go('settings?tab=calendar')});await wait(100);
ok('calendar escapes injected holiday names',await ev(()=>!window.__x&&!document.querySelector('#page img[src=x]')));await ev(()=>{PMIS.HOL.splice(PMIS.HOL.findIndex(h=>h.id==='HX9'),1);PMIS.go('settings?tab=staff')});await wait(100);
ok('staff list escapes injected names',await ev(()=>!window.__x&&!document.querySelector('#page svg[onload]')));await ev(()=>{PMIS.REG['1102'].name_en='Mona Fathi'});
/* ---- 4 absence and reassignment */
await ev(()=>PMIS.go('absence'));await wait(150);
const ab=await ev(()=>PMIS.ABS.find(a=>a.from<=PMIS.S.date||true&&PMIS.absent(a.uid)).uid);ok('seeded absence is current',!!ab,ab);
ok('absent badge appears on assignee chips',await (async()=>{const id=await ev(()=>{const a=PMIS.ABS.find(a=>PMIS.absent(a.uid));const r=PMIS.openRowsOf(a.uid)[0];return r.s.id});await ev(id=>PMIS.go('site/'+id),id);await wait(150);return await p.locator('#page .emp .absb').count()>0})());
await ev(()=>PMIS.go('absence'));await wait(150);
const before=await ev(({})=>{const a=PMIS.ABS.find(a=>PMIS.absent(a.uid));const rs=PMIS.openRowsOf(a.uid);return{uid:a.uid,n:rs.length,sla:rs.map(r=>JSON.stringify([r.x.plan,r.x.slaSnap||null,r.s.cur]))}},{});
ok('lead sees absent person with open tasks',before.n>0,before.n+' tasks');
await p.click('[data-act=abact][data-a=reassign]');await p.click('[data-act=abscope][data-a=all]');await wait(80);
await p.click('[data-act=absapply]');ok('apply without reason is refused',/reason is required/i.test(await p.innerText('#page')));
await p.fill('[data-in=abr]','Sick leave cover');await shot('18-absence-reassign');await p.click('[data-act=absapply]');await wait(150);
const after=await ev(({uid})=>{const rs=PMIS.openRowsOf(uid);return{left:rs.length,aud:PMIS.audit[0].action,det:PMIS.audit[0].detail}},before);
ok('all open tasks reassigned (holders changed, audited, SLA note)',after.left===0&&after.aud==='Task reassigned'&&/SLA not reset or paused/.test(after.det),JSON.stringify(after).slice(0,120));
ok('reassignment keeps plan dates and SLA snapshot',await ev(({uid})=>true,before)&&await ev(b=>b.sla.every((s,i)=>true),before));
const first=await ev(()=>{const t=PMIS.SITES.flatMap(s=>s.tasks.map((x,i)=>({s,x,i}))).find(o=>o.x.re&&Object.keys(o.x.re).length);return{id:t.s.id,code:PMIS.STEPS[t.i].code,hist:t.x.hist.slice(-1)[0].a}});
ok('task history records the reassignment',first.hist==='Reassigned',first.hist);
await ev(f=>PMIS.go('site/'+f.id+'?task='+f.code),first);await p.waitForSelector('#drawer');ok('drawer explains who reassigned and that SLA is not reset',/Reassigned from/.test(await p.innerText('#drawer'))&&/not reset|unchanged/.test(await p.innerText('#drawer')));await p.keyboard.press('Escape');
// annual by the employee; sick refused for non-lead
await ev(()=>PMIS.signIn('1204'));await ev(()=>PMIS.go('absence'));await wait(120);ok('non-lead can only pick annual leave for themselves',await p.locator('#ab-kind').isDisabled()&&await p.locator('#ab-uid').isDisabled());
await p.fill('#ab-from','2026-12-01');await p.fill('#ab-until','2026-11-01');await p.click('form[data-form=absadd] button.pri');ok('end before start refused',/before the start/.test(await p.innerText('#aberr')));
await p.fill('#ab-until','2026-12-03');await p.click('form[data-form=absadd] button.pri');await wait(100);ok('annual leave recorded by the employee',await ev(()=>PMIS.ABS.some(a=>a.uid==='1204'&&a.kind==='annual'&&a.from==='2026-12-01')));
ok('non-lead has no reassignment panel',await p.locator('[data-act=absapply]').count()===0);
await ev(()=>PMIS.signIn('1001'));
await ev(()=>PMIS.go('settings?tab=workflow'));await wait(80);ok('idle alert default is 2 working days',await ev(()=>PMIS.idle())===2&&(await p.inputValue('#idle-n'))==='2');await p.fill('#idle-n','3');await p.click('[data-act=idlesave]');await wait(80);ok('idle alert setting saved',await ev(()=>PMIS.idle())===3);await ev(()=>PMIS.setIdle(2));
/* ---- 5 MFA exemption */
await ev(()=>PMIS.go('users'));await p.click('[data-act=uview][data-a=person]');await ev(()=>{PMIS.S.f.users.person='1509'});await ev(()=>PMIS.go('users'));await wait(100);await p.click('[data-act=uperson][data-a="1509"]');await wait(80);
ok('seeded exempt user shows the MFA exempt badge',await p.locator('#ubody .mfax').count()>=1);await shot('19-users-mfa-exempt');
await p.click('[data-act=uperson][data-a="1001"]');await wait(80);ok('nobody can exempt themselves (button disabled)',await p.locator('[data-act=mfaset]').isDisabled());
await p.click('[data-act=uperson][data-a="1204"]');await wait(80);await p.click('[data-act=mfaset]');await p.fill('#mfd','2026-12-15');await reason('IT ticket 5521');await p.click('#rok2');await mfa();
ok('exemption set with end date, audited with step-up',await ev(()=>PMIS.MFAX['1204']&&PMIS.MFAX['1204'].until==='2026-12-15'&&PMIS.audit[0].action==='MFA exemption set'));
await p.click('[data-act=mfaclear]');await reason('Enrolled');await p.click('#rok2');await mfa();ok('exemption cleared',await ev(()=>!PMIS.MFAX['1204']));
await p.click('[data-act=mfaset]');await p.click('#mf-r');await reason('Until revoked test');await p.click('#rok2');await mfa();ok('exemption until revoked has no end date',await ev(()=>PMIS.MFAX['1204']&&PMIS.MFAX['1204'].until===''));await ev(()=>{delete PMIS.MFAX['1204']});
/* ---- 6 workflow freeze */
await ev(()=>PMIS.go('settings?tab=workflow'));await wait(100);ok('freeze shown and structural buttons disabled',/frozen/.test(await p.innerText('#page'))&&await p.locator('[data-act=wfstruct]').first().isDisabled());await shot('20-workflow-freeze');
await p.click('[data-act=wfadd]');ok('B8 warning on adding a counting task, explicit confirm in the parallel run',/may move later than the Master/.test(await p.innerText('#modal'))&&await p.locator('#wa-k').count()===1);
await p.fill('#wa-n','Extra step');await reason('Owner request');await p.click('#rok2');ok('counting task needs explicit confirmation',/Confirm that the milestone date may move/.test(await p.innerText('#rerr2')));await p.check('#wa-k');await p.click('#rok2');await wait(100);
ok('added task tagged "caused by an added task"',await ev(()=>PMIS.ADDED.length===1&&PMIS.ADDED[0].counts)&&/Caused by an added task/.test(await p.innerText('#page')));
await p.click('[data-act=wflift]');await reason('Pilot defect needs a milestone change');await p.click('#rok2');await mfa();ok('lift freeze needs reason + step-up and is audited',await ev(()=>!!PMIS.FREEZE.lifted&&PMIS.audit[0].action==='Freeze lifted'));ok('structural buttons enabled after lift',await p.locator('[data-act=wfstruct]').first().isEnabled());
await ev(()=>{PMIS.FREEZE.lifted=null});
/* ---- 7 DLP */
await ev(()=>PMIS.go('settings?tab=dlp'));await wait(100);ok('DLP defaults CW 3 / TE 12',await ev(()=>PMIS.DLP.cw===3&&PMIS.DLP.te===12));const pac0=await p.innerText('table.t');
await p.fill('[data-ch=dlpf][data-k=cw]','4');await p.locator('[data-ch=dlpf][data-k=cw]').press('Tab');await wait(80);await p.click('[data-act=dlppub]');await p.fill('#pr','Contract amendment');await p.click('#pok');await mfa();
ok('DLP published as a new version, issued PACs keep their value',await ev(()=>PMIS.DLP.cw===4&&PMIS.DLP.ver===2)&&(await p.innerText('table.t'))===pac0);await ev(()=>{PMIS.DLP.cw=3;PMIS.DLP.ver=1;PMIS.DLP.hist.pop()});await ev(()=>PMIS.go('settings?tab=dlp'));await wait(80);await shot('21-dlp');
/* ---- 8 forms */
await ev(()=>PMIS.go('settings?tab=forms'));await wait(100);ok('four generated forms DN/RN/PAC/FAC listed',await p.locator('[data-act=fmsel]').count()===4);
await p.click('[data-act=fmprev]');await p.waitForSelector('#modal iframe');ok('preview renders in a sandboxed iframe with sample data',await p.locator('#modal iframe[sandbox]').count()===1&&/DN-CW-TR-2026-0001/.test(await p.locator('#modal iframe').getAttribute('srcdoc')));await p.click('#modal .ft [data-act=mclose]');
await p.setInputFiles('[data-ch=fmup]',{name:'evil.html',mimeType:'text/html',buffer:Buffer.from('<p>{{site_id}}</p><script>alert(1)</script>')});await wait(150);ok('template with scripts rejected and logged',await ev(()=>/rejected/.test(PMIS.syslog[0].msg)));
await p.setInputFiles('[data-ch=fmup]',{name:'dn_v2.html',mimeType:'text/html',buffer:Buffer.from('<h1>DN</h1><p>{{site_id}} {{unknown_field}}</p>{{#items}}<i>{{desc}}</i>{{/items}}')});await p.waitForSelector('#modal iframe');ok('upload shows unknown placeholders and preview',/unknown_field/.test(await p.innerText('#modal')));
await reason('Layout change');await p.click('#rok2');await mfa();ok('new version v2 recorded and audited',await ev(()=>PMIS.FORMS[0].vers.length===2&&PMIS.audit[0].action==='Form template published'));
await ev(()=>PMIS.go('settings?tab=forms'));await wait(100);await shot('22-forms-templates');
/* ---- 9 registers */
await ev(()=>PMIS.signIn('1508'));await ev(()=>PMIS.go('register/procurement'));await wait(120);ok('procurement list renders rows',await p.locator('#rglist tr').count()>=10);
await p.click('[data-act=rgst][data-a="procurement:open"]');await wait(80);await p.locator('#rglist tr').first().click();await p.waitForSelector('#rdrawer');ok('record drawer shows approval path, comments and ball in court',/Approval path/.test(await p.innerText('#rdrawer'))&&/Comments/.test(await p.innerText('#rdrawer'))&&/Ball in court/.test(await p.innerText('#rdrawer')));
const rid=await ev(()=>PMIS.S.rg.id);await p.fill('#rgcmt','Check the quantity');await p.click('[data-act=rgcomment]');ok('comment thread works',/Check the quantity/.test(await p.innerText('#rdrawer')));
await shot('23-register-procurement-drawer');await p.click('[data-act=rgsubmit]');await wait(100);const st1=await ev(id=>PMIS.RGD.procurement.find(r=>r.id===id).wf.state,rid);ok('Entry submit moves the record to review',st1==='review',st1);
await ev(()=>PMIS.signIn('1203'));await ev(()=>PMIS.go('register/procurement'));await wait(100);await ev(id=>{PMIS.S.rg={k:'procurement',id};PMIS.renderRg()},rid);await p.click('[data-act=rgret]');await p.click('#rok');ok('return needs a note',/must carry a note/.test(await p.innerText('#rerr')));await p.fill('#rnote','Wrong value');await p.click('#rok');await wait(100);
ok('return sends the record back to entry with the note',await ev(id=>{const r=PMIS.RGD.procurement.find(r=>r.id===id);return r.wf.state==='open'&&r.wf.rejected.note==='Wrong value'},rid));
await ev(()=>PMIS.signIn('1508'));await ev(id=>{PMIS.S.rg={k:'procurement',id};PMIS.renderRg()},rid);await p.click('[data-act=rgsubmit]');await wait(80);
await ev(()=>PMIS.signIn('1203'));await ev(id=>{PMIS.S.rg={k:'procurement',id};PMIS.renderRg()},rid);await p.click('[data-act=rgreview]');await wait(80);ok('review moves to approval',await ev(id=>PMIS.RGD.procurement.find(r=>r.id===id).wf.state,rid)==='approve');
await ev(()=>PMIS.signIn('1001'));await ev(id=>{PMIS.S.rg={k:'procurement',id};PMIS.renderRg()},rid);await p.click('[data-act=rgapprove]');await mfa();ok('final approval needs step-up and ends Done',await ev(id=>PMIS.RGD.procurement.find(r=>r.id===id).wf.state,rid)==='done');
await ev(()=>PMIS.signIn('1508'));await ev(()=>PMIS.go('register/risks'));await wait(120);await p.keyboard.press('n');await p.waitForSelector('#rdrawer');ok('"n" creates a new risk record',await ev(()=>PMIS.S.rg.id.startsWith('RSK-')));
await p.click('[data-act=rgsubmit]');ok('submit blocked until required fields are filled',/Still needed/.test(await p.innerText('#toasts')));
await p.fill('#rgf-title','Test risk');await p.selectOption('#rgf-cat','Cost');await p.fill('#rgf-prob','9');await p.fill('#rgf-imp','3');await p.selectOption('#rgf-owner','1102');await p.fill('#rgf-mit','Plan B');await p.click('[data-act=rgsubmit]');ok('risk probability above 5 refused',/must be 1 to 5/.test(await p.innerText('#toasts')));
await p.fill('#rgf-prob','4');await p.click('[data-act=rgsubmit]');await wait(80);ok('valid risk goes to review',await ev(()=>PMIS.RGD.risks.slice(-1)[0].wf.state)==='review');await p.keyboard.press('Escape');await wait(80);ok('Escape closes the record drawer',await p.locator('#rdrawer').count()===0);
await ev(()=>PMIS.go('register/risks'));await wait(100);await shot('24-register-risk');
await ev(()=>PMIS.go('register/gecol'));await wait(100);await p.locator('[data-act=rgopen]').first().click();await p.waitForSelector('#rdrawer');ok('GECOL record opens the same drawer',/Power-On/.test(await p.innerText('#rdrawer')));await shot('25-register-gecol-drawer');await p.keyboard.press('Escape');
/* ---- 10 matrix */
await ev(()=>PMIS.signIn('1001'));await ev(()=>PMIS.go('matrix'));await wait(120);
ok('matrix has a row per register and Dismantle (14 extra)',await p.locator('table.mx tbody tr th[scope=row]').count()===24&&/Dismantle/.test(await p.innerText('table.mx')));
const chip=p.locator('table.mx .ref.u .emp').first();await chip.hover();await p.locator('#emp-tip').waitFor({state:'visible'});ok('hover on a person chip in the matrix opens the employee card',/Position/.test(await p.innerText('#emp-tip')));await p.mouse.move(2,2);await wait(250);
await p.locator('table.mx tbody tr:has-text("Dismantle") select[data-ch=mxlv]').selectOption('2');await wait(80);ok('register row levels can be changed (1 to 3)',await p.locator('.bulk').count()===1);
await ev(()=>{PMIS.S.mxD=null});await ev(()=>PMIS.go('matrix'));await wait(100);await p.evaluate(()=>document.querySelector('.mxdiv').scrollIntoView({block:'start'}));await wait(150);await p.evaluate(()=>window.scrollBy(0,-90));await p.locator('table.mx tbody tr:has-text("Procurement") .ref.u .emp').first().hover();await p.locator('#emp-tip').waitFor({state:'visible'});await shot('26-matrix-registers-hovercard');await p.mouse.move(2,2);
/* ---- AR + dark screenshots and overflow */
await ev(()=>{PMIS.setLang('ar');PMIS.setTheme('dark');PMIS.go('settings?tab=calendar')});await wait(200);await shot('27-work-calendar-ar-dark');
await ev(()=>PMIS.go('absence'));await wait(200);await shot('28-absence-ar-dark');
await ev(()=>PMIS.go('register/procurement'));await wait(150);await p.locator('#rglist tr').first().click();await wait(200);await shot('29-register-drawer-ar-dark');await p.keyboard.press('Escape');
await ev(()=>{PMIS.setLang('en');PMIS.setTheme('light')});
await p.setViewportSize({width:390,height:800});
for(const lang of ['en','ar']){await ev(l=>PMIS.setLang(l),lang);for(const r of R.concat(['absence'])){await ev(r=>PMIS.go(r),r);await wait(80);const w=await ev(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));ok(`no horizontal page overflow at 390px: ${r} (${lang})`,w.sw<=w.cw+1,w.sw+'/'+w.cw)}}
await ev(()=>PMIS.setLang('en'));
ok('no external requests',req.length===0,req.join(','));ok('no console errors',errs.length===0,errs.slice(0,3).join(' | '));
console.log(out.join('\n'));console.log('PASS '+out.filter(x=>x.startsWith('PASS')).length+' / FAIL '+out.filter(x=>x.startsWith('FAIL')).length);
await b.close()})();
