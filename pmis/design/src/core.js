/* ================= core: helpers, i18n, state, extended data ================= */
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TODAY=REPORT;const PERMS=['view','entry','review','approve','admin'];
const store={get(k,d){try{return localStorage.getItem(k)??d}catch(e){return d}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
const S={lang:store.get('pmis.lang','en'),theme:store.get('pmis.theme','light'),mini:false,uid:null,sim:'',drawer:null,sel:new Set(),dsel:new Set(),f:{}};
try{S.uid=sessionStorage.getItem('pmis.uid')||null}catch(e){}
const t=(k,v)=>{let s=(S.lang==='ar'&&AR[k])||k;if(v)for(const x in v)s=s.split('{'+x+'}').join(v[x]);return s};
const ICONS={check:'M5 12l5 5L20 7',x:'M6 6l12 12M18 6L6 18',clock:'M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',alert:'M12 8v5M12 16.5v.5M10.3 3.9L2.5 18a2 2 0 001.7 3h15.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',lock:'M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z',download:'M12 4v11M7 11l5 5 5-5M5 20h14',upload:'M12 16V5M7 9l5-5 5 5M5 20h14',search:'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',bell:'M6 16V11a6 6 0 1112 0v5l2 2H4zM10 21h4',sun:'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',moon:'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',globe:'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',menu:'M4 6h16M4 12h16M4 18h16',chev:'M9 6l6 6-6 6',plus:'M12 5v14M5 12h14',file:'M7 3h7l5 5v13H7zM14 3v5h5',camera:'M4 8h3l2-3h6l2 3h3v12H4zM12 17a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',users:'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2 20c0-3.5 3-6 7-6s7 2.5 7 6M17 5a3 3 0 010 6M19 14c2 .8 3 2.5 3 5',user:'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.5-6 8-6s8 2 8 6',home:'M4 11l8-7 8 7v9H4z',grid:'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',list:'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',shield:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',chart:'M4 20V10M10 20V4M16 20v-8M22 20H2',msg:'M4 5h16v11H9l-5 4z',more:'M5 12h.01M12 12h.01M19 12h.01',filter:'M3 5h18l-7 8v6l-4 2v-8z',pen:'M4 20l4-1L19 8l-3-3L5 16z',undo:'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',book:'M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h11',inbox:'M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5',table:'M3 5h18v14H3zM3 10h18M9 5v14',clipboard:'M9 4h6v3H9zM6 5h3M15 5h3v16H6V5',phone:'M8 3h8v18H8zM11 18h2',layers:'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',link:'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',arrow:'M5 12h14M13 6l6 6-6 6'};
const ic=(n,c='')=>`<svg class="ic ${c}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n]||''}"/></svg>`;
const initials=n=>n.split(' ').map(x=>x[0]).join('').slice(0,2);
const av=u=>u?`<span class="av" style="background:${u.c||'#555'}" aria-hidden="true">${esc(initials(u.name))}</span>`:'';
const fdate=d=>d?`<span class="mono">${esc(d)}</span>`:'<span class="mute">—</span>';
/* ---------- extended synthetic data (roles, groups, matrix cells, documents) */
const PMAP={1001:'admin',1102:'approve',1103:'entry',1203:'approve',1204:'review',1205:'entry',1206:'entry',1207:'entry',1305:'approve',1306:'entry',1307:'entry',1407:'view',1508:'admin',1509:'entry'};
USERS.forEach(u=>{if(u.role==='Site Engineers')u.role=u.sub==='CW Team Lead'?'Site Engineers (CW)':'Site Engineers (TE)';u.perm=PMAP[u.id];u.status='Active';u.team=u.id.startsWith('13')?'TE':u.id.startsWith('12')?'CW':'—';u.modules='all';if(u.regions!=='all')u.regions=[...u.regions]});
USERS.find(u=>u.id==='1203').team='CW';USERS.find(u=>u.id==='1001').team='CW + TE';
USERS.push({id:'1999',name:'Noor Hadi',role:'—',regions:[],c:'#6b6b6b',perm:'view',status:'Pending',team:'—',modules:[],m365:true});
USERS.push({id:'1210',name:'Hana Zidan',role:'—',regions:[],c:'#7a6a55',perm:'view',status:'Pending',team:'—',modules:[],m365:true});
USERS.push({id:'1211',name:'Wael Saadi',role:'—',regions:[],c:'#557a6a',perm:'view',status:'Pending',team:'—',modules:[],m365:true});
/* role assignments: many-to-many; each row has its own permission, regions, modules, validity */
const ROLE_PARENT={'RF Engineer':ROLES6[1],'MW Engineer':ROLES6[1],'Acquisition Team':ROLES6[1],'Power Engineer':ROLES6[2],'GECOL Power Team':ROLES6[2],'HLC Fiber Team':ROLES6[2],'Site Engineers (CW)':ROLES6[2],'Site Engineers (TE)':ROLES6[3],'HOTO Engineer':ROLES6[3],'Project Procurement Team':ROLES6[5]};
const ROLE_LIST=[...ROLES6,...Object.keys(ROLE_PARENT)];
const ASSIGN=[];let AS_N=0;
const newAs=(o)=>Object.assign({id:'A'+(++AS_N),perm:'entry',regions:'all',modules:'all',from:'2026-01-01',until:''},o);
USERS.forEach(u=>{if(u.status==='Pending')return;ASSIGN.push(newAs({uid:u.id,role:u.role,perm:u.perm,regions:u.regions==='all'?'all':[...u.regions]}))});
ASSIGN.push(newAs({uid:'1102',role:'Acquisition Team',perm:'entry',regions:['Tripoli Area'],modules:['Sites','Templates'],from:'2026-09-01',until:'2026-12-31'}),newAs({uid:'1305',role:'HOTO Engineer',perm:'entry'}),newAs({uid:'1203',role:'Power Engineer',perm:'review',regions:['Tripoli Area','Zawia Area']}),newAs({uid:'1204',role:'Site Engineers (TE)',perm:'entry',regions:['Tripoli Area'],until:'2026-10-10'}));
const asActive=a=>a.from<=TODAY&&(!a.until||a.until>=TODAY);
const hasRole=(u,r)=>ASSIGN.some(a=>a.uid===u.id&&asActive(a)&&(a.role===r||ROLE_PARENT[a.role]===r));
function recalcUsers(){USERS.forEach(u=>{const as=ASSIGN.filter(a=>a.uid===u.id&&asActive(a));
 u.perm=as.reduce((m,a)=>PERMS.indexOf(a.perm)>PERMS.indexOf(m)?a.perm:m,'view');
 u.regions=as.some(a=>a.regions==='all')?'all':[...new Set(as.flatMap(a=>a.regions))];
 u.modules=as.some(a=>a.modules==='all')?'all':[...new Set(as.flatMap(a=>a.modules))];
 const first=ASSIGN.find(a=>a.uid===u.id&&asActive(a));u.role=first?first.role:'—';u.nRoles=as.length;
 if(u.status==='Active'&&!as.length&&u.role==='—')u.regions=[]})}
recalcUsers();
const U2=Object.fromEntries(USERS.map(u=>[u.id,u]));
const MODS=['Sites','Approvals','Templates','Registers','Dashboard'];
const GROUPS=[{id:'G1',name:'System Admins',members:['1001','1508'],note:'Full control. At least one active member is always required.'},
 {id:'G2',name:'CW Reviewers Tripoli',members:['1203','1204'],note:'Review CW tasks in Tripoli and Zawia.'},
 {id:'G3',name:'TE Reviewers',members:['1305','1307'],note:'Review TE tasks.'},
 {id:'G4',name:'Closure Approvers',members:['1001','1305'],note:'Final Closure approval (all must approve).'}];
const ref=(k,id)=>({k,id});
const MX=MATRIX.map((m,i)=>({levels:3,entry:{m:m.entry.map(x=>ref('u',x)),rule:'any'},review:{m:m.review.map(x=>ref('u',x)),rule:'any'},approve:{m:m.approve.map(x=>ref('u',x)),rule:'any'}}));
MX[1].review={m:[ref('g','G2')],rule:'any'};MX[2].review={m:[ref('g','G2'),ref('r','CW Team Lead')],rule:'any'};
MX[3].entry.m.push(ref("r","HLC Fiber Team"));MX[4].review={m:[ref('g','G3')],rule:'any'};MX[9].approve={m:[ref('g','G4')],rule:'all'};

/* matrix rows for registers and Dismantle (B11): index 10.. in MX, each with its own holders and levels */
const REGS=[['procurement','Procurement (PR / PO / WO)'],['contractors','Contractors'],['gecol','GECOL power'],['hlc','HLC fiber'],['permits','Permits & HSE'],['warehouse','Warehouse'],['quality','Quality'],['issues','Issue Log'],['risks','Risk Register'],['change','Change Control'],['readiness','Readiness & Handover'],['asbuilt','As-Built'],['meetings','Meetings']];
const MXROWS=[...REGS,['dismantle','Dismantle']];const MXLIST=[...STAGES,...MXROWS.map(r=>r[1])];
(()=>{const D={procurement:['Project Support','1203','1001'],contractors:['Project Support','CW Team Lead','Project Manager'],gecol:['GECOL Power Team','CW Team Lead','Project Manager'],hlc:['HLC Fiber Team','CW Team Lead','Project Manager'],permits:['Project Support','CW Team Lead','Project Manager'],warehouse:['Project Support','CW Team Lead','Project Manager'],quality:['Site Engineers (CW)','CW Team Lead','Project Manager'],issues:['Project Support',0,'Project Manager'],risks:['Project Support','1203','1001'],change:['Project Support','TE Team Lead','Project Manager'],readiness:['Site Engineers (TE)','TE Team Lead','Project Manager'],asbuilt:['Site Engineers (CW)','CW Team Lead','Project Manager'],meetings:['Project Support',0,0],dismantle:['Site Engineers (TE)','TE Team Lead','Project Manager']};
 MXROWS.forEach(([k])=>{const d=D[k],c=r=>({m:r?[/^\d{4}$/.test(r)?ref('u',r):ref('r',r)]:[],rule:'any'});MX.push({levels:d[2]?(d[1]?3:2):1,entry:c(d[0]),review:c(d[1]),approve:c(d[2])})})})();
const DELEG=[{id:'D1',to:'1102',scope:'Partial',rights:['Unlock task','Skip / mark N/A'],from:'2026-10-18',until:'2026-11-18',by:'1001',active:true}];
/* Site RFI is an actionable date task (decision: date field with review and approval) */
const iMS4=STEPS.findIndex(s=>s.code==='MS4');STEPS[iMS4].ms=false;STEPS[iMS4].name='Site RFI date';
SITES.forEach(s=>{s.tasks.forEach(x=>{x.hist=(x.hist||[]).map(h=>Array.isArray(h)?{a:h[0],at:h[1],by:h[2]}:h);x.notes=x.notes||[]});
 const x=s.tasks[iMS4];if(x.state==='na')return;
 const later=s.tasks.some((y,i)=>i>iMS4&&!STEPS[i].ms&&y.state!=='lock'&&y.state!=='na');
 if(!later){x.state='lock';x.act='';x.hist=[]}else if(!x.hist.length){x.hist=[{a:'Entered',at:x.act,by:MX[3].entry.m[0].id},{a:'Reviewed',at:x.act,by:'1203'},{a:'Approved',at:x.act,by:'1001'}]}});
SITES.forEach(recompute);
SITES.forEach(s=>{s.airport=hsh(s.id)%7===0;s.outsourced=hsh(s.id)%4!==0;s.cwTower=s.tower.includes('New')});
function hsh(str){let h=0;for(const c of str)h=(h*31+c.charCodeAt(0))>>>0;return h}
/* ---------- document library (data, not code) */
const RULES={'':'—',airport:'Near an airport',outsourced:'Outsourced work only',tower:'Tower analysis required'};
const DOCLIB=[];
function addDoc(o){DOCLIB.push(Object.assign({kind:'scanned',mand:'mandatory',rule:'',fmt:'PDF, JPG, PNG',maxMB:20,min:1,max:5,expiry:'',blank:'',active:true,ver:1,reviewed:true,photo:null,camera:false},o))}
addDoc({id:'A1',en:'SAR (each candidate)',ar:'تقرير البحث عن موقع (لكل مرشح)',place:['A1'],min:1,max:6});
addDoc({id:'A2',en:'TSSR',ar:'تقرير مسح الموقع الفني',place:['A2'],blank:'TPL-RF'});
addDoc({id:'A3',en:'Owner contract (or contract with tower owner)',ar:'عقد المالك (أو عقد مالك البرج)',place:['A3']});
addDoc({id:'A3b',en:'Civil aviation permit',ar:'تصريح الطيران المدني',place:['A3'],mand:'conditional',rule:'airport',expiry:'365'});
addDoc({id:'A4',en:'LLD',ar:'التصميم منخفض المستوى',place:['A4']});
addDoc({id:'B1',en:'PR email',ar:'بريد طلب الشراء',kind:'email',place:['B1'],mand:'conditional',rule:'outsourced',fmt:'PDF, EML, MSG'});
addDoc({id:'B2',en:'PO/WO email or internal work order',ar:'بريد أمر الشراء/العمل أو أمر عمل داخلي',kind:'email',place:['B2'],fmt:'PDF, EML, MSG'});
addDoc({id:'B3',en:'CW access permission',ar:'تصريح دخول الأعمال المدنية',place:['B3'],expiry:'90'});
addDoc({id:'B4',en:'STA/ST report',ar:'تقرير تحليل البرج',kind:'report',place:['B4'],mand:'conditional',rule:'tower'});
addDoc({id:'B6',en:'Layout',ar:'المخطط',place:['B6'],fmt:'PDF, DWG, PNG'});
addDoc({id:'B7',en:'Approval email',ar:'بريد الموافقة',kind:'email',place:['B7'],fmt:'PDF, EML, MSG'});
addDoc({id:'B7b',en:'CW DN',ar:'إشعار تسليم الأعمال المدنية',place:['B7']});
addDoc({id:'B9',en:'MOS proof photos',ar:'صور إثبات طريقة التنفيذ',kind:'photo',place:['B9'],fmt:'JPG, PNG, HEIC',maxMB:10,min:3,max:12,camera:true,photo:{shots:['Site overview','Safety setup','Work area'],geo:true}});
addDoc({id:'B13',en:'CW PAC (signed)',ar:'محضر قبول الأعمال المدنية الأولي',place:['B13'],blank:'TPL-SITE'});
STEPS.filter(s=>s.doc&&!DOCLIB.some(d=>d.place.includes(s.code))).forEach(s=>addDoc({id:s.code,en:s.doc,ar:s.doc,place:[s.code],reviewed:false,kind:/Email/.test(s.doc)?'email':/MOS/.test(s.doc)?'photo':'scanned'}));
const SNAG_TYPES={Grounding:{min:3,shots:['Close-up of fix','Wide shot','Bond/ID tag'],fmt:'JPG, PNG, HEIC',maxMB:10},Painting:{min:2,shots:['Close-up of fix','Wide shot'],fmt:'JPG, PNG, HEIC',maxMB:10},'Cable tray':{min:2,shots:['Close-up of fix','Wide shot'],fmt:'JPG, PNG, HEIC',maxMB:10},'Tower bolts':{min:4,shots:['Close-up of fix','Wide shot','Torque mark','Tag'],fmt:'JPG, PNG',maxMB:8}};
SITES.forEach(s=>{s.snags=[];const st=s.stage;if(st>=2&&st<=4||hsh(s.id)%5===0){const n=1+hsh(s.id)%3;for(let i=0;i<n;i++){const ty=Object.keys(SNAG_TYPES)[(hsh(s.id)+i)%4];const closed=st>3||i===1&&hsh(s.id)%2;s.snags.push({id:s.id+'-S'+(i+1),type:ty,title:ty+' defect #'+(i+1),raised:'2026-10-0'+(3+i),state:closed?'approved':'open',photos:closed?[{name:'fix_'+(i+1)+'.jpg',exif:'2026-10-12'}]:[],shots:{}})}}});
/* batch seed */
(function(){const rows=[];for(const s of SITES){const x=s.tasks.find((y,i)=>y.state==='open'&&STEPS[i].code==='B2');if(x&&rows.length<5)rows.push({site:s.id,code:'B2',idx:STEPS.findIndex(q=>q.code==='B2'),old:'',nw:'2026-10-18',state:'pending'})}
 BATCHES.push({id:'B-0012',tpl:'TPL-SITE',ver:'v1.0',by:'1204',at:'2026-10-19 15:02',state:'review',rows,file:'Site_tasks_Tripoli.xlsx'})})();
/* ---------- user, permissions, holders */
const me=()=>U2[S.uid];
const permOK=(u,lv)=>PERMS.indexOf(u.perm)>=PERMS.indexOf(lv==='entry'?'entry':lv==='review'?'review':'approve');
const isAdmin=u=>!!u&&u.status==='Active'&&(GROUPS[0].members.includes(u.id)||DELEG.some(d=>d.to===u.id&&d.active&&d.scope==='Full'));
const delegateOf=u=>DELEG.find(d=>d.to===u.id&&d.active);
const need=lv=>{const u=me();return u&&(isAdmin(u)||PERMS.indexOf(u.perm)>=PERMS.indexOf(lv))};
function expand(cell,site){const ids=new Set();for(const r of cell.m){if(r.k==='u')ids.add(r.id);else if(r.k==='g')(GROUPS.find(g=>g.id===r.id)||{members:[]}).members.forEach(x=>ids.add(x));else USERS.filter(u=>hasRole(u,r.id)).forEach(u=>ids.add(u.id))}
 return [...ids].map(i=>U2[i]).filter(u=>u&&u.status==='Active'&&(!site||u.regions==='all'||u.regions.includes(site.region)))}
const lvlsOf=st=>MX[st].levels>=3?['entry','review','approve']:MX[st].levels===2?['entry','approve']:['entry'];
const holders=(site,idx,lv)=>{const o=site&&site.tasks[idx].re&&site.tasks[idx].re[lv];if(o&&U2[o.to]&&U2[o.to].status==='Active')return[U2[o.to]]; // task-level reassignment (B12b); the matrix is not changed
 return expand(MX[STEPS[idx].stage][lv],site)};
const isHolder=(u,site,idx,lv)=>holders(site,idx,lv).some(h=>h.id===u.id)&&permOK(u,lv);
const visible=s=>{const u=me();return u&&u.status==='Active'&&(u.regions==='all'||u.regions.includes(s.region))};
const mySites=()=>SITES.filter(visible);
const sIdx=code=>STEPS.findIndex(s=>s.code===code);
const stg=i=>i<10?t(STAGES[i]):t(MXROWS[i-10][1]);
const statePill=(st,late)=>{if(late)return`<span class="pill p-late">${ic('alert')}${t('Late')}</span>`;const m={done:['p-done','check','Done'],open:['p-open','pen','Open'],review:['p-wait','clock','Awaiting review'],approve:['p-wait','clock','Awaiting approval'],lock:['p-lock','lock','Locked'],na:['p-lock','x','N/A']}[st]||['p-lock','lock',st];return`<span class="pill ${m[0]}">${ic(m[1])}${t(m[2])}</span>`};
const isLate=(site,i)=>{const x=site.tasks[i];return !!x.late&&x.state!=='done'&&x.state!=='lock'&&x.state!=='na'};
function ext(site,i){const s=STEPS[i];if(s.tpl==='GECOL')return'GECOL · '+site.gcon;if(s.tpl==='HLC')return'HLC';if(s.tpl==='Procurement')return site.contractor;if(s.tpl==='Permits')return'Permits office';if(s.tpl==='Acquisition')return'Land owner';if(s.stage>=4&&s.stage<=6||s.tpl==='Handover')return site.vendor;if(s.stage>=1&&s.stage<=3||s.stage===9)return site.contractor;return''}
/* audit and logs */
function stamp(){const d=new Date();return TODAY+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}
function audit(action,target,detail,before='',after='',extra={}){const u=me();const dg=u&&delegateOf(u);AUDIT.unshift(Object.assign({at:stamp(),user:u?u.id:'—',action,target,detail,before,after,behalf:dg&&extra.admin?'System Admin':''},extra))}
function syslog(lvl,src,msg){SYSLOG.unshift({at:stamp(),lvl,src,msg})}
/* toast, modal */
function toast(m,err){const el=document.createElement('div');el.className='toast'+(err?' err':'');el.setAttribute('role',err?'alert':'status');el.textContent=m;$('#toasts').append(el);setTimeout(()=>el.remove(),3600)}
function modal(html,{wide=false,onclose}={}){closeModal();const m=document.createElement('div');m.className='modal';m.id='modal';m.setAttribute('role','dialog');m.setAttribute('aria-modal','true');m.innerHTML=`<div class="bg" data-act="mclose"></div><div class="dlg ${wide?'wide':''}">${html}</div>`;document.body.append(m);const f=$('input:not([type=hidden]),textarea,select,button.pri',m);f&&f.focus();m._onclose=onclose;return m}
function closeModal(){const m=$('#modal');if(m){m.remove()}}
function stepUp(why,cb){modal(`<h3>${ic('shield')} ${t('Confirm with Microsoft (step-up)')}</h3><div class="cb"><p>${t('This action needs re-authentication:')} <b>${esc(why)}</b></p><p class="hint">${t('Entra Conditional Access asks for MFA again. Prototype: the button simulates the prompt.')}</p></div><div class="ft"><button class="btn" data-act="mclose">${t('Cancel')}</button><button class="btn pri" id="mfaok">${t('Verify with Microsoft')}</button></div>`);
 $('#mfaok').onclick=()=>{$('#mfaok').disabled=true;$('#mfaok').textContent=t('Verifying…');setTimeout(()=>{closeModal();cb()},350)}}
/* zip + xlsx (real files, offline) */
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return b=>{let c=~0;for(const x of b)c=t[(c^x)&255]^(c>>>8);return~c>>>0}})();
const enc=new TextEncoder();
function zip(files){const parts=[],cd=[];let off=0;const u16=n=>[n&255,n>>8&255],u32=n=>[n&255,n>>8&255,n>>16&255,n>>24&255];
 for(const[f,data]of files){const nm=enc.encode(f),d=typeof data==='string'?enc.encode(data):data,c=CRC(d);
  const lh=[0x50,0x4b,3,4,...u16(20),...u16(0x800),...u16(0),...u16(0),...u16(0x21),...u32(c),...u32(d.length),...u32(d.length),...u16(nm.length),...u16(0)];
  parts.push(new Uint8Array(lh),nm,d);
  cd.push(new Uint8Array([0x50,0x4b,1,2,...u16(20),...u16(20),...u16(0x800),...u16(0),...u16(0),...u16(0x21),...u32(c),...u32(d.length),...u32(d.length),...u16(nm.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(off)]),nm);
  off+=lh.length+nm.length+d.length}
 const csz=cd.reduce((a,b)=>a+b.length,0);const end=new Uint8Array([0x50,0x4b,5,6,0,0,0,0,...u16(files.length),...u16(files.length),...u32(csz),...u32(off),0,0]);
 return new Blob([...parts,...cd,end])}
async function unzip(buf){const v=new DataView(buf),u8=new Uint8Array(buf);let e=u8.length-22;while(e>=0&&v.getUint32(e,true)!==0x06054b50)e--;if(e<0)throw new Error('not a zip');
 const n=v.getUint16(e+10,true);let p=v.getUint32(e+16,true);const out={};
 for(let i=0;i<n;i++){const meth=v.getUint16(p+10,true),csz=v.getUint32(p+20,true),nl=v.getUint16(p+28,true),xl=v.getUint16(p+30,true),cl=v.getUint16(p+32,true),lo=v.getUint32(p+42,true);const name=new TextDecoder().decode(u8.subarray(p+46,p+46+nl));
  const ln=v.getUint16(lo+26,true),lx=v.getUint16(lo+28,true),ds=lo+30+ln+lx;let data=u8.subarray(ds,ds+csz);
  if(meth===8){const ds2=new DecompressionStream('deflate-raw');const r=new Response(new Blob([data]).stream().pipeThrough(ds2));data=new Uint8Array(await r.arrayBuffer())}
  out[name]=new TextDecoder().decode(data);p+=46+nl+xl+cl}return out}
const colL=i=>String.fromCharCode(65+i);
const xmlc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function sheetXml(rows){return`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r,ri)=>`<row r="${ri+1}">${r.map((c,ci)=>`<c r="${colL(ci)}${ri+1}" t="inlineStr"><is><t>${xmlc(c)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`}
function mkXlsx(tpl,rows,head){const ct=`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
 const rel=`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
 const wb=`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="_tpl" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`;
 const wr=`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
 return zip([['[Content_Types].xml',ct],['_rels/.rels',rel],['xl/workbook.xml',wb],['xl/_rels/workbook.xml.rels',wr],['xl/worksheets/sheet1.xml',sheetXml([head||['Site ID','Task code','Actual date (YYYY-MM-DD)'],...rows])],['xl/worksheets/sheet2.xml',sheetXml([['template_id','version'],[tpl.id,tpl.ver]])]])}
async function readXlsx(buf){const f=await unzip(buf);const wb=f['xl/workbook.xml'];if(!wb)throw new Error('Not an Excel workbook');
 const names=[...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*\/>/g)].map(m=>m[1]);
 const ss=f['xl/sharedStrings.xml']?[...f['xl/sharedStrings.xml'].matchAll(/<si>(.*?)<\/si>/gs)].map(m=>[...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(x=>x[1]).join('')):[];
 const un=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
 const sheet=n=>{const k=Object.keys(f).filter(x=>/xl\/worksheets\/sheet\d+\.xml$/.test(x)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))[n];if(!k)return null;
  return [...f[k].matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map(r=>{const cells=[];for(const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)){const col=(c[1].match(/r="([A-Z]+)\d+"/)||[])[1];const ci=col?col.charCodeAt(0)-65:cells.length;const isS=/t="s"/.test(c[1]);const body=c[2]||'';let v=(body.match(/<v>(.*?)<\/v>/)||[])[1];if(v==null)v=[...body.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(x=>x[1]).join('');else if(isS)v=ss[+v];cells[ci]=un(v||'')}return cells})};
 const ti=names.indexOf('_tpl');return{names,data:sheet(names.indexOf('Data')>=0?names.indexOf('Data'):0),tpl:ti>=0?sheet(ti):null}}
function dl(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}
