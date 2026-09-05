/* Read-only legacy plan viewer. Values are rendered as text, never HTML. */
let archivedPlan = null;
const status = document.getElementById('historyStatus');
try {
  if (location.hash.startsWith('#plan=')) {
    const value=location.hash.slice(6);
    if (!/^[A-Za-z0-9_-]{1,100000}$/.test(value)) throw Error('Invalid link');
    const b64=value.replaceAll('-','+').replaceAll('_','/');
    const bytes=Uint8Array.from(atob(b64+'='.repeat((4-b64.length%4)%4)),c=>c.charCodeAt(0));
    const data=JSON.parse(new TextDecoder().decode(bytes));
    if (data.v!==1 || (data.season && data.season!=='summer-2026')) throw Error('This is not a summer plan');
    archivedPlan=data;
    status.textContent='Viewing the summer plan from this link. Nothing has been imported into your saved plans.';
  } else {
    archivedPlan=JSON.parse(localStorage.getItem('e17planner.v1')||'null');
    status.textContent=archivedPlan?'Viewing the summer plan saved in this browser.':'No summer plan is saved in this browser. If you have an old shared plan link, open that link and choose “Open summer plan”.';
  }
  if (archivedPlan) {
    if (!Array.isArray(archivedPlan.children)) throw Error('Invalid plan');
    const container=document.getElementById('historyPlan');
    for(const child of archivedPlan.children.slice(0,6)) {
      if (!child || typeof child.id!=='string') continue;
      const section=document.createElement('section');section.className='child-plan';
      const heading=document.createElement('h2');heading.textContent=String(child.name||'Child');section.append(heading);
      for(const wk of window.E17_PLANNER.weeks) {
        const e=archivedPlan.plan?.[wk.id]?.[child.id];
        if (!e) continue;
        const p=window.E17_DIRECTORY.providers.find(p=>p.id===e.campId);
        const label=e.type==='camp' ? p?.name || 'Camp no longer in archive' : e.type==='other' ? e.label || 'Other camp' : {family:'Family cover',leave:'Annual leave',swap:'Friend swap'}[e.type]||'Other cover';
        const row=document.createElement('p');
        row.textContent=`${wk.dates}: ${label}${Array.isArray(e.days)?' · '+e.days.map(d=>['Mon','Tue','Wed','Thu','Fri'][d-1]).filter(Boolean).join(', '):''}${e.booked?' · marked booked':''}`;
        section.append(row);
      }
      container.append(section);
    }
    document.getElementById('exportHistory').hidden=false;
  }
} catch {
  archivedPlan=null;
  status.textContent='This summer plan could not be read. Your saved data has not been changed.';
}
document.getElementById('exportHistory').addEventListener('click',()=>{
  if (!archivedPlan) return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(archivedPlan,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='kidsorted-summer-2026-plan.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
