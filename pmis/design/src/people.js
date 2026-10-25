/* ---------- staff registry: employee ID beside a name + hover/focus card (REGISTRY is embedded by build.py from db/seed/staff-registry.draft.csv) */
const REGI=Object.fromEntries(REGISTRY.map(r=>[r.employee_id,r]));
S.regVis=S.regVis||{phone:'staff',email:'staff'}; // default: 'staff' (any signed-in Aljeel employee) or 'admin'
S.regRules=S.regRules||{phone:{allow:[],deny:[]},email:{allow:[],deny:[]}}; // entries 'r:Role', 'g:G1', 'u:1001'
S.regHide=S.regHide||{}; // per employee: {id:{phone:true,email:true}}
const emp=u=>{if(typeof u==='string')u=U2[u];if(!u)return'<span class="mute">—</span>';return`<span class="emp" tabindex="0" data-emp="${esc(u.id)}">${esc(u.name)}<span class="eid mono">${esc(u.id)}</span>${absBadge(u.id)}</span>`};
// person chip for the matrix: same hover/focus card as everywhere else
const refChip=r=>r.k==='u'?`<span class="ref u">${ic('user')}${emp(r.id)}</span>`:`<span class="ref ${r.k}">${ic(refIc(r))}${esc(refName(r))}</span>`;
const bicHtml=b=>b.kind==='done'||b.kind==='na'||!b.users.length?'—':`<span>${b.users.slice(0,2).map(emp).join(', ')}${b.users.length>2?' +'+(b.users.length-2):''}</span>`;
// who sees phone/email of employee rid: admins and the person themself always; else per-employee hide, then deny list, then default + allow list
const visCfg=()=>({vis:S.regVis,rules:S.regRules,hide:S.regHide});
function canSee(u,f,rid,c=visCfg()){if(!u)return false;if(u.perm==='admin'||u.id===rid)return true;
 const m=l=>(l||[]).some(x=>x==='u:'+u.id||(x[0]==='g'&&GROUPS.some(g=>x==='g:'+g.id&&g.members.includes(u.id)))||(x[0]==='r'&&hasRole(u,x.slice(2))));
 const R=c.rules[f]||{};if((c.hide[rid]||{})[f]||m(R.deny))return false;return c.vis[f]!=='admin'||m(R.allow)}
const empSee=(f,rid)=>canSee(me(),f,rid);
let empEl=null,empTimer=null,ptype='mouse';
const empTip=()=>{let d=$('#emp-tip');if(!d){d=document.createElement('div');d.id='emp-tip';d.className='empcard';d.setAttribute('role','tooltip');d.hidden=true;document.body.appendChild(d);
 d.addEventListener('pointerenter',()=>clearTimeout(empTimer));d.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse')empHide(120)})}return d};
function empHide(delay){clearTimeout(empTimer);if(delay){empTimer=setTimeout(()=>empHide(),delay);return}const d=$('#emp-tip');if(d)d.hidden=true;if(empEl){empEl.removeAttribute('aria-describedby');empEl=null}}
function empShow(el){clearTimeout(empTimer);if(empEl===el&&!empTip().hidden)return;empHide();const r=REGI[el.dataset.emp];const d=empTip();if(!r)return;
 const tm={CW:'CW',TE:'TE',both:'CW + TE',none:'—'}[r.team]||'—';const rg=r.region==='All'?t('All'):t(r.region+' Area');
 const sec=(f,v,cls)=>empSee(f,r.employee_id)?`<dd class="${cls}">${esc(v)}</dd>`:`<dd class="mute">${t('Not visible to you')}</dd>`;
 d.innerHTML=`<div class="ec-h"><b>${esc(r.name_en)}</b><span class="mono">${esc(r.employee_id)}</span></div><div class="ec-ar" lang="ar" dir="rtl">${esc(r.name_ar)}</div>${r.status!=='active'?`<span class="pill p-lock">${t('Inactive')}</span>`:''}${absent(r.employee_id)?`<span class="pill p-wait">${t('absent')}</span>`:''}
 <dl><dt>${t('Position')}</dt><dd>${esc(r.position)}</dd><dt>${t('Team')}</dt><dd>${esc(tm)}</dd><dt>${t('Region')}</dt><dd>${esc(rg)}</dd><dt>${t('Email')}</dt>${sec('email',r.email,'mono')}<dt>${t('Phone')}</dt>${sec('phone',r.phone,'mono')}</dl>`;
 d.hidden=false;empEl=el;el.setAttribute('aria-describedby','emp-tip');
 const a=el.getBoundingClientRect(),w=d.offsetWidth,h=d.offsetHeight,rtl=document.documentElement.dir==='rtl';
 let top=a.bottom+6;if(top+h>innerHeight-8)top=Math.max(8,a.top-h-6);let left=rtl?a.right-w:a.left;left=Math.min(Math.max(8,left),innerWidth-w-8);
 d.style.top=top+'px';d.style.left=left+'px'}
const empOf=e=>e.target&&e.target.closest?e.target.closest('.emp'):null;
document.addEventListener('pointerdown',e=>{ptype=e.pointerType},true);
document.addEventListener('pointerover',e=>{const el=empOf(e);if(el&&e.pointerType==='mouse')empShow(el)});
document.addEventListener('pointerout',e=>{const el=empOf(e);if(el&&e.pointerType==='mouse')empHide(120)});
document.addEventListener('focusin',e=>{const el=empOf(e);if(el)empShow(el)});
document.addEventListener('focusout',e=>{if(empOf(e))empHide()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&empEl){empHide();e.stopPropagation()}},true); // Escape closes the card first, not the drawer behind it
document.addEventListener('click',e=>{const el=empOf(e);if(el&&ptype!=='mouse'){e.preventDefault();e.stopPropagation();empShow(el);return} // tap opens (focus may already have); a tap on the name never triggers the row behind
 if(empEl&&!e.target.closest('#emp-tip'))empHide()},true);
