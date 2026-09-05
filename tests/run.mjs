import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), site=path.resolve(args.includes('--site-dir')?args[args.indexOf('--site-dir')+1]:fileURLToPath(new URL('..',import.meta.url)));
const window={};const ctx=vm.createContext({window});
for(const f of ['camps.js','planner-data.js'])vm.runInContext(fs.readFileSync(path.join(site,'assets',f),'utf8'),ctx);
const D=window.E17_DIRECTORY,P=window.E17_PLANNER;
assert.equal(P.season,'october-2026');assert.equal(P.weeks[0].mon,'2026-10-26');
assert.equal(new Set(D.providers.map(p=>p.id)).size,D.providers.length);
for(const p of D.providers){const v=P.byId[p.id];assert(v,p.id);assert((v.weeks||[]).every(w=>P.weeks.some(x=>x.id===w)));if(v.price){assert(v.priceBasis);for(const n of Object.values(v.price))assert(Number.isFinite(n)&&n>=0);}if(!v.weeks?.length)assert(!v.price);}
assert(P.byId['sylvestrian-leisure-holiday-activities'].fullWeekOnly);
console.log('PASS: source-backed data integrity and booking rules');
if(args.includes('--skip-ui'))process.exit(0);
const test=fs.readFileSync(path.join(site,'tests/browser-audit.js'),'utf8');
const legacy={v:1,children:[{id:'summer',name:'Summer child',age:7}],plan:{1:{summer:{type:'family'}}}};
const hash=Buffer.from(JSON.stringify(legacy)).toString('base64url');
const seed=`<script>localStorage.clear();localStorage.setItem('e17planner.v1',${JSON.stringify(JSON.stringify(legacy))});localStorage.setItem('e17planner.v1.october-2026',JSON.stringify({children:[{id:'legacy',name:'Legacy',age:6}],plan:{1:{legacy:{type:'camp',campId:'barracudas-woodford',days:[1,2],booked:true}}}}));</script>`;
const chrome=process.env.CHROME_BIN||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'google-chrome');
for(const [width,height] of [[1280,900],[390,844]]) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kidsorted-daily-'));
  fs.cpSync(path.join(site,'assets'),path.join(tmp,'assets'),{recursive:true});
  fs.cpSync(path.join(site,'archive'),path.join(tmp,'archive'),{recursive:true});
  fs.copyFileSync(path.join(site,'previous-plans.html'),path.join(tmp,'previous-plans.html'));
  let html=fs.readFileSync(path.join(site,'index.html'),'utf8').replace(/<script defer src="https:[^>]+><\/script>/g,'').replace(/<link[^>]+(?:fonts.googleapis|fonts.gstatic)[^>]*>/g,'');
  html=html.replace('<head>','<head>'+seed).replace('</body>','<script>'+test+'</script></body>');fs.writeFileSync(path.join(tmp,'index.html'),html);
  const result=spawnSync(chrome,['--headless','--no-sandbox','--disable-gpu','--no-first-run','--disable-dev-shm-usage','--allow-file-access-from-files','--hide-scrollbars','--force-device-scale-factor=1','--user-data-dir='+path.join(tmp,'profile'),`--window-size=${width},${height}`,'--timeout=10000','--virtual-time-budget=7000','--dump-dom','file://'+path.join(tmp,'index.html')+'#plan='+hash],{encoding:'utf8',timeout:45000,maxBuffer:10*1024*1024});
  const actual=(result.stdout||'').match(/<pre id="test-result">([^<]+)/)?.[1];
  if(!actual)throw Error(`Browser ${width}px: ${result.error?.message||result.stderr?.slice(-500)||'no test output'} (${tmp})`);
  const report=JSON.parse(actual.replaceAll('&amp;','&').replaceAll('&gt;','>').replaceAll('&lt;','<'));
  if(!report.ok)throw Error(`${width}px: ${report.error}; passed: ${report.results.join(', ')} (${tmp})`);
  console.log(`PASS: ${width}px browser — ${report.results.length} checks covering actual clicks, mixed days, coverage, unknown prices, migration, shares and exports`);
  fs.rmSync(tmp,{recursive:true,force:true});
}
