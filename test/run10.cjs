'use strict';
const fs=require('fs'), path=require('path');
const DIR=path.join(__dirname,'..','lib');
const T=path.join(__dirname,'tmp-api.json');

(async()=>{
  const routes=[];
  const fakeCtx={
    tools:{ register:()=>{} },
    systemPrompt:{ section:()=>{}, getSectionOrder:()=>1e4 },
    on:()=>{},
    effect:(f)=>{ try{f();}catch(e){} },
    webServer:{ port:1, register:(r)=>{ routes.push(r); return ()=>{}; } },
    get:()=>undefined, logger:{info(){},error(){},warn(){}}
  };
  const seed=(n)=>fs.writeFileSync(T, JSON.stringify({version:2,updatedAt:new Date().toISOString(),workspaces:{'D:/Work/demo':{
    northStar:'目标',redLines:[{id:'R1',text:'r1'}],
    ledger:Array.from({length:n},(_,i)=>({id:'T'+(i+1),title:'任务'+(i+1),status:'todo',source:'s',detail:'d',result:'',evidence:'',history:[]})),
    deviations:[],activity:[],sessionNames:{},meta:{reads:{},rev:0}}}}),'utf8');
  seed(1);
  const mod=await import('file:///' + path.join(DIR,'index.js').replace(/\\/g,'/'));
  mod.apply(fakeCtx, { file: T, workspace:'D:/Work/demo', grantMinutes:45 });
  await new Promise(r=>setTimeout(r,300));

  const api = routes.find(r=>r.path==='/northstar/api');
  const asset = routes.find(r=>r.path==='/northstar/overlay.js');
  const out={routes: routes.map(r=>r.path)};

  // 伪造 req/res
  const callApi = (qs)=>new Promise((resolve)=>{
    const req={ method:'GET', url:'/northstar/api'+(qs||'') };
    const chunks=[];
    const res={ writeHead(){}, end(b){ resolve(String(b)); } };
    api.handler(req,res);
  });

  // 1) 首次
  const a1 = JSON.parse(await callApi('?ws=D%3A%2FWork%2Fdemo'));
  out.first = { rows: a1.ledger.length, updatedAt: a1.updatedAt };

  // 2) 磁盘增加两行后，再请求
  seed(3);
  const a2 = JSON.parse(await callApi('?ws=D%3A%2FWork%2Fdemo'));
  out.afterDiskChange = { rows: a2.ledger.length, updatedAt: a2.updatedAt };

  // 3) 资源是否每次现读（改 overlay.js 后取到新内容）
  const ovPath = path.join(DIR,'overlay.js');
  const marker = '/* run10-marker-' + Date.now() + ' */';
  const before = await new Promise((resolve)=>{ const res={writeHead(){},end(b){resolve(String(b))}}; asset.handler({url:'/northstar/overlay.js'},res); });
  fs.appendFileSync(ovPath, '\n' + marker + '\n', 'utf8');
  const after = await new Promise((resolve)=>{ const res={writeHead(){},end(b){resolve(String(b))}}; asset.handler({url:'/northstar/overlay.js'},res); });
  out.assetFresh = { gotMarker: after.includes(marker), sizeBefore: before.length, sizeAfter: after.length };
  // 还原
  const orig = fs.readFileSync(ovPath,'utf8').replace('\n' + marker + '\n','');
  fs.writeFileSync(ovPath, orig, 'utf8');

  const checks=[
    ['API 路由已注册', !!api, out.routes.join(',')],
    ['资源路由已注册', !!asset, ''],
    ['首次返回 1 行', out.first.rows===1, String(out.first.rows)],
    ['磁盘变化后返回 3 行', out.afterDiskChange.rows===3, String(out.afterDiskChange.rows)],
    ['updatedAt 也随之变化', out.first.updatedAt !== out.afterDiskChange.updatedAt, ''],
    ['资源每次现读（拿到新内容）', out.assetFresh.gotMarker, JSON.stringify(out.assetFresh)]
  ];
  const bad=checks.filter(c=>!c[1]);
  fs.rmSync(T,{force:true});
  console.log(JSON.stringify({out, checks, failed:bad.length, fails:bad},null,1));
  process.exit(bad.length?1:0);
})().catch(e=>{console.error('FAIL',String(e).slice(0,400)); process.exit(1);});
