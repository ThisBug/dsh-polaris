'use strict';
const fs=require('fs'), path=require('path');
const PW = process.env.PLAYWRIGHT_PATH || 'playwright-core';
const { chromium } = require(PW);
require('./_preview.cjs')();
const CHROME=process.env.CHROME_PATH||null;
const DIR=__dirname, OUT=path.join(DIR,'out'); fs.mkdirSync(OUT,{recursive:true});
const MOCK=JSON.parse(fs.readFileSync(path.join(DIR,'mock-multi.json'),'utf8'));
// 构造：200 条活动（验证不再截 30）+ 带 history 的台账项 + 偏离
{
  const T={read:function(){return '读取台账（目标·红线·进度）'},update:function(d){return '回写台账 '+d},add:function(d){return '登记台账 '+d},deviate:function(d){return '记录偏离 '+d}};
  const kinds=['read','update','add','deviate'];
  const acts=[];
  for(let i=0;i<200;i++){
    const k=kinds[i%4], d=k==='read'?'':('T'+((i%9)+1)+' → '+(k==='update'?'doing':'todo'));
    acts.push({at:new Date(Date.parse('2026-11-01T00:00:00Z')+i*3600000).toISOString(),kind:k,detail:d,text:T[k](d),session:i%5===0?'ui':'a1b2c3d4',name:'',origin:i%5===0?'panel':'tool'});
  }
  MOCK.activity=acts;
  MOCK.meta={lastToolReadAt:new Date().toISOString(),lastToolReadRev:5,rev:5};
  MOCK.ledger[1].history=[
    {at:'2026-10-01T02:00:00Z',from:'',to:'todo',via:'add'},
    {at:'2026-10-03T02:00:00Z',from:'todo',to:'doing',via:'tool'},
    {at:'2026-10-05T02:00:00Z',from:'doing',to:'done',via:'panel'},
    {at:'2026-10-06T02:00:00Z',from:'done',to:'doing',via:'tool'}
  ];
  MOCK.deviations=[
    {at:'2026-10-01T03:00:00Z',what:'用脚本造了一条测试数据',redLine:'R1',status:'open'},
    {at:'2026-10-02T03:00:00Z',what:'跳过了登录页取证',redLine:'R3',status:'resolved'}
  ];
  fs.writeFileSync(path.join(DIR,'mock-run4.json'),JSON.stringify(MOCK,null,2),'utf8');
}
const M=JSON.parse(fs.readFileSync(path.join(DIR,'mock-run4.json'),'utf8'));
(async()=>{
  const b=await chromium.launch(CHROME?{executablePath:CHROME,headless:true}:{headless:true});
  const p=await b.newPage({viewport:{width:1180,height:900},deviceScaleFactor:2});
  const errors=[]; p.on('pageerror',e=>errors.push(String(e)));
  await p.addInitScript((m)=>{
    window.fetch=function(u,o){u=String(u);
      if(u.indexOf('overlay.css')>=0) return Promise.resolve({ok:true,text:()=>Promise.resolve(document.getElementById('ns-css').textContent)});
      if(u.indexOf('/northstar/api')>=0){
        if(o&&o.method==='POST'){const body=JSON.parse(o.body); if(body.action==='deviation'){const d=m.deviations.find(x=>x.at===body.at); if(d) d.status=body.status;} return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({ok:true})});}
        return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(m)});
      }
      return Promise.resolve({ok:true,text:()=>Promise.resolve('')});};
    window.__bumpRev=function(){ m.meta.rev=(m.meta.rev||0)+1; m.meta.lastToolReadRev=m.meta.rev; m.meta.lastToolReadAt=new Date().toISOString(); };
    localStorage.setItem('dsh.northstar.ui',JSON.stringify({tab:'board',filter:['todo','doing'],theme:'glass'}));
  },M);
  await p.goto('file:///'+path.resolve(DIR,'preview.html').replace(/\\/g,'/'));
  await p.addScriptTag({path:path.join(DIR,'..','lib','overlay.js')});
  await p.waitForTimeout(900);
  const ev=(c)=>p.evaluate((code)=>{const roots=[];for(const el of document.body.children) if(el.shadowRoot) roots.push(el.shadowRoot); const root=roots[0]; return new Function('root',code)(root);},c);
  const res={errors};
  // A) 记录不再截 30
  await ev("const t=root.querySelector('[data-tab=act]'); t.click(); return true;");
  await p.waitForTimeout(400);
  res.actTab = await ev("const t=root.querySelector('[data-tab=act]'); const rows=root.querySelectorAll('.ns-act-row'); const more=root.querySelector('[data-act=act-more]'); return {tab:t.textContent.trim(),rows:rows.length,more:more?more.textContent.trim():null};");
  await p.screenshot({path:path.join(OUT,'r4-01-act.png')});
  // B) 翻页加载更早
  await ev("const m=root.querySelector('[data-act=act-more]'); if(m) m.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true;");
  await p.waitForTimeout(400);
  res.actMore = await ev("const rows=root.querySelectorAll('.ns-act-row'); const more=root.querySelector('[data-act=act-more]'); return {rows:rows.length,more:more?more.textContent.trim():null};");
  // C) 点台账行 → 侧边抽屉（不在列表内展开）
  await ev("const t=root.querySelector('[data-tab=board]'); t.click(); return true;");
  await p.waitForTimeout(300);
  const opened = await ev("const rows=Array.from(root.querySelectorAll('[data-item]')); const r=rows[0]; if(r) r.dispatchEvent(new MouseEvent('click',{bubbles:true})); return !!r;");
  await p.waitForTimeout(500);
  res.side = await ev(`
    const side=root.querySelector('.ns-side'); const list=root.querySelector('.ns-list'); const pn=root.querySelector('.ns-panel');
    const sr=side?side.getBoundingClientRect():null, pr=pn.getBoundingClientRect();
    const inList=root.querySelectorAll('.ns-list .ns-drawer, .ns-list .kvs').length;
    return {open: !!(side&&side.classList.contains('on')), x: sr?Math.round(sr.left):null, w: sr?Math.round(sr.width):null,
      leftOfPanel: sr ? (sr.left + sr.width) <= pr.left + 4 : null, clearsPanel: sr ? (sr.left + sr.width) <= pr.left + 4 : null, insideList: inList, hasStatusBtns: side?side.querySelectorAll('[data-st]').length:0,
      hasHistory: side?!!side.querySelector('.ns-hist'):null, histRows: side?side.querySelectorAll('.ns-hist .hrow').length:0};
  `);
  await p.screenshot({path:path.join(OUT,'r4-02-side.png')});
  // D) 关闭
  await ev("const c=root.querySelector('.ns-side [data-act=item-close]'); if(c) c.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true;");
  await p.waitForTimeout(400);
  res.sideClosed = await ev("const s=root.querySelector('.ns-side'); return !s||!s.classList.contains('on');");
  // E) 偏离区 + 标记已处理
  res.dev = await ev(`
    const sec=root.querySelector('[data-sec=dev]'); const items=root.querySelectorAll('.ns-dev li');
    const btn=root.querySelector('[data-devok]');
    return {section: !!sec, items: items.length, pending: btn?btn.textContent.trim():null};
  `);
  await ev("const b=root.querySelector('[data-devok]'); if(b) b.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true;");
  await p.waitForTimeout(600);
  res.devAfter = await ev(`
    const items=root.querySelectorAll('.ns-dev li'); const ok=Array.from(items).filter(li=>li.classList.contains('ok')).length;
    const cnt=root.querySelector('[data-sec=dev] .cnt');
    return {okRows: ok, total: items.length, counter: cnt?cnt.textContent.trim():null};
  `);
  await p.screenshot({path:path.join(OUT,'r4-03-dev.png')});
  // F) 已读判定用 rev 而不是机器时间
  res.readBefore = await ev("const r=root.querySelector('.ns-read'); return {text:r.textContent.trim(),cls:r.className};");
  // 模拟本会话发生一次工具读取：rev 从 5 涨到 6
  await p.evaluate(()=>{ window.__bumpRev(); window.dispatchEvent(new Event('hashchange')); });
  await p.waitForTimeout(900);
  res.readAfter = await ev("const r=root.querySelector('.ns-read'); return {text:r.textContent.trim(),cls:r.className};");
  // G) 主题三档仍可用
  res.theme = await ev("const n=root.querySelectorAll('[data-th]').length; const hasOp=!!root.querySelector('[data-op]'); return {themes:n,noOpacity:!hasOp};");
  res.errors=errors;
  console.log(JSON.stringify(res,null,1));
  await b.close();
})().catch(e=>{console.error('FAIL',String(e).slice(0,400)); process.exit(1);});
