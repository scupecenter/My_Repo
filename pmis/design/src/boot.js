/* boot */
STEPS.forEach(st=>{});SITES.forEach(s=>s.tasks.forEach((x,i)=>{if(x.state!=='lock'&&x.state!=='na')docIds(s,i)}));
if(!location.hash)location.hash='#/'+(S.uid?'my-work':'login');
applyLang();document.documentElement.dataset.theme=S.theme==='dark'?'dark':'light';render();
