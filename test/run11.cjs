'use strict';
const fs=require('fs'), path=require('path');
const PW = process.env.PLAYWRIGHT_PATH || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || null;
const DIR=__dirname, OUT=path.join(DIR,'out'); fs.mkdirSync(OUT,{recursive:true});
const LIB=path.join(DIR,'..','lib');

// 1) 用真实 index.js 的 guiHtml 生成页面
const src=fs.readFileSync(path.join(LIB,'index.js'),'utf8');
const g=src.indexOf('function guiHtml()');
const nx=src.indexOf('function readBody(req)');
const wrapPath=path.join(DIR,'_guiwrap-tmp.cjs');
fs.writeFileSync(wrapPath, src.slice(g,nx)+'\nmodule.exports=guiHtml;\n','utf8');
const html=require(wrapPath)();
fs.rmSync(wrapPath,{force:true});
const pagePath=path.join(DIR,'gui-test.html');
fs.writeFileSync(pagePath, html,'utf8');

const DATA={workspace:'D:/Work/demo',updatedAt:'2026-11-13T14:00:00Z',enforce:'off',northStar:'目标X',
  redLines:[{id:'R1',text:'不许脚本造数'}],
  counts:{total:2,todo:1,doing:1,done:0,blocked:0,void:0},
  ledger:[{id:'P01',title:'进行中A',status:'doing',source:'s',detail:'d',result:'',evidence:''},
          {id:'P02',title:'待办B',status:'todo',source:'s',detail:'d',result:'',evidence:''}],
  deviations:[],activity:[{at:'2026-11-13T13:00:00Z',kind:'read',detail:'',text:'读取台账',session:'a',origin:'tool'}],
  sessionTitles:{},meta:{}};

(async()=>{
  const b=await chromium.launch(CHROME?{executablePath:CHROME,headless:true}:{headless:true});
  const p=await b.newPage({viewport:{width:1200,height:900}});
  const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.addInitScript((m)=>{ window.__live=JSON.parse(JSON.stringify(m)); window.__calls=0;
    window.fetch=function(u,o){u=String(u);
      if(u.indexOf('/northstar/api')>=0){ window.__calls++;
        if(o&&o.method==='POST') return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({ok:true})});
        return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(window.__live)});}
      return Promise.resolve({ok:true,text:()=>Promise.resolve('')});};},DATA);
  await p.goto('file:///'+pagePath.replace(/\\/g,'/'));
  await p.waitForTimeout(800);
  const res={errors:errs};
  res.before=await p.evaluate(()=>({rows:document.querySelectorAll('#rows tr').length,calls:window.__calls}));

  await p.evaluate(()=>{window.__live.ledger.push({id:'P03',title:'后台新增',status:'todo',source:'s',detail:'d',result:'',evidence:''});window.__live.counts.total++;window.__live.counts.todo++;});
  await p.waitForTimeout(6500);
  res.auto=await p.evaluate(()=>({rows:document.querySelectorAll('#rows tr').length,calls:window.__calls,has:!!document.querySelector('#rows input[id^=resFor_P03]')}));

  await p.evaluate(()=>{window.__live.ledger.push({id:'P04',title:'刷新后出现',status:'doing',source:'s',detail:'d',result:'',evidence:''});window.__live.counts.total++;window.__live.counts.doing++;});
  await p.evaluate(()=>{Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='刷新').click();});
  await p.waitForTimeout(900);
  res.manual=await p.evaluate(()=>({rows:document.querySelectorAll('#rows tr').length,has:!!document.querySelector('#rows input[id^=resFor_P04]')}));
  await p.screenshot({path:path.join(OUT,'run11-webboard.png')});

  const checks=[
    ['web 看板初始渲染', res.before.rows===2, 'rows='+res.before.rows],
    ['自动轮询拿到新增项', res.auto.has, 'rows='+res.auto.rows],
    ['刷新按钮拿到新增项', res.manual.has, 'rows='+res.manual.rows],
    ['无页面错误', errs.length===0, errs.join(';').slice(0,120)]
  ];
  const bad=checks.filter(c=>!c[1]);
  res.checks=checks; res.failed=bad.length;
  console.log(JSON.stringify(res,null,1));
  await b.close();
  process.exit(bad.length?1:0);
})().catch(e=>{console.error('FAIL',String(e).slice(0,400));process.exit(1);});
