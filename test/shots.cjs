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
  const p=await b.newPage({viewport:{width:1440,height:960},deviceScaleFactor:2});
  const errors=[]; p.on('pageerror',e=>errors.push(String(e)));
  await p.addInitScript((m)=>{
    window.fetch=function(u,o){u=String(u);
      if(u.indexOf('overlay.css')>=0) return Promise.resolve({ok:true,text:()=>Promise.resolve(document.getElementById('ns-css').textContent)});
      if(u.indexOf('/northstar/api')>=0) return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(m)});
      return Promise.resolve({ok:true,text:()=>Promise.resolve('')});};
    localStorage.setItem('dsh.northstar.ui',JSON.stringify({tab:'board',filter:['todo','doing'],theme:'glass'}));
  },M);
  await p.goto('file:///'+path.resolve(DIR,'preview.html').replace(/\\/g,'/'));
  await p.addScriptTag({path:path.join(DIR,'..','lib','overlay.js')});
  await p.waitForTimeout(1000);
  const ev=(c)=>p.evaluate((code)=>{const roots=[];for(const el of document.body.children) if(el.shadowRoot) roots.push(el.shadowRoot); const root=roots[0]; return new Function('root',code)(root);},c);
  const click=(sel)=>ev("const x=root.querySelector('"+sel+"'); if(x) x.dispatchEvent(new MouseEvent('click',{bubbles:true})); return !!x;");

  // 1) 台账总览（含偏离区）— 液态玻璃
  await p.screenshot({path:path.join(OUT,'s1-board.png')});

  // 2) 点第二行 → 侧边详情
  await ev("const rows=Array.from(root.querySelectorAll('[data-item]')); if(rows[1]) rows[1].dispatchEvent(new MouseEvent('click',{bubbles:true})); return true;");
  await p.waitForTimeout(500);
  await p.screenshot({path:path.join(OUT,'s2-side.png')});
  await ev("const c=root.querySelector('.ns-side [data-act=item-close]'); if(c) c.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true;");
  await p.waitForTimeout(350);

  // 3) 记录页（200 条，首屏 30 + 更早）
  await click('[data-tab=act]');
  await p.waitForTimeout(450);
  await p.screenshot({path:path.join(OUT,'s3-act.png')});

  // 4) 白天主题
  await click('[data-tab=board]'); await p.waitForTimeout(300);
  await click('[data-th=light]'); await p.waitForTimeout(500);
  await p.screenshot({path:path.join(OUT,'s4-light.png')});
  // 5) 黑夜主题
  await click('[data-th=dark]'); await p.waitForTimeout(500);
  await p.screenshot({path:path.join(OUT,'s5-dark.png')});
  // 6) 液态玻璃
  await click('[data-th=glass]'); await p.waitForTimeout(500);
  await p.screenshot({path:path.join(OUT,'s6-glass.png')});
  // 7) 项目下拉展开
  await click('[data-ws]'); await p.waitForTimeout(400);
  await p.screenshot({path:path.join(OUT,'s7-ws.png')});
  // 8) 暂存页
  await click('[data-ws]');
  await click('[data-tab=stash]'); await p.waitForTimeout(400);
  await p.screenshot({path:path.join(OUT,'s8-stash.png')});

  const w = p.viewportSize();
  console.log(JSON.stringify({errors:errors, viewport:w, done:true},null,1));
  await b.close();
})().catch(e=>{console.error('FAIL',String(e).slice(0,400)); process.exit(1);});
