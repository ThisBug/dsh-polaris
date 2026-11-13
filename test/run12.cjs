'use strict';
const fs=require('fs'), path=require('path');
const LIB=path.join(__dirname,'..','lib');
const SEED=path.join(__dirname,'tmp-run12-seed.json');
const TMP=path.join(__dirname,'tmp-run12.json');

(async()=>{
  const routes=[];
  const fakeCtx={
    tools:{ register:()=>{} },
    systemPrompt:{ section:()=>{}, getSectionOrder:()=>1e4, getContextOrder:()=>125, context:()=>()=>{} },
    on:()=>{}, effect:(f)=>{ try{f();}catch(e){} },
    webServer:{ port:1, register:(r)=>{ routes.push(r); return ()=>{}; } },
    get:()=>undefined, logger:{info(){},error(){},warn(){}}
  };
  // 用真实台账的副本，config.workspace 与真实配置一致
  fs.writeFileSync(SEED, JSON.stringify({version:2,updatedAt:new Date().toISOString(),workspaces:{'D:/Work/demo':{
    northStar:'演示目标',redLines:[{id:'R1',text:'r1'}],
    ledger:[{id:'P01',title:'任务1',status:'todo',source:'s',detail:'d',result:'',evidence:''}],
    deviations:[],activity:[],sessionNames:{},meta:{reads:{},rev:0}}}}),'utf8');
  fs.copyFileSync(SEED, TMP);
  const mod=await import('file:///' + path.join(LIB,'index.js').replace(/\\/g,'/'));
  mod.apply(fakeCtx, { file: TMP, workspace:'D:/Work/demo', order:10300, enforce:'off', grantMinutes:45 });
  await new Promise(r=>setTimeout(r,300));

  const api=routes.find(r=>r.path==='/northstar/api');
  const call=(qs)=>new Promise((resolve)=>{
    const res={ writeHead(){}, end(b){ resolve(String(b)); } };
    api.handler({ method:'GET', url:'/northstar/api'+(qs||'') }, res);
  });

  // A) 面板首次请求：不带 ?ws=（模拟 state.ws 为空）
  const a=JSON.parse(await call(''));
  const out={first:{workspace:a.workspace, ledger:(a.ledger||[]).length, updatedAt:a.updatedAt}};

  // B) 模拟工具写一条（直接改文件，模拟 northstar_ledger 的效果）
  const d=JSON.parse(fs.readFileSync(TMP,'utf8'));
  const w=d.workspaces['D:/Work/demo'];
  w.ledger.push({id:'ZZTEST',title:'run12新增',status:'todo',source:'t',detail:'d',result:'',evidence:''});
  w.activity.push({at:new Date().toISOString(),kind:'add',detail:'ZZTEST',text:'登记台账 ZZTEST',session:'test',origin:'tool'});
  d.updatedAt=new Date().toISOString();
  fs.writeFileSync(TMP, JSON.stringify(d,null,2),'utf8');

  // C) 再请求（不带 ?ws，与轮询一致）
  const b=JSON.parse(await call(''));
  out.afterWriteNoWs={workspace:b.workspace, ledger:(b.ledger||[]).length, hasZZ:!!(b.ledger||[]).find(x=>x.id==='ZZTEST')};

  // D) 带 ?ws= 再请求（面板设了 state.ws 之后）
  const c=JSON.parse(await call('?ws=' + encodeURIComponent('D:/Work/demo')));
  out.afterWriteWithWs={workspace:c.workspace, ledger:(c.ledger||[]).length, hasZZ:!!(c.ledger||[]).find(x=>x.id==='ZZTEST')};

  // E) 指纹是否变化（前端靠这个决定是否重绘）
  out.sigChanged = JSON.stringify([a.workspace,a.counts,a.ledger,a.redLines,a.deviations,a.northStar,a.updatedAt,a.meta,a.activity,a.sessionTitles])
                !== JSON.stringify([b.workspace,b.counts,b.ledger,b.redLines,b.deviations,b.northStar,b.updatedAt,b.meta,b.activity,b.sessionTitles]);

  fs.rmSync(TMP,{force:true});
  try{fs.rmSync(SEED,{force:true});}catch(e){}
  const checks=[
    ['首次请求返回本项目', out.first.workspace==='D:/Work/demo', out.first.workspace],
    ['首次请求有台账', out.first.ledger>0, String(out.first.ledger)],
    ['写入后（不带 ws）能看到新增', out.afterWriteNoWs.hasZZ, 'ledger='+out.afterWriteNoWs.ledger],
    ['写入后（带 ws）能看到新增', out.afterWriteWithWs.hasZZ, 'ledger='+out.afterWriteWithWs.ledger],
    ['前端指纹会变化', out.sigChanged, '']
  ];
  const bad=checks.filter(x=>!x[1]);
  console.log(JSON.stringify({out, checks, failed:bad.length, fails:bad},null,1));
  process.exit(bad.length?1:0);
})().catch(e=>{console.error('FAIL',String(e).slice(0,400));process.exit(1);});
