'use strict';
const fs=require('fs'), path=require('path');
const PW = process.env.PLAYWRIGHT_PATH || 'playwright-core';
const { chromium } = require(PW);
require('./_preview.cjs')();
const CHROME=process.env.CHROME_PATH||null;
const DIR=__dirname, OUT=path.join(DIR,'out'); fs.mkdirSync(OUT,{recursive:true});
const MOCK=JSON.parse(fs.readFileSync(path.join(DIR,'mock.json'),'utf8'));
(async()=>{
  const browser=await chromium.launch(CHROME?{executablePath:CHROME,headless:true}:{headless:true});
  const page=await browser.newPage({viewport:{width:1180,height:900},deviceScaleFactor:2});
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript((mock)=>{
    window.__posted=[];
    const ACTT={read:function(){return '读取台账（目标·红线·进度）'},check:function(d){return d&&d!=='开工闸门校验'?'开工校验：'+d:'开工校验'},update:function(d){return '回写台账 '+d},add:function(d){return '登记台账 '+d},goal:function(d){return d||'修改目标'},redline:function(d){return d||'修改红线'},deviate:function(d){return '记录偏离 '+d}};
    const actText=function(k,d){const f=ACTT[k];return f?f(String(d||'')):String(d||k)};

    const cssText=()=>document.getElementById('ns-css').textContent;
    window.fetch=function(url,opts){
      url=String(url);
      if(url.indexOf('/northstar/overlay.css')>=0) return Promise.resolve({ok:true,text:()=>Promise.resolve(cssText())});
      if(url.indexOf('/northstar/api')>=0){
        if(opts&&opts.method==='POST'){
          const b=JSON.parse(opts.body); window.__posted.push(b);
          if(b.action==='update'){const it=mock.ledger.find(x=>x.id===b.id); if(it) it.status=b.status;
            mock.counts={total:mock.ledger.length,todo:0,doing:0,done:0,blocked:0,void:0}; for(const x of mock.ledger) mock.counts[x.status]=(mock.counts[x.status]||0)+1;
            mock.activity.push({at:new Date().toISOString(),kind:'update',detail:b.id+' → '+b.status,text:actText('update',b.id+' → '+b.status),session:'ui',name:'',origin:'panel'});}
          return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({ok:true})});
        }
        return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(mock)});
      }
      return Promise.resolve({ok:true,text:()=>Promise.resolve('')});
    };
    localStorage.setItem('dsh.northstar.ui', JSON.stringify({tab:'board', filter:['todo','doing']}));
  }, MOCK);
  await page.goto('file:///'+path.join(DIR,'preview.html').replace(/\\/g,'/'));
  await page.addScriptTag({path: path.join(DIR, '..', 'lib', 'overlay.js')});
  await page.waitForTimeout(1000);
  const ev=(code)=>page.evaluate((c)=>{const roots=[];for(const el of document.body.children) if(el.shadowRoot) roots.push(el.shadowRoot); const root=roots[0]; return new Function('root',c)(root);},code);
  const before=await ev("const on=Array.from(root.querySelectorAll('[data-f]')).filter(b=>b.classList.contains('on')).map(b=>b.getAttribute('data-f')); return {on:on, rows:Array.from(root.querySelectorAll('.ns-row')).map(r=>r.getAttribute('data-item'))};");
  await ev("const r=Array.from(root.querySelectorAll('[data-item]')).find(x=>x.getAttribute('data-item')==='B02'); if(r) r.click(); return !!r;");
  await page.waitForTimeout(400);
  await ev("const b=root.querySelector('.ns-drawer [data-st=done]'); if(b) b.click(); return !!b;");
  await page.waitForTimeout(900);
  const after=await ev("const on=Array.from(root.querySelectorAll('[data-f]')).filter(b=>b.classList.contains('on')).map(b=>b.getAttribute('data-f')); const rows=Array.from(root.querySelectorAll('.ns-row')).map(r=>({id:r.getAttribute('data-item'),pill:(r.querySelector('.ns-pill')||{}).textContent||''})); return {on:on, rows:rows};");
  await page.screenshot({path:path.join(OUT,'12-filter-after-status.png')});
  console.log(JSON.stringify({errors, before, after}, null, 1));
  await browser.close();
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
