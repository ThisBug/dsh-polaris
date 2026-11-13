'use strict';
/* run8：红线送达 —— 现在用 systemPrompt.context（运行时上下文），由 DSH 自己去重，
   不再每条用户消息都追加。本测试验证：context 已注册、取值正确、台账变化能实时反映。 */
const fs=require('fs'), path=require('path');
const DIR=path.join(__dirname,'..','lib');
(async()=>{
  const contexts=[];
  const fakeCtx={
    tools:{ register:()=>{} },
    systemPrompt:{ section:()=>{}, getSectionOrder:()=>1e4,
      getContextOrder:()=>125,
      context:(c)=>{ contexts.push(c); return ()=>{}; } },
    on:()=>{},
    effect:(f)=>{ try{f();}catch(e){} },
    webServer:{ port:1, register:()=>(()=>{}) },
    get:()=>undefined, logger:{info(){},error(){},warn(){}}
  };
  const T=path.join(DIR,'..','test','tmp-run8.json');
  const seed=(extraRed)=>{
    fs.writeFileSync(T, JSON.stringify({version:2,updatedAt:new Date().toISOString(),workspaces:{'D:/Work/demo':{
      northStar:'演示目标',
      redLines:[{id:'R1',text:'不许脚本造数'},{id:'R2',text:'不许新建计划文档'}].concat(extraRed||[]),
      ledger:[{id:'P01',title:'进行中任务',status:'doing'},{id:'P02',title:'待办',status:'todo'}],
      deviations:[],activity:[],sessionNames:{},meta:{reads:{},rev:0}}}}),'utf8');
  };
  seed();
  const mod=await import('file:///' + path.join(DIR,'index.js').replace(/\\/g,'/'));
  mod.apply(fakeCtx, { file:T, workspace:'D:/Work/demo', grantMinutes:45 });
  await new Promise(r=>setTimeout(r,300));

  const c0 = contexts.find(x=>x.name==='northstar:redlines');
  const out={registered: contexts.map(c=>c.name)};
  const txt = c0 ? c0.text({ agent:{ id:'session-abc' } }) : '';
  out.txt = txt;

  // 台账变化后同一回调能反映
  seed([{id:'R3',text:'新增红线测试'}]);
  const txt2 = c0 ? c0.text({ agent:{ id:'session-abc' } }) : '';

  const checks=[
    ['注册了 northstar:redlines 上下文', !!c0, out.registered.join(',')],
    ['context 为 required（不会被 suppress 掉）', !!(c0 && c0.required), ''],
    ['interpolate 关闭（{{}} 不被解析）', !!(c0 && c0.interpolate===false), ''],
    ['含红线 R1 原文', txt.includes('不许脚本造数'), ''],
    ['含目标', txt.includes('演示目标'), ''],
    ['含进行中任务', txt.includes('P01'), ''],
    ['不含待办项（只列进行中）', !txt.includes('P02'), ''],
    ['台账新增红线后实时反映', txt2.includes('新增红线测试'), '']
  ];
  const bad=checks.filter(c=>!c[1]);
  fs.rmSync(T,{force:true});
  console.log(JSON.stringify({out:{...out, txt:txt.slice(0,200)}, checks, failed:bad.length, fails:bad},null,1));
  process.exit(bad.length?1:0);
})().catch(e=>{console.error('FAIL',String(e).slice(0,400));process.exit(1);});
