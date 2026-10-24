/* ================= workflow: slots, levels, return, overrides, snags, batches ================= */
const DOC=id=>DOCLIB.find(d=>d.id===id);
const ruleTrue=(site,d)=>d.rule==='airport'?site.airport:d.rule==='outsourced'?site.outsourced:d.rule==='tower'?site.cwTower:!!d.rule?true:false;
const docApplies=(site,d)=>d.mand==='mandatory'||ruleTrue(site,d);
function docIds(site,i){const x=site.tasks[i];if(x.docIds)return x.docIds;const ids=DOCLIB.filter(d=>d.active&&d.place.includes(STEPS[i].code)).map(d=>d.id);if(x.state!=='lock'&&x.state!=='na')x.docIds=ids;return ids}
const slotDocs=(site,i)=>docIds(site,i).map(DOC).filter(d=>d&&docApplies(site,d));
const extOf=n=>(n.split('.').pop()||'').toUpperCase();
const fileDate=d=>(d||TODAY).replaceAll('-','');
function finalName(site,i,d,f,date,n,tot){return`${site.id}_${STEPS[i].code}_${d.id}_${fileDate(date)}${tot>1?'_'+(n+1):''}.${f.name.split('.').pop().toLowerCase()}`}
function getSlot(site,i,id){const x=site.tasks[i];x.slots=x.slots||{};if(x.slots[id])return x.slots[id];const d=DOC(id),s=STEPS[i];
 const mk=n=>Array.from({length:n},(_,k)=>({name:`${s.code}_${id}_scan${k+1}.${d.kind==='photo'?'jpg':d.kind==='email'?'eml':'pdf'}`,size:200+hsh(site.id+id+k)%1800,at:x.act||TODAY,by:x.hist[0]?x.hist[0].by:'1204'}));
 const sl={status:'missing',files:[],vers:[],reason:''};
 if(x.state==='done'&&x.docState!=='missing'){sl.status='approved';sl.files=mk(Math.max(1,d.min));sl.files.forEach((f,k)=>f.final=finalName(site,i,d,f,x.act,k,sl.files.length));if(hsh(site.id+id)%6===0)sl.vers=[{name:s.code+'_'+id+'_v1_scan.pdf',size:410,at:x.act,by:'1204',final:'(superseded)'}]}
 else if(x.state==='review'||x.state==='approve'){sl.status='review';sl.files=mk(Math.max(1,d.min))}
 else if(x.state==='open'&&hsh(site.id+id)%3===0){sl.status='uploaded';sl.files=mk(Math.max(1,d.min))}
 x.slots[id]=sl;return sl}
function validateFile(d,f,count){const ext=extOf(f.name),ok=d.fmt.toUpperCase().split(/[ ,]+/).filter(Boolean);
 if(!ok.includes(ext)&&!(ext==='JPEG'&&ok.includes('JPG')))return t('Format {e} not allowed (allowed: {f})',{e:ext||'?',f:d.fmt});
 if(f.size>d.maxMB*1048576)return t('File is {s} MB, maximum is {m} MB',{s:(f.size/1048576).toFixed(1),m:d.maxMB});
 if(count>=d.max)return t('Maximum {n} files for this document',{n:d.max});return null}
function addFiles(site,i,id,files){const d=DOC(id),sl=getSlot(site,i,id),x=site.tasks[i];const u=me();const bad=[];
 if(x.state!=='open'&&!(x.state==='lock'&&false)){toast(t('Files can be changed only while the task is open for entry'),true);return{bad:[]}}
 if(d.camera){toast(t('Proof photos are taken with the mobile app camera'),true);return{bad:[]}}
 if(sl.status==='rejected'){sl.vers.push(...sl.files);sl.files=[]}
 for(const f of files){const r=validateFile(d,f,sl.files.length);if(r)bad.push({name:f.name,reason:r});else sl.files.push({name:f.name,size:Math.max(1,Math.round(f.size/1024)),at:TODAY,by:u.id})}
 if(sl.files.length){sl.status='uploaded';sl.reason=''}
 if(files.length){audit('Uploaded document',site.id+' · '+STEPS[i].code,d.en+': '+files.map(f=>f.name).join(', '),'',sl.files.length+' file(s)')}
 bad.forEach(b=>syslog('WARN','Documents',`Upload of '${b.name}' rejected for ${site.id} ${STEPS[i].code}: ${b.reason}`));
 return{bad}}
