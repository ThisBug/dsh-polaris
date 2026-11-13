'use strict';

const fs=require('fs'), path=require('path');
const DIR=path.join(__dirname,'..','lib');
(async()=>{
  let hook=null;
  const fakeCtx={
    tools:{ register:()=>{} },
    systemPrompt:{ section:()=>{}, getSectionOrder:()=>1e4 },
    on:(ev,fn)=>{ if(ev==='agent/pre-step') hook=fn; },
    effect:(f)=>{ try{f();}catch(e){} },
    webServer:{ port:1, register:()=>(()=>{}) },
    get:()=>undefined, logger:{info(){},error(){},warn(){}}
  };
  const T=path.join(DIR,'..','test','tmp-tail.json');
  fs.writeFileSync(T, JSON.stringify({version:2,updatedAt:new Date().toISOString(),workspaces:{'D:/Work/demo':{northStar:'演示目标',redLines:[{id:'R1',text:'不许脚本造数'},{id:'R2',text:'不许新建计划文档'}],ledger:[{id:'P01',title:'进行中任务',status:'doing'}],deviations:[],activity:[],sessionNames:{},meta:{reads:{},rev:0}}}}),'utf8');
  const mod=await import('file:///' + path.join(DIR,'index.js').replace(/\\/g,'/'));
  mod.apply(fakeCtx, { file: T, workspace:'D:/Work/demo', grantMinutes:45 });
  await new Promise(r=>setTimeout(r,300));
  console.log('hook 注册:', !!hook);
  const mk=(messages)=>({kind:'enter', messages});
  const userMsg={role:'user', content:[{type:'text', text:'帮我把这个页面改一下'}]};
  const payload={agent:{id:'session-abc'}};
  // 第一次：应追加
  const r1 = await hook(payload, ()=>Promise.resolve(mk([userMsg])));
  const txt1 = r1.messages[0].content.map(c=>c.text).join('|');
  console.log('\n首次结果含红线:', txt1.includes('〔北极星红线'), '| 含 R1:', txt1.includes('不许脚本造数'), '| 含进行中:', txt1.includes('P01'));
  console.log('\n追加的尾巴:\n' + (r1.messages[0].content[1] ? r1.messages[0].content[1].text.trim() : '(无)'));
  // 第二次：已有红线则不重复
  const r2 = await hook(payload, ()=>Promise.resolve(mk(r1.messages)));
  const txt2 = r2.messages[0].content.map(c=>c.text).join('|');
  const cnt = (txt2.match(/〔北极星红线/g)||[]).length;
  console.log('\n重复追加次数:', cnt, '(应为 1)');
  const checks=[
    ['hook 已注册', !!hook, ''],
    ['末尾追加了红线', txt1.includes('〔北极星红线'), ''],
    ['包含具体红线 R1', txt1.includes('不许脚本造数'), ''],
    ['包含进行中任务', txt1.includes('P01'), ''],
    ['不重复追加', cnt===1, 'count='+cnt]
  ];
  const bad=checks.filter(c=>!c[1]);
  fs.rmSync(T,{force:true});
  console.log(JSON.stringify({total:checks.length, failed:bad.length, fails:bad},null,1));
  process.exit(bad.length?1:0);
})();
