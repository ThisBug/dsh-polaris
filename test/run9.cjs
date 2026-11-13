'use strict';
const fs=require('fs'), path=require('path');
const PW = process.env.PLAYWRIGHT_PATH || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || null;
require('./_preview.cjs')();
const DIR=__dirname, OUT=path.join(DIR,'out'); fs.mkdirSync(OUT,{recursive:true});
const M=JSON.parse(fs.readFileSync(path.join(DIR,'mock-shots.json'),'utf8'));

(async()=>{
  const b=await chromium.launch(CHROME?{executablePath:CHROME,headless:true}:{headless:true});
  const p=await b.newPage({viewport:{width:1440,height:960}});
  const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.addInitScript((m)=>{
    window.__live = JSON.parse(JSON.stringify(m));
    window.__calls = 0;
    window.fetch=function(u,o){u=String(u);
      if(u.indexOf('overlay.css')>=0) return Promise.resolve({ok:true,text:()=>Promise.resolve(document.getElementById('ns-css').textContent)});
      if(u.indexOf('/northstar/api')>=0){
        window.__calls++;
        if(o&&o.method==='POST') return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({ok:true})});
        return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(window.__live)});
      }
      return Promise.resolve({ok:true,text:()=>Promise.resolve('')});};
    localStorage.setItem('dsh.northstar.ui',JSON.stringify({tab:'board',filter:['all'],theme:'glass'}));
  },M);
  await p.goto('file:///'+path.resolve(DIR,'preview.html').replace(/\\/g,'/'));
  await p.addScriptTag({path:path.join(DIR,'..','lib','overlay.js')});
  await p.waitForTimeout(1200);
  const ev=(c)=>p.evaluate((code)=>{const root=document.getElementById('ns-host').shadowRoot; return new Function('root',code)(root);},c);
  const res={errors:errs};

  // A) 初始
  res.before = await ev("return {rows: root.querySelectorAll('[data-item]').length, meta: root.querySelector('.ns-meta')?.textContent?.trim(), calls: window.__calls};");

  // B) 后台新增一条台账项 → 等自动轮询
  await p.evaluate(()=>{
    window.__live.ledger.push({id:'NEW1',title:'后台新增的任务',status:'todo',source:'t',detail:'d',result:'',evidence:''});
    window.__live.counts.total += 1; window.__live.counts.todo += 1;
    window.__live.updatedAt = new Date().toISOString();
  });
  await p.waitForTimeout(7000);
  res.autoPicked = await ev("return {rows: root.querySelectorAll('[data-item]').length, has: !!Array.from(root.querySelectorAll('[data-item]')).find(x=>x.getAttribute('data-item')==='NEW1'), calls: window.__calls};");

  // C) 点刷新按钮（再改一次数据，立即点刷新，不等轮询）
  await p.evaluate(()=>{
    window.__live.ledger.push({id:'NEW2',title:'刷新按钮后出现',status:'doing',source:'t',detail:'d',result:'',evidence:''});
    window.__live.counts.total += 1; window.__live.counts.doing += 1;
    window.__live.updatedAt = new Date().toISOString();
  });
  await ev("const btn=root.querySelector('[data-act=refresh]'); if(btn) btn.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true;");
  await p.waitForTimeout(1500);
  res.afterRefresh = await ev("return {rows: root.querySelectorAll('[data-item]').length, has: !!Array.from(root.querySelectorAll('[data-item]')).find(x=>x.getAttribute('data-item')==='NEW2'), calls: window.__calls};");

  // D) 停在记录页时也应能拿到新数据（切 tab 时数据已更新）
  await ev("const t=root.querySelector('[data-tab=act]'); t.click(); return true;");
  await p.waitForTimeout(400);
  res.actTab = await ev("return {rows: root.querySelectorAll('.ns-act-row').length};");

  await p.screenshot({path:path.join(OUT,'run9-refresh.png')});
  const checks=[
    ['初始有台账行', res.before.rows>0, 'rows='+res.before.rows],
    ['自动轮询拿到新增项', res.autoPicked.has, 'rows='+res.autoPicked.rows],
    ['刷新按钮拿到新增项', res.afterRefresh.has, 'rows='+res.afterRefresh.rows],
    ['无错误', errs.length===0, errs.join(';').slice(0,120)],
  ];
  const bad=checks.filter(c=>!c[1]);
  res.checks=checks; res.failed=bad.length;
  console.log(JSON.stringify(res,null,1));
  await b.close();
  process.exit(bad.length?1:0);
})().catch(e=>{console.error('FAIL',String(e).slice(0,400)); process.exit(1);});