function suggestDoc(site,i,name){const n=name.toLowerCase();let best=null;for(const d of slotDocs(site,i)){const keys=[d.id.toLowerCase(),...d.en.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2)];if(keys.some(k=>n.includes(k)))best=best||d.id}return best}
const dlSlotFiles=(site,i,d,sl)=>sl.files.map((f,k)=>f.final||f.name);
/* ---------- gating */
function openSnags(site){return site.snags.filter(s=>s.state!=='approved').length}
function approvalLock(site,i){if(STEPS[i].code==='B13'){const n=openSnags(site);if(n)return t('{n} open QC snag(s) on this site. A preliminary acceptance cannot be approved until all are closed.',{n})}return null}
function missingForSubmit(site,i,dateVal){const out=[];if(!dateVal)out.push(t('Actual date'));for(const d of slotDocs(site,i)){if(d.mand==='mandatory'||ruleTrue(site,d)){const sl=getSlot(site,i,d.id);if(sl.files.length<d.min||sl.status==='rejected'&&!sl.files.length)out.push(d.en)}}return out}
function whyLocked(site,i){const x=site.tasks[i],s=STEPS[i],r=[];
 if(x.state==='na'){r.push(t('Not applicable for this site (scenario {sc}, scope flags)',{sc:site.scenario}));return r}
 if(s.ms){const rest=STEPS.filter(q=>q.stage===s.stage&&!q.ms&&site.tasks[q.i].state!=='done'&&site.tasks[q.i].state!=='na');if(rest.length)r.push(t('Milestone is calculated. {n} task(s) of this stage are not approved yet: {l}',{n:rest.length,l:rest.map(q=>q.code).join(', ')}));return r}
 if(x.state==='lock'&&site.cur>=0&&site.cur<i){const c=site.cur,cs=STEPS[c];r.push(t('Previous task {c} {n} is not approved yet ({st}).',{c:cs.code,n:cs.name,st:t({open:'Open',review:'Awaiting review',approve:'Awaiting approval'}[site.tasks[c].state]||'Locked')}))}
 if(x.state==='lock'&&STEPS[i].stage>0&&site.stage<STEPS[i].stage&&!r.length)r.push(t('Phase gate {g} is not open yet.',{g:GATES[STEPS[i].stage]}));
 const al=approvalLock(site,i);if(al&&x.state!=='done')r.push(al);
 return r}
function bic(site,i){const x=site.tasks[i],s=STEPS[i];if(x.state==='done')return{kind:'done',users:[],ext:''};if(x.state==='na')return{kind:'na',users:[],ext:''};
 let j=i,st=x.state,blocked=false;if(st==='lock'){if(site.cur>=0&&site.cur!==i){j=site.cur;st=site.tasks[j].state;blocked=true}else return{kind:'blocked',users:[],ext:ext(site,i)}}
 const lv=st==='open'?'entry':st==='review'?'review':'approve';const us=holders(site,j,lv);const xj=site.tasks[j];
 return{kind:lv,users:us,ext:ext(site,j),blocked,by:j,claim:xj.claim&&xj.claim.level===lv?U2[xj.claim.by]:null,rule:MX[STEPS[j].stage][lv].rule}}
const bicTxt=b=>b.kind==='done'?'—':b.kind==='na'?'—':b.users.length?(b.users.length>2?b.users.slice(0,2).map(u=>u.name).join(', ')+' +'+(b.users.length-2):b.users.map(u=>u.name).join(', ')):'—';
const lvName=l=>t({entry:'Entry',review:'Review',approve:'Approve'}[l]);
/* ---------- level engine */
const logH=(x,a,by,note)=>x.hist.push({a,at:TODAY,by,note:note||''});
function advance(site,i,u,done){const x=site.tasks[i],st=STEPS[i].stage,lv=lvlsOf(st);let k=lv.indexOf(done)+1;x.skipped=x.skipped||[];x.claim=null;x.apprBy=[];
 while(k<lv.length){const L=lv[k];const cell=MX[st][L];
  if(cell.rule!=='all'&&isHolder(u,site,i,L)){x.skipped.push(L);logH(x,'Skipped '+L,u.id,'Same person holds consecutive levels');audit('Level skipped',site.id+' · '+STEPS[i].code,`${lvName(L)} skipped automatically: ${u.name} holds two consecutive levels`,L,'skipped');k++;continue}
  x.state=L==='review'?'review':'approve';return false}
 complete(site,i,u);return true}
function complete(site,i,u){const x=site.tasks[i],s=STEPS[i];x.state='done';x.act=x.act||TODAY;x.rejected=null;
 slotDocs(site,i).forEach(d=>{const sl=getSlot(site,i,d.id);if(sl.files.length){sl.status='approved';sl.files.forEach((f,k)=>f.final=finalName(site,i,d,f,x.act,k,sl.files.length))}});
 logH(x,'Approved',u.id);const before=site.cur;recompute(site);const nx=site.tasks[site.cur];
 audit('Approved',site.id+' · '+s.code,s.name,'Awaiting approval','Done');
 if(site.cur>=0&&site.cur!==i)toast(t('Approved. Next task opened: {c} {n}',{c:STEPS[site.cur].code,n:STEPS[site.cur].name}))}
