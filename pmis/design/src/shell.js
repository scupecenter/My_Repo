/* ================= shell, router, login, palette ================= */
const REGS=[['procurement','Procurement (PR / PO / WO)'],['contractors','Contractors'],['gecol','GECOL power'],['hlc','HLC fiber'],['permits','Permits & HSE'],['warehouse','Warehouse'],['quality','Quality'],['issues','Issue Log'],['risks','Risk Register'],['change','Change Control'],['readiness','Readiness & Handover'],['asbuilt','As-Built'],['meetings','Meetings']];
const PAGES={'my-work':['home','My Work'],approvals:['inbox','Approvals'],sites:['grid','Sites'],dashboard:['chart','Dashboard'],templates:['file','Templates'],upload:['upload','Upload wizard'],users:['users','Users & Roles'],groups:['users','Groups'],matrix:['table','Responsibility Matrix'],delegation:['shield','Delegation'],library:['book','Document Library'],audit:['eye','Audit Log'],system:['alert','System Log'],settings:['pen','Settings']};
const ADMIN_ONLY=['settings','users','groups','matrix','delegation','library','system'];
function parseHash(){const h=location.hash.replace(/^#\/?/,'');const[p,qs]=h.split('?');const q=Object.fromEntries(new URLSearchParams(qs||''));const a=p.split('/').filter(Boolean);return{name:a[0]||'',args:a.slice(1),q}}
function go(path){if(location.hash==='#/'+path)render();else location.hash='#/'+path}
function allowed(name,args){const u=me();if(!u)return false;
 if(ADMIN_ONLY.includes(name))return isAdmin(u);if(name==='audit')return isAdmin(u)||PERMS.indexOf(u.perm)>=3;
 if(name==='approvals')return PERMS.indexOf(u.perm)>=2||isAdmin(u);if(name==='upload')return PERMS.indexOf(u.perm)>=1||isAdmin(u);
 if(name==='register')return u.modules==='all'||u.modules.includes('Registers');return true}
function setLang(l){S.lang=l;store.set('pmis.lang',l);applyLang();render();renderDrawer()}
function applyLang(){document.documentElement.lang=S.lang;document.documentElement.dir=S.lang==='ar'?'rtl':'ltr'}
function setTheme(th){S.theme=th;store.set('pmis.theme',th);document.documentElement.dataset.theme=th==='dark'?'dark':'light';render()}
function signIn(id){S.uid=id;try{sessionStorage.setItem('pmis.uid',id)}catch(e){}const u=me();audit('Signed in','Session','Microsoft 365 + employee ID');go(u.status==='Pending'?'pending':'my-work')}
function signOut(){S.uid=null;S.drawer=null;try{sessionStorage.removeItem('pmis.uid')}catch(e){}closeModal();location.hash='#/login';render()}
const brand=()=>`<div class="brand"><span class="mk" aria-hidden="true">G</span><span>GSDN PMIS</span></div>`;
function navHtml(r){const u=me(),inb=PERMS.indexOf(u.perm)>=2||isAdmin(u)?inbox(u).length:0;
 const a=(k,href,icn,lbl,bdg)=>`<a href="#/${href}" class="${r.name===k||r.name+'/'+r.args[0]===href?'on':''}" ${r.name===k?'aria-current="page"':''}>${ic(icn)}<span class="lb">${t(lbl)}</span>${bdg?`<span class="bdg">${bdg}</span>`:''}</a>`;
 let h=`<div class="gh">${t('Work')}</div>`+a('my-work','my-work','home','My Work')+(allowed('approvals')?a('approvals','approvals','inbox','Approvals',inb||''):'')+a('sites','sites','grid','Sites')+a('dashboard','dashboard','chart','Dashboard');
 h+=`<div class="gh">${t('Data entry')}</div>`+a('templates','templates','file','Templates')+(allowed('upload')?a('upload','upload','upload','Upload wizard'):'');
 h+=`<div class="gh">${t('Registers')}</div><details ${r.name==='register'?'open':''}><summary>${ic('layers')}<span class="lb">${t('All registers')}</span></summary><div class="sub">${REGS.map(([k,l])=>`<a href="#/register/${k}" class="${r.name==='register'&&r.args[0]===k?'on':''}">${t(l)}</a>`).join('')}</div></details>`;
 if(isAdmin(u)||PERMS.indexOf(u.perm)>=3){h+=`<div class="gh">${t('Administration')}</div>`;if(isAdmin(u))h+=a('users','users','users','Users & Roles')+a('groups','groups','users','Groups')+a('matrix','matrix','table','Responsibility Matrix')+a('delegation','delegation','shield','Delegation')+a('library','library','book','Document Library')+a('settings','settings','pen','Settings');h+=a('audit','audit','eye','Audit Log');if(isAdmin(u))h+=a('system','system','alert','System Log')}
 return h}
function title(r){if(r.name==='site')return r.args[0]||'';if(r.name==='register')return t((REGS.find(x=>x[0]===r.args[0])||[0,'Register'])[1]);return t((PAGES[r.name]||[0,''])[1])}
function chrome(r,body){const u=me(),dg=delegateOf(u);
 return`<div class="shell ${S.mini?'mini':''}" id="shell"><aside class="side" id="side" aria-label="${t('Main navigation')}">${brand()}<nav class="nav">${navHtml(r)}</nav><div class="sfoot">${t('Synthetic data · as of')} <span class="mono">${TODAY}</span></div></aside>
 <div class="main"><header class="top"><button class="ibtn burger" data-act="burger" aria-label="${t('Menu')}">${ic('menu')}</button><button class="ibtn hide-m" data-act="mini" aria-label="${t('Collapse sidebar')}">${ic('menu')}</button>
 <div class="crumb">${t('GSDN PMIS')} / <b>${esc(title(r))}</b></div><div class="sp"></div>
 <button class="kbtn" data-act="palette" aria-label="${t('Search and commands')}">${ic('search')}<span class="lbl">${t('Search or jump to…')}</span><kbd>Ctrl K</kbd></button>
 <button class="ibtn" data-act="lang" aria-label="${t('Switch language')}" title="EN / AR"><b style="font-size:13px">${S.lang==='ar'?'EN':'ع'}</b></button>
 <button class="ibtn" data-act="theme" aria-label="${t('Toggle dark mode')}">${ic(S.theme==='dark'?'sun':'moon')}</button>
 <div style="position:relative"><button class="ibtn" data-act="bell" aria-label="${t('Notifications')}">${ic('bell')}${inbox(u).length&&allowed('approvals')?`<span class="bd">${Math.min(99,inbox(u).length)}</span>`:''}</button><div id="bellm"></div></div>
 <div style="position:relative"><button class="me" data-act="umenu" aria-haspopup="menu">${av(u)}<span class="nm2">${esc(u.name)}</span></button><div id="umenu"></div></div></header>
 ${dg?`<div class="banner open" style="margin:10px 22px 0">${ic('shield')}<span>${t('You hold delegated rights from System Admin until')} <b class="mono">${dg.until}</b>. ${t('Your actions are logged as "{n} on behalf of System Admin".',{n:u.name})}</span></div>`:''}
 <main class="page" id="page" tabindex="-1">${body}</main></div></div>`}
function stateView(kind,r){const m={loading:null,empty:['inbox','Nothing here yet','There are no records for this screen. New records appear here once they are entered or imported.'],error:['alert','Could not load this screen','The server did not answer. Your data is safe. Check the connection and try again.'],denied:['lock','You do not have access','Your permission level or visibility does not include this screen. Ask a System Admin if you need it.']}[kind];
 if(kind==='loading')return`<div class="ph"><h1>${esc(title(r))}</h1></div><div class="card cb" aria-busy="true" role="status"><span class="sr">${t('Loading')}</span>${'<div class="sk" style="width:60%"></div><div class="sk"></div><div class="sk" style="width:85%"></div>'.repeat(4)}</div>`;
 return`<div class="ph"><h1>${esc(title(r))}</h1></div><div class="card"><div class="state ${kind==='error'?'err':kind==='denied'?'deny':''}" role="${kind==='error'?'alert':'status'}"><div class="big">${ic(m[0])}</div><h3>${t(m[1])}</h3><p>${t(m[2])}</p>${kind==='error'?`<button class="btn pri" data-act="simclear">${ic('undo')}${t('Retry')}</button>`:kind==='empty'?'':`<button class="btn" data-act="home">${t('Back to My Work')}</button>`}</div></div>`}
function viewFor(r){const V={'my-work':vMyWork,approvals:vApprovals,sites:vSites,site:vSite,dashboard:vDashboard,templates:vTemplates,upload:vUpload,users:vUsers,groups:vGroups,matrix:vMatrix,delegation:vDelegation,library:vLibrary,audit:vAudit,system:vSystem,settings:vSettings,register:vRegister};return V[r.name]}
function render(){empHide();const r=parseHash();const root=$('#app');applyLang();document.documentElement.dataset.theme=S.theme==='dark'?'dark':'light';
 if(!me()){if(location.hash!=='#/login')history.replaceState(null,'','#/login');root.innerHTML=vLogin();return}
 if(me().status==='Pending'){root.innerHTML=vPending();return}
 if(!r.name||r.name==='login'||r.name==='pending'){history.replaceState(null,'','#/my-work');return render()}
 const fn=viewFor(r);let body;
 if(!fn)body=stateView('empty',r);else if(S.sim&&S.sim!=='')body=stateView(S.sim,r);else if(!allowed(r.name,r.args))body=stateView('denied',r);
 else{try{body=fn(r)}catch(e){console.error(e);syslog('ERROR','UI',String(e));body=stateView('error',r)}}
 const keepScroll=window.scrollY;root.innerHTML=chrome(r,body);
 const wasSame=render._last===location.hash;render._last=location.hash;if(!wasSame){window.scrollTo(0,0);const m=$('#page');m&&m.focus({preventScroll:true})}else window.scrollTo(0,keepScroll);
 if(r.name==='site'&&r.q.task!=null&&!S.drawer)openTask(r.args[0],r.q.task,true);
 afterRender&&afterRender(r)}
let afterRender=null;
function vLogin(){const L=S.login||(S.login={step:'start',err:''});
 const demo=[1001,1102,1204,1203,1305,1407,1999].map(i=>U2[i]);
 return`<div class="login"><div class="art"><div><div class="brand" style="padding:0">${'<span class="mk" aria-hidden="true">G</span>'}<span>GSDN PMIS</span></div></div><div><h1>${t('Every site, every task, one approved record.')}</h1><p class="mute" style="max-width:440px">${t('Entry, review and approval for all 10 milestones, with documents and QC photos attached to the task they close.')}</p><div class="rail" aria-hidden="true"><i class="d"></i><i class="d"></i><i class="d"></i><i class="c"></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div><div class="hint">${t('Synthetic data only. No real names.')}</div></div>
 <div class="form"><div class="box"><div class="row" style="justify-content:flex-end;gap:6px"><button class="btn sm ghost" data-act="lang">${S.lang==='ar'?'English':'العربية'}</button><button class="btn sm ghost" data-act="theme">${ic(S.theme==='dark'?'sun':'moon')}</button></div>
 <h2 style="font-size:var(--text-4xl)">${t('Sign in')}</h2><p class="mute">${t('Aljeel employees only. Vendors and contractors never sign in; staff enter their data for them.')}</p>
 ${L.step==='start'?`<button class="msbtn" data-act="m365"><span class="msico" aria-hidden="true"><i style="background:#f25022"></i><i style="background:#7fba00"></i><i style="background:#00a4ef"></i><i style="background:#ffb900"></i></span>${t('Sign in with Microsoft 365')}</button>
 <div class="or">${t('then confirm your employee ID')}</div><p class="hint">${t('After Microsoft 365, you enter your 4-digit employee ID. It is asked once, the first time.')}</p>
 <div class="demo"><div class="hint" style="margin-bottom:4px">${t('Demo users (skip sign-in)')}</div>${demo.map(u=>`<button data-act="demo" data-a="${u.id}">${av(u)}<span style="flex:1"><b>${esc(u.name)}</b><br><small class="mute">${esc(u.status==='Pending'?t('New account · pending assignment'):u.role+' · '+t(u.perm))}</small></span><span class="mono mute">${u.id}</span></button>`).join('')}</div>`
 :`<div class="chip" style="margin:12px 0">${ic('check')}<span class="mono">m365.user@aljeel.example</span></div><form data-form="idlogin" novalidate><label class="fld"><span>${t('Employee ID (4 digits)')}</span><div class="idbox"><input class="inp ${L.err?'bad':''}" id="empid" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" autocomplete="off" aria-describedby="iderr" placeholder="0000" value="${esc(L.val||'')}"></div></label><div id="iderr" class="err" role="alert">${L.err?esc(t(L.err)):''}</div><div class="row" style="margin-top:12px"><button type="button" class="btn" data-act="loginback">${t('Back')}</button><button class="btn pri sp" type="submit">${t('Continue')}</button></div><p class="hint">${t('Try 1001, 1204 or 1999 (new account).')}</p></form>`}
 </div></div></div>`}
function vPending(){const u=me();return`<div class="login" style="grid-template-columns:1fr"><div class="form"><div class="box card cb" style="padding:24px"><div class="state" style="padding:12px"><div class="big">${ic('clock')}</div><h2 style="margin-top:10px">${t('Pending assignment')}</h2><p>${t('Your account is created and your employee ID is linked. A System Admin must assign your role, team, permission level, regions and modules. Until then you cannot see any data.')}</p></div>
 <div class="row" style="justify-content:center;gap:10px">${av(u)}<div><b>${esc(u.name)}</b><br><span class="mono mute">${u.id}</span></div></div><div class="row" style="justify-content:center;margin-top:16px;gap:8px"><button class="btn pri" data-act="notifyadmin">${t('Notify System Admin')}</button><button class="btn" data-act="signout">${t('Sign out')}</button></div></div></div></div>`}
/* ---------- palette */
function palItems(q){const u=me(),ql=q.toLowerCase().trim();const it=[];
 Object.entries(PAGES).forEach(([k,[icn,l]])=>{if(allowed(k))it.push({ic:icn,txt:t(l),hint:t('Go to'),run:()=>go(k)})});
 REGS.forEach(([k,l])=>{it.push({ic:'layers',txt:t(l),hint:t('Register'),run:()=>go('register/'+k)})});
 it.push({ic:'moon',txt:t('Toggle dark mode'),hint:t('Action'),run:()=>setTheme(S.theme==='dark'?'light':'dark')},{ic:'globe',txt:t('Switch language'),hint:t('Action'),run:()=>setLang(S.lang==='ar'?'en':'ar')});
 if(allowed('approvals'))it.push({ic:'check',txt:t('Open next item awaiting me'),hint:t('Action'),run:()=>{const f=inbox(u)[0];f?go('approvals?sel='+f.key):toast(t('Nothing is waiting for you'))}});
 it.push({ic:'download',txt:t('Download Master template'),hint:t('Action'),run:()=>dlTemplate(TEMPLATES[0])});
 let res=ql?it.filter(x=>x.txt.toLowerCase().includes(ql)):it.slice(0,9);
 if(ql){const ss=mySites().filter(s=>(s.id+' '+s.name+' '+s.region).toLowerCase().includes(ql)).slice(0,8).map(s=>({ic:'grid',txt:`${s.id} · ${s.name}`,hint:t(s.region),run:()=>go('site/'+s.id)}));res=[...res,...ss]}
 return res.slice(0,14)}
function openPalette(){if($('#pal'))return;const d=document.createElement('div');d.className='pal';d.id='pal';d.setAttribute('role','dialog');d.setAttribute('aria-label',t('Command palette'));
 d.innerHTML=`<div class="bg" data-act="palclose"></div><div class="box"><input id="palq" placeholder="${t('Type a site ID, a page or an action…')}" aria-label="${t('Search')}" autocomplete="off"><ul id="pall" role="listbox"></ul><div class="hint" style="padding:6px 12px;border-top:1px solid var(--line)"><kbd>↑</kbd> <kbd>↓</kbd> ${t('move')} · <kbd>Enter</kbd> ${t('open')} · <kbd>Esc</kbd> ${t('close')}</div></div>`;document.body.append(d);
 let cur=0,items=[];const draw=()=>{items=palItems($('#palq').value);cur=Math.min(cur,Math.max(0,items.length-1));$('#pall').innerHTML=items.length?items.map((x,i)=>`<li role="option" aria-selected="${i===cur}" class="${i===cur?'on':''}" data-i="${i}">${ic(x.ic)}<span>${esc(x.txt)}</span><small>${esc(x.hint)}</small></li>`).join(''):`<li class="mute">${t('No matches')}</li>`};
 const run=i=>{const x=items[i];closePal();x&&x.run()};
 $('#palq').oninput=()=>{cur=0;draw()};$('#palq').onkeydown=e=>{if(e.key==='ArrowDown'){cur=Math.min(items.length-1,cur+1);draw();e.preventDefault()}else if(e.key==='ArrowUp'){cur=Math.max(0,cur-1);draw();e.preventDefault()}else if(e.key==='Enter'){run(cur);e.preventDefault()}};
 $('#pall').onclick=e=>{const li=e.target.closest('li[data-i]');li&&run(+li.dataset.i)};draw();$('#palq').focus()}
function closePal(){const p=$('#pal');p&&p.remove()}
