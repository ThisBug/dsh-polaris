
const fs=require('fs'), path=require('path');
const DIR=path.join(__dirname,'..');
const SRC=fs.readFileSync(path.join(DIR,'lib','index.js'),'utf8');
// 找不到 defineTool 就走 fallback（def.execute 原样）
const captured=[];
const fakeCtx={
  tools:{ register:(def)=>{captured.push(def);} },
  systemPrompt:{ section:()=>{} },
  on:(...a)=>{}, effect:(f)=>{ try{f();}catch(e){} },
  webServer:{ port:1234, register:()=>(()=>{}) },
  get:()=>undefined
};
(async()=>{
  const mod=await import('file:///' + path.join(DIR,'lib','index.js').replace(/\\/g,'/'));
  mod.apply(fakeCtx, { file: path.join(__dirname,'tmp-run7.json'), workspace:'D:/Work/demo', grantMinutes:45 });
  await new Promise(r=>setTimeout(r,300));
  console.log('注册工具数:', captured.length, '|', captured.map(d=>d.name).join(','));
  const file=path.join(DIR,'test','tmp-run7.json');
  fs.writeFileSync(file, JSON.stringify({version:2,updatedAt:new Date().toISOString(),workspaces:{'D:/Work/demo':{northStar:'演示',redLines:[{id:'R1',text:'x'}],ledger:[{id:'P01',title:'t',status:'todo',source:'s',detail:'d',result:'',evidence:'',history:[]}],deviations:[],activity:[],sessionNames:{},meta:{reads:{},rev:0}}}}),'utf8');
  const exec={ agent:{ id:'session-demo', delegationDepth:0 } };
  const res={};
  const get=(n)=>captured.find(d=>d.name===n);
  // 每个工具都必须能调用且不抛
  for (const t of captured) {
    try {
      const args = t.name==='northstar_check' ? {task:'P01'} :
                   t.name==='northstar_ledger' ? {action:'list'} :
                   t.name==='northstar_deviate' ? {what:'测试偏离', redLine:'R1'} :
                   {};
      const r = await t.execute(args, exec);
      res[t.name] = { ok:true, ret: String(r).slice(0,60) };
    } catch(e) {
      res[t.name] = { ok:false, err: String(e.message).slice(0,120) };
    }
  }
  console.log(JSON.stringify(res,null,1));
  fs.rmSync(file,{force:true});
})();