function doSubmit(site,i,u,date){const x=site.tasks[i];x.act=date;x.rejected=null;x.skipped=[];logH(x,'Entered',u.id);
 slotDocs(site,i).forEach(d=>{const sl=getSlot(site,i,d.id);if(sl.files.length)sl.status='review'});
 audit('Submitted',site.id+' · '+STEPS[i].code,STEPS[i].name+' · '+date,'Open','Awaiting review');
 const fin=advance(site,i,u,'entry');recompute(site);return fin}
function claimOK(x,u,lv){return !x.claim||x.claim.by===u.id||x.claim.level!==lv}
function doReview(site,i,u){const x=site.tasks[i];if(!claimOK(x,u,'review'))return toast(t('Already claimed by {n}',{n:U2[x.claim.by].name}),true);
 logH(x,'Reviewed',u.id);audit('Reviewed',site.id+' · '+STEPS[i].code,STEPS[i].name,'Awaiting review','Awaiting approval');advance(site,i,u,'review');recompute(site)}
function doApprove(site,i,u){const x=site.tasks[i];const al=approvalLock(site,i);if(al)return toast(al,true);
 if(!claimOK(x,u,'approve'))return toast(t('Already claimed by {n}',{n:U2[x.claim.by].name}),true);
 const cell=MX[STEPS[i].stage].approve;
 if(cell.rule==='all'){x.apprBy=[...new Set([...(x.apprBy||[]),u.id])];const need2=expand(cell,site).map(h=>h.id);logH(x,'Approved (1 of '+need2.length+')',u.id);audit('Approved (partial)',site.id+' · '+STEPS[i].code,`${x.apprBy.length} of ${need2.length} required approvals`);
  if(!need2.every(id=>x.apprBy.includes(id))){toast(t('Your approval is recorded. {n} more required.',{n:need2.filter(id=>!x.apprBy.includes(id)).length}));return false}}
 else if(expand(cell,site).length>1)x.claim={by:u.id,level:'approve'};
 complete(site,i,u);return true}
function doReturn(site,i,u,note,docs){const x=site.tasks[i],lv=lvlsOf(STEPS[i].stage);const cur=x.state==='approve'?'approve':'review';let k=lv.indexOf(cur)-1;while(k>0&&(x.skipped||[]).includes(lv[k]))k--;const tg=lv[Math.max(0,k)];
 x.state=tg==='entry'?'open':tg;x.apprBy=[];x.claim=null;x.rejected={by:u.id,at:TODAY,note,level:cur,to:tg};
 x.notes.push({kind:'return',by:u.id,at:TODAY,text:note});logH(x,'Returned to '+tg,u.id,note);
 (docs||[]).forEach(id=>{const sl=getSlot(site,i,id);sl.status='rejected';sl.reason=note});
 if(tg==='entry')slotDocs(site,i).forEach(d=>{const sl=getSlot(site,i,d.id);if(sl.status==='review')sl.status='uploaded'});
 audit('Returned',site.id+' · '+STEPS[i].code,note,lvName(cur),lvName(tg));recompute(site)}
/* ---------- admin overrides (reason + step-up, reversible, flagged) */
const OVR={unlock:'Unlock task',na:'Skip / mark N/A',accept:'Accept without document or workflow',reopen:'Reopen approved task',date:'Edit date'};
function applyOverride(site,i,kind,reason,val){const x=site.tasks[i],u=me(),b={state:x.state,act:x.act,docIds:x.docIds};
 if(kind==='unlock'){x.state='open'}else if(kind==='na'){x.state='na'}else if(kind==='accept'){x.state='done';x.act=x.act||TODAY;slotDocs(site,i).forEach(d=>{const sl=getSlot(site,i,d.id);if(!sl.files.length)sl.status='waived'})}else if(kind==='reopen'){x.state='open';x.act=''}else if(kind==='date'){x.act=val}
 x.ovr={kind,by:u.id,at:TODAY,reason,before:b,behalf:delegateOf(u)&&!GROUPS[0].members.includes(u.id)};logH(x,'Admin override: '+OVR[kind],u.id,reason);
 audit('Admin override',site.id+' · '+STEPS[i].code,OVR[kind]+' · '+reason,`${b.state} ${b.act||''}`,`${x.state} ${x.act||''}`,{admin:true,mfa:true});recompute(site)}
