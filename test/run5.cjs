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
  const res={viewports:[]};
  for (const vp of [{w:1440,h:960},{w:1280,h:800},{w:1100,h:800},{w:1920,h:1080}]) {
    const ctx=await b.newContext({viewport:{width:vp.w,height:vp.h}});
    const p=await ctx.newPage();
    const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
    await p.addInitScript((m)=>{
      window.fetch=function(u,o){u=String(u);
        if(u.indexOf('overlay.css')>=0) return Promise.resolve({ok:true,text:()=>Promise.resolve(document.getElementById('ns-css').textContent)});
        if(u.indexOf('/northstar/api')>=0) return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(m)});
        return Promise.resolve({ok:true,text:()=>Promise.resolve('')});};
      localStorage.setItem('dsh.northstar.ui',JSON.stringify({tab:'board',filter:['all'],theme:'glass'}));
    },M);
    await p.goto('file:///'+path.resolve(DIR,'preview.html').replace(/\\/g,'/'));
    await p.addScriptTag({path:path.join(DIR,'..','lib','overlay.js')});
    await p.waitForTimeout(900);
    const ev=(c)=>p.evaluate((code)=>{const root=document.getElementById('ns-host').shadowRoot; return new Function('root',code)(root);},c);
    const r={vp:vp.w+'x'+vp.h, errors:errs};

    // ---- 0) 关闭态抽屉不得拦截任何点击：在整个面板矩形上取 12 个点做 elementFromPoint ----
    r.deadZones = await ev(`
      const pn=root.querySelector('.ns-panel'); const pr=pn.getBoundingClientRect();
      const bad=[];
      // 只看面板内 10%~90% 区间（圆角四角天然在面板外）
      for (let i=1;i<=8;i++) for (let j=1;j<=6;j++) {
        const x=pr.left+pr.width*(i/9), y=pr.top+pr.height*(j/7);
        const e=root.elementFromPoint(x,y);
        if (!e) { bad.push({x:Math.round(x),y:Math.round(y),hit:'null'}); continue; }
        if (!pn.contains(e)) bad.push({x:Math.round(x),y:Math.round(y),hit:(e.className||e.tagName)});
      }
      // 关闭态抽屉整块区域：任何点都不应命中 .ns-side
      const sd=root.querySelector('.ns-side'); const sr=sd.getBoundingClientRect();
      let sideHits=0;
      if (sr.width>0) for (let i=0;i<=4;i++) for (let j=0;j<=2;j++) {
        const x=sr.left+sr.width*(i/4), y=sr.top+sr.height*(j/2);
        if (x>=pr.left && x<=pr.right && y>=pr.top && y<=pr.bottom) continue; // 跳过与面板重叠的采样
        const e=root.elementFromPoint(Math.min(x, sr.right-1), Math.min(y, sr.bottom-1));
        if (e && (e===sd || sd.contains(e))) sideHits++;
      }
      return {samples: 8*6, bad: bad, sideHitsWhenClosed: sideHits, sideRect:[Math.round(sr.left),Math.round(sr.right)]};
    `);

    // ---- 1) 真实鼠标点击右上角「缩小」按钮 ----
    let g = await ev("const b=root.querySelector('[data-act=toggle]'); const q=b.getBoundingClientRect(); return {x:q.left+q.width/2,y:q.top+q.height/2,box:[Math.round(q.left),Math.round(q.top),Math.round(q.width),Math.round(q.height)]};");
    await p.mouse.click(g.x,g.y); await p.waitForTimeout(400);
    r.collapse = { btnBox:g.box, collapsed: await ev("return root.querySelector('.ns-panel').classList.contains('ns-collapsed');") };
    // 展开
    g = await ev("const b=root.querySelector('.ns-panel [data-act=toggle]'); const q=b.getBoundingClientRect(); return {x:q.left+q.width/2,y:q.top+q.height/2};");
    await p.mouse.click(g.x,g.y); await p.waitForTimeout(450);
    r.expand = { expanded: !(await ev("return root.querySelector('.ns-panel').classList.contains('ns-collapsed');")) };

    // ---- 2) 主题三颗按钮真实点击 ----
    const themeHits=[];
    for (const th of ['dark','light','glass']) {
      g = await ev("const b=root.querySelector('[data-th=" + th + "]'); const q=b.getBoundingClientRect(); return {x:q.left+q.width/2,y:q.top+q.height/2};");
      await p.mouse.click(g.x,g.y); await p.waitForTimeout(350);
      themeHits.push({th, active: await ev("return root.querySelector('.ns-panel').getAttribute('data-theme');")});
    }
    r.themes=themeHits;

    // ---- 3) 项目下拉：真实点击开 → 选中第二项 ----
    g = await ev("const b=root.querySelector('[data-ws]'); const q=b.getBoundingClientRect(); return {x:q.left+q.width/2,y:q.top+q.height/2};");
    await p.mouse.click(g.x,g.y); await p.waitForTimeout(350);
    const dd = await ev("return {open:root.querySelector('.ns-dd').classList.contains('open'), n:root.querySelectorAll('[data-wsval]').length};");
    let sel=null;
    if (dd.open && dd.n>1) {
      g = await ev("const it=root.querySelectorAll('[data-wsval]')[1]; const q=it.getBoundingClientRect(); return {x:q.left+q.width/2,y:q.top+q.height/2,v:it.getAttribute('data-wsval')};");
      await p.mouse.click(g.x,g.y); await p.waitForTimeout(600);
      sel = await ev("const b=root.querySelector('[data-ws]'); const st=JSON.parse(localStorage.getItem('dsh.northstar.ui')||'{}'); return {btn:b.getAttribute('data-ws'), state:st.ws, label:b.querySelector('span').textContent};");
    }
    r.dropdown={dd, sel, stateChanged: !!(sel && sel.state && sel.state !== M.workspace)};

    // ---- 4) 台账行：先点「全部」确保有行，再滚进可视区，然后左/中/右真实点击 ----
    await ev("const a=root.querySelector('[data-f=all]'); if(a) a.click(); return true;");
    await p.waitForTimeout(400);
    await ev("const rows=Array.from(root.querySelectorAll('[data-item]')); if(rows[3]) rows[3].scrollIntoView({block:'center'}); return true;");
    await p.waitForTimeout(300);
    const rowHits=[];
    for (const fx of [0.12,0.5,0.88]) {
      g = await ev("const r=Array.from(root.querySelectorAll('[data-item]'))[3]; if(!r) return null; const q=r.getBoundingClientRect(); return {x:q.left+q.width*"+str(fx)+",y:q.top+q.height/2,id:r.getAttribute('data-item')};");
      if(!g){ rowHits.push({fx,err:'no row'}); continue; }
      await p.mouse.click(g.x,g.y); await p.waitForTimeout(350);
      const opened = await ev("const s=root.querySelector('.ns-side'); return {open:!!(s&&s.classList.contains('on')), id:root.querySelector('.ns-side .ns-side-hd h4')?.textContent||''};");
      rowHits.push({fx, id:g.id, ...opened});
      if (opened.open) { await ev("const c=root.querySelector('.ns-side [data-act=item-close]'); if(c) c.click(); return true;"); await p.waitForTimeout(300); }
    }
    r.rows=rowHits;

    // ---- 5) 筛选 chip 左中右真实点击 ----
    const chipHits=[];
    for (const f of ['done','todo','doing']) {
      g = await ev("const c=root.querySelector('[data-f=" + f + "]'); if(!c) return null; const q=c.getBoundingClientRect(); return {x:q.left+q.width/2,y:q.top+q.height/2};");
      if (!g) { chipHits.push({f,err:'no chip'}); continue; }
      await p.mouse.click(g.x,g.y); await p.waitForTimeout(300);
      chipHits.push({f, on: await ev("const c=root.querySelector('[data-f=" + f + "]'); return c.classList.contains('on');")});
    }
    r.chips=chipHits;

    // ---- 6) 记录页：翻页按钮 + 标签点击 ----
    await ev("const t=root.querySelector('[data-tab=act]'); t.click(); return true;");
    await p.waitForTimeout(400);
    await ev("const bd=root.querySelector('.ns-body'); bd.scrollTop=0; return bd.scrollTop;");
    await p.waitForTimeout(300);
    await ev("const m=root.querySelector('[data-act=act-more]'); if(m) m.scrollIntoView({block:'center'}); return true;");
    await p.waitForTimeout(250);
    const moreBox = await ev("const m=root.querySelector('[data-act=act-more]'); if(!m) return null; const q=m.getBoundingClientRect(); return {x:q.left+q.width/2,y:q.top+q.height/2,inView:q.top>=0&&q.bottom<=window.innerHeight};");
    let moreOk=null;
    if (moreBox) {
      await p.mouse.click(moreBox.x, moreBox.y); await p.waitForTimeout(400);
      moreOk = await ev("const rows=root.querySelectorAll('.ns-act-row').length; return rows;");
    }
    r.actButtons = {moreBox: !!moreBox, inView: moreBox?moreBox.inView:null, rowsAfterMore: moreOk};

    // ---- 7) 暂存页输入框可聚焦、按钮可点 ----
    await ev("const t=root.querySelector('[data-tab=stash]'); t.click(); return true;");
    await p.waitForTimeout(350);
    const taBox = await ev("const ta=root.querySelector('#ns-stash-input'); if(!ta) return null; const q=ta.getBoundingClientRect(); return {x:q.left+q.width/2,y:q.top+q.height/2};");
    if (taBox) { await p.mouse.click(taBox.x, taBox.y); await p.waitForTimeout(250); }
    r.stashBtn = await ev("const ta=root.querySelector('#ns-stash-input'); const add=root.querySelector('[data-act=stash-add]'); const q=add.getBoundingClientRect(); return {focused: document.activeElement===ta || root.activeElement===ta, addBox:[Math.round(q.left),Math.round(q.top),Math.round(q.width)]};");
    if (r.stashBtn.addBox[2] > 0) {
      await p.mouse.click(r.stashBtn.addBox[0]+r.stashBtn.addBox[2]/2, r.stashBtn.addBox[1]+10);
      await p.waitForTimeout(300);
      r.stashBtn.toast = await ev("const t=root.querySelector('.ns-toast'); return t?t.textContent:'';");
    }
    if (r.vp==='1440x960') await p.screenshot({path:path.join(OUT,'run5-click.png')});
    res.viewports.push(r);
    await ctx.close();
  }
  console.log(JSON.stringify(res,null,1));
  await b.close();
})().catch(e=>{console.error('FAIL',String(e).slice(0,400)); process.exit(1);});

function str(n){return JSON.stringify(n)}
