'use strict';
const fs=require('fs'), path=require('path');
const PW = process.env.PLAYWRIGHT_PATH || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || null;
const DIR=__dirname, LIB=path.join(DIR,'..','lib');
const TMP=path.join(DIR,'tmp-run13.json');
require('./_preview.cjs')();

(async()=>{
  // 1) 用真实 index.js 起一个 handler，验证 API 返回 build
  const routes=[];
  const fakeCtx={
    tools:{register:()=>{}},
    systemPrompt:{section:()=>{},getSectionOrder:()=>1e4,getContextOrder:()=>125,context:()=>()=>{}},
    on:()=>{},effect:(f)=>{try{f()}catch(e){}},
    webServer:{port:1,register:(r)=>{routes.push(r);return()=>{}}},
    get:()=>undefined,logger:{info(){},error(){},warn(){}}
  };
  const seed=()=>fs.writeFileSync(TMP, JSON.stringify({version:2,updatedAt:new Date().toISOString(),workspaces:{'D:/Work/demo':{
    northStar:'目标',redLines:[{id:'R1',text:'r1'}],ledger:[{id:'P01',title:'t',status:'todo',source:'s',detail:'d',result:'',evidence:''}],
    deviations:[],activity:[],sessionNames:{},meta:{reads:{},rev:0}}}}),'utf8');
  seed();
  const mod=await import('file:///' + path.join(LIB,'index.js').replace(/\\/g,'/'));
  mod.apply(fakeCtx,{file:TMP,workspace:'D:/Work/demo',grantMinutes:45});
  await new Promise(r=>setTimeout(r,300));
  const api=routes.find(r=>r.path==='/northstar/api');
  const call=()=>new Promise(res=>{ const res2={writeHead(){},end(b){res(String(b))}}; api.handler({method:'GET',url:'/northstar/api?ws=D%3A%2FWork%2Fdemo'},res2); });
  const a=JSON.parse(await call());

  // 2) 用同一份 payload 渲染面板，验证底部构建戳
  const b=await chromium.launch(CHROME?{executablePath:CHROME,headless:true}:{headless:true});
  const p=await b.newPage({viewport:{width:1440,height:960}});
  const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.addInitScript((m)=>{ window.fetch=function(u,o){u=String(u);
    if(u.indexOf('overlay.css')>=0) return Promise.resolve({ok:true,text:()=>Promise.resolve(document.getElementById('ns-css').textContent)});
    if(u.indexOf('/northstar/api')>=0) return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(m)});
    return Promise.resolve({ok:true,text:()=>Promise.resolve('')});};
    localStorage.setItem('dsh.northstar.ui',JSON.stringify({tab:'board',filter:['all'],theme:'glass'}));
  },a);
  await p.goto('file:///'+path.resolve(DIR,'preview.html').replace(/\\/g,'/'));
  await p.addScriptTag({path:path.join(LIB,'overlay.js')});
  await p.waitForTimeout(1200);
  const ev=(c)=>p.evaluate((code)=>{const root=document.getElementById('ns-host').shadowRoot; return new Function('root',code)(root);},c);
  const foot = await ev("const f=root.querySelector('.ns-time'); return f?f.textContent.trim():'';");
  await p.screenshot({path:path.join(DIR,'out','run13-build.png')});

  const checks=[
    ['API 返回 build 戳', typeof a.build==='string' && a.build.length>0, String(a.build)],
    ['面板底部显示版本', /v[0-9a-z]{4,}/i.test(foot), foot],
    ['无页面错误', errs.length===0, errs.join(';').slice(0,100)]
  ];
  const bad=checks.filter(x=>!x[1]);
  fs.rmSync(TMP,{force:true});
  console.log(JSON.stringify({build:a.build, foot, checks, failed:bad.length, fails:bad},null,1));
  await b.close();
  process.exit(bad.length?1:0);
})().catch(e=>{console.error('FAIL',String(e).slice(0,400));process.exit(1);});