function revertOverride(site,i){const x=site.tasks[i];if(!x.ovr)return;const b=x.ovr.before;audit('Admin override reverted',site.id+' · '+STEPS[i].code,OVR[x.ovr.kind],`${x.state}`,`${b.state}`,{admin:true,mfa:true});x.state=b.state;x.act=b.act;x.ovr=null;recompute(site)}
/* ---------- snags */
function exifFor(name,raised){const n=name.toLowerCase();if(n.includes('_noexif'))return null;if(n.includes('_old'))return '2026-09-01';return TODAY}
function addSnagPhotos(site,sn,files,shot){const ty=SNAG_TYPES[sn.type],bad=[];const u=me();
 for(const f of files){const ext=extOf(f.name);if(!ty.fmt.split(/[ ,]+/).includes(ext)&&!(ext==='JPEG')){bad.push({name:f.name,reason:t('Format {e} not allowed (allowed: {f})',{e:ext,f:ty.fmt})});continue}
  if(f.size>ty.maxMB*1048576){bad.push({name:f.name,reason:t('File is {s} MB, maximum is {m} MB',{s:(f.size/1048576).toFixed(1),m:ty.maxMB})});continue}
  const ex=exifFor(f.name,sn.raised);if(ex&&ex<sn.raised){bad.push({name:f.name,reason:t('Photo taken {d}, before the snag was raised ({r}). Rejected by EXIF date.',{d:ex,r:sn.raised})});continue}
  sn.photos.push({name:f.name,exif:ex,shot,by:u.id,flag:ex?'':t('Unknown capture date')})}
 bad.forEach(b=>syslog('WARN','QC',`Photo '${b.name}' rejected for snag ${sn.id}: ${b.reason}`));
 if(files.length)audit('Uploaded QC photos',sn.id,sn.photos.length+' photo(s)');return bad}
const snagReady=sn=>{const ty=SNAG_TYPES[sn.type];if(sn.photos.length<ty.min)return t('At least {n} photos needed ({h} so far)',{n:ty.min,h:sn.photos.length});const miss=ty.shots.filter(s=>!sn.photos.some(p=>p.shot===s));return miss.length?t('Missing shot type(s): {l}',{l:miss.join(', ')}):null};
function snagStep(site,sn,act,note){const u=me();const b=sn.state;
 if(act==='submit'){const r=snagReady(sn);if(r)return toast(r,true);sn.state='review'}else if(act==='review')sn.state='approve';else if(act==='approve')sn.state='approved';else if(act==='return'){sn.state='open';sn.note=note}
 audit('QC snag '+act,sn.id,note||sn.title,b,sn.state);return true}
/* ---------- batches */
function applyBatch(b){let n=0;b.rows.forEach(r=>{if(r.state!=='ok')return;const s=SITES.find(q=>q.id===r.site),x=s&&s.tasks[r.idx];if(!x||x.state==='done'||x.state==='na'){r.conflict=true;return}x.act=r.nw;x.state='done';logH(x,'Applied from batch '+b.id,b.by);recompute(s);n++;audit('Batch row applied',r.site+' · '+r.code,'Batch '+b.id,r.old||'—',r.nw)});return n}
/* ---------- inbox */
function inbox(u){const out=[];if(!u||u.status!=='Active')return out;
 for(const s of mySites())for(let i=0;i<STEPS.length;i++){const x=s.tasks[i];if(x.state!=='review'&&x.state!=='approve')continue;const lv=x.state;if(!isHolder(u,s,i,lv))continue;
  const by=x.claim&&x.claim.level===lv&&x.claim.by!==u.id?U2[x.claim.by]:null;const cell=MX[STEPS[i].stage][lv];
  out.push({kind:'task',key:s.id+':'+i,site:s,i,lv,claimedBy:by,viaGroup:cell.m.some(r=>r.k==='g')&&!cell.m.some(r=>r.k==='u'&&r.id===u.id),partial:cell.rule==='all'&&(x.apprBy||[]).includes(u.id)})}
 for(const s of mySites())for(const sn of s.snags){if(sn.state==='review'&&permOK(u,'review'))out.push({kind:'snag',key:sn.id,site:s,sn,lv:'review'});if(sn.state==='approve'&&permOK(u,'approve'))out.push({kind:'snag',key:sn.id,site:s,sn,lv:'approve'})}
 for(const b of BATCHES){if(b.state==='review'&&permOK(u,'review')||b.state==='approve'&&permOK(u,'approve'))out.push({kind:'batch',key:b.id,b,lv:b.state})}
 return out.filter(o=>!(o.partial))}
function myWork(u){const out=[];if(!u)return out;for(const s of mySites()){const i=s.cur;if(i<0)continue;const x=s.tasks[i];if(x.state==='open'&&isHolder(u,s,i,'entry'))out.push({s,i,col:isLate(s,i)?'late':'do'});else if(x.state==='review'||x.state==='approve')if(!isHolder(u,s,i,x.state)){const mineEntry=x.hist.some(h=>h.by===u.id);if(mineEntry)out.push({s,i,col:'wait'})}}
 return out}
