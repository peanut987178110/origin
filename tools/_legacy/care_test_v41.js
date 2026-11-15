const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'src/app/index.html'),'utf8');
const existing=fs.readFileSync(path.join(root,'tools/e2e_app.js'),'utf8');
const harness=existing.slice(existing.indexOf('function makeEl'),existing.indexOf('const T = window.TIDE;'));
global.html=html; global.vm=vm;
vm.runInThisContext(harness);
function check(code){vm.runInThisContext(code);}
check("S.user='caretest';HISTORY=[{role:'user',content:'今天去看了海'}];endEvening();");
assert(global.localStorage.getItem('tide.care.caretest').includes('今天去看了海'));
check("endEvening();if(careData().diaries.length!==1)throw Error('duplicate diary');showReturnLetter();");
check("if(!careData().diaries[0].read)throw Error('letter not read');setMood('平静');if(careData().moods[dayKey()]!=='平静')throw Error('mood missing');");
check("el('careFact').value='我的猫叫团子';addFact();if(!manualMemory().includes('团子'))throw Error('memory missing');removeFact(0);if(manualMemory())throw Error('memory not deleted');");
check("S.user='other';if(careData().diaries.length)throw Error('account data leaked');S.user='caretest';removeDiary(careData().diaries[0].id);if(careData().diaries.length)throw Error('diary not deleted');openCare('tools');showCareTool('breathe');closeCare();");
console.log('PASS: diary capture, same-day update, return letter, mood, memory add/delete, account isolation, diary delete, tools navigation');
