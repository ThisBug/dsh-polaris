'use strict';
const fs=require('fs'), path=require('path');
const PW = process.env.PLAYWRIGHT_PATH || 'playwright-core';
const { chromium } = require(PW);
const CHROME=process.env.CHROME_PATH||null;
const DIR=__dirname, OUT=path.join(DIR,'out'); fs.mkdirSync(OUT,{recursive:true});
const MOCK=JSON.parse(fs.readFileSync(path.join(DIR,'mock-multi.json'),'utf8'));
// rebuild preview from current CSS
{
  const css = fs.readFileSync(path.join(DIR,'..','lib','overlay.css'),'utf8');
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>northstar preview</title>' +
    '<style>html,body{margin:0;height:100%;background:linear-gradient(160deg,#0b1220,#17233a 60%,#0d1526);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style>' +
    '<style id="ns-css">' + css + '</style></head><body><div style="position:fixed;left:12px;bottom:8px;color:#8aa;font:12px/1.4 sans-serif;opacity:.6">northstar preview harness</div></body></html>';
  fs.writeFileSync(path.join(DIR,'preview.html'), html, 'utf8');
}
(async()=>{
  const browser=await chromium.launch(CHROME?{executablePath:CHROME,headless:true}:{headless:true});
  const page=await browser.newPage({viewport:{width:1180,height:900},deviceScaleFactor:2});
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript((mock)=>{
    window.__wsCalls=[];
    const ACTT={read:function(){return '读取台账（目标·红线·进度）'},check:function(d){return d&&d!=='开工闸门校验'?'开工校验：'+d:'开工校验'},update:function(d){return '回写台账 '+d},add:function(d){return '登记台账 '+d},goal:function(d){return d||'修改目标'},redline:function(d){return d||'修改红线'},deviate:function(d){return '记录偏离 '+d}};
    const actText=function(k,d){const f=ACTT[k];return f?f(String(d||'')):String(d||k)};

    const cssText=()=>document.getElementById('ns-css').textContent;
    window.fetch=function(url,opts){
      url=String(url);
      if(url.indexOf('/northstar/overlay.css')>=0) return Promise.resolve({ok:true,text:()=>Promise.resolve(cssText())});
      if(url.indexOf('/northstar/api')>=0){
        if(opts&&opts.method==='POST'){
          const b=JSON.parse(opts.body);
        if(b.action==='update'){const it=mock.ledger.find(x=>x.id===b.id); if(it) it.status=b.status; mock.activity.push({at:new Date().toISOString(),kind:'update',detail:b.id+' → '+b.status,text:actText('update',b.id+' → '+b.status),session:'ui',name:'',origin:'panel'});}
          return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({ok:true})});
        }
        window.__wsCalls.push(url);
        const other = url.indexOf('second')>=0;
        const data = other ? { workspace:'D:/Work/second', workspaces:mock.workspaces, updatedAt:new Date().toISOString(), northStar:'另一个项目的目标', redLines:[{id:'R9',text:'另一项目红线'}], ledger:[{id:'X01',title:'另一个项目待办',status:'todo',source:'用户指令',detail:'测试切换',result:'',evidence:'',updatedAt:new Date().toISOString()}], counts:{total:1,todo:1,doing:0,done:0,blocked:0,void:0}, meta:mock.meta, activity:[], sessionNames:{}, guiUrl:mock.guiUrl }
                    : mock;
        return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(data)});
      }
      return Promise.resolve({ok:true,text:()=>Promise.resolve('')});
    };
    localStorage.setItem('dsh.northstar.ui', JSON.stringify({tab:'act', filter:['todo','doing'], theme:'glass'}));
    localStorage.setItem('dsh.northstar.stash.D__Work_demo', JSON.stringify([{text:'demo 的暂存',at:new Date().toISOString()}]));
    localStorage.setItem('dsh.northstar.stash.D__Work_second', JSON.stringify([{text:'second 的暂存',at:new Date().toISOString()}]));
  }, MOCK);
  await page.goto('file:///'+path.join(DIR,'preview.html').replace(/\\/g,'/'));
  await page.addScriptTag({path: path.join(DIR, '..', 'lib', 'overlay.js')});
  await page.waitForTimeout(1200);
  const ev=(c)=>page.evaluate((code)=>{const roots=[];for(const el of document.body.children) if(el.shadowRoot) roots.push(el.shadowRoot); const root=roots[0]; return new Function('root',code)(root);},c);
  const res={errors};
  // 1) 记录条数 ≤ 30
  res.theme = await ev(`
    const pn=root.querySelector('.ns-panel');
    const btns=Array.from(root.querySelectorAll('[data-th]')).map(b=>({th:b.getAttribute('data-th'),on:b.classList.contains('on')}));
    const hasOpacity = !!root.querySelector('[data-op]');
    return { btns: btns, active: pn.getAttribute('data-theme'), hasOpacity: hasOpacity };
  `);
  res.layout = await ev(`
    const pn=root.querySelector('.ns-panel'), list=root.querySelector('.ns-actlist'), btn=root.querySelector('.ns-ddbtn'), op=root.querySelector('.ns-oprow');
    const pr=pn.getBoundingClientRect();
    const lr=list?list.getBoundingClientRect():null;
    const cs=btn?getComputedStyle(btn):{};
    return {
      panelBottom: Math.round(pr.bottom),
      panelH: Math.round(pr.height),
      panelOverflow: pn.scrollHeight - pn.clientHeight,
      listBottom: lr?Math.round(lr.bottom):null,
      listInside: lr ? (lr.bottom <= pr.bottom + 1 && lr.top >= pr.top) : null,
      listScrollable: list ? list.scrollHeight > list.clientHeight + 2 : null,
      listH: list?Math.round(list.clientHeight):0,
      ddBg: cs.backgroundColor, ddColor: cs.color, ddRadius: cs.borderRadius,
      themeBtns: root.querySelectorAll('[data-th]').length
    };
  `);
  res.box = await ev(`
    const pn=root.querySelector('.ns-panel'), bd=root.querySelector('.ns-body'), hd=root.querySelector('.ns-head');
    const cs=getComputedStyle(pn), cb=bd?getComputedStyle(bd):{};
    return {
      panel:{display:cs.display, dir:cs.flexDirection, maxH:cs.maxHeight, h:Math.round(pn.getBoundingClientRect().height), sh:pn.scrollHeight, ch:pn.clientHeight},
      head: hd?Math.round(hd.getBoundingClientRect().height):0,
      body: bd?{flex:cb.flex, minH:cb.minHeight, overflowY:cb.overflowY, maxH:cb.maxHeight, h:Math.round(bd.getBoundingClientRect().height), sh:bd.scrollHeight, ch:bd.clientHeight}:null
    };
  `);
  res.footCheck = await ev("const f=root.querySelector('.ns-foot'); const pn=root.querySelector('.ns-panel'); return { footParent: f && f.parentElement ? f.parentElement.className : null, isPanelChild: !!(f && f.parentElement === pn), footTop: f?Math.round(f.getBoundingClientRect().top):0, panelBottom: Math.round(pn.getBoundingClientRect().bottom) };");
  res.kids = await ev(`
    const pn=root.querySelector('.ns-panel');
    const pr=pn.getBoundingClientRect();
    const out=[];
    for (const el of pn.children) {
      const r=el.getBoundingClientRect();
      out.push({cls:el.className, top:Math.round(r.top-pr.top), h:Math.round(r.height), bottom:Math.round(r.bottom-pr.top)});
    }
    const deep=[];
    pn.querySelectorAll('*').forEach(el=>{ const r=el.getBoundingClientRect(); if (r.bottom > pr.bottom + 1) deep.push({cls:el.className, bottom:Math.round(r.bottom-pr.bottom)}); });
    return {overflow:getComputedStyle(pn).overflow, kids:out, deep:deep.slice(0,8), deepCount:deep.length};
  `);
  res.align = await ev(`
    const rows=Array.from(root.querySelectorAll('.ns-act-row')).slice(0,4);
    const xs = rows.map(r=>{ const t=r.querySelector('.t'), tag=r.querySelector('.ns-tag'), d=r.querySelector('.d');
      return { time: t?Math.round(t.getBoundingClientRect().left):0, tag: tag?Math.round(tag.getBoundingClientRect().left):0, text: d?Math.round(d.getBoundingClientRect().left):0,
               tagW: tag?Math.round(tag.getBoundingClientRect().width):0 }; });
    return { xs, alignedText: xs.length>1 ? new Set(xs.map(x=>x.text)).size === 1 : null, alignedTag: xs.length>1 ? new Set(xs.map(x=>x.tagW)).size === 1 : null };
  `);
  res.onActTab = await ev("return { ws: !!root.querySelector('[data-ws]'), theme: !!root.querySelector('[data-th]'), noOpacity: !root.querySelector('[data-op]'), actTabOn: !!root.querySelector('[data-tab=act].on') };");
  res.act = await ev(`const rows=root.querySelectorAll('.ns-act-row'); const tab=root.querySelector('[data-tab="act"]'); const names=Array.from(rows).slice(0,3).map(r=>r.innerText.split(String.fromCharCode(10)).join(' ')); return {rows:rows.length, tabText: tab?tab.textContent:'', first:names};`);
  // 2) 主题切换（液态玻璃 → 黑夜）
  await ev("const b=root.querySelector('[data-th=dark]'); if(b) b.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true;");
  await page.waitForTimeout(300);
  res.contrast = await ev(`
    const pn=root.querySelector('.ns-panel');
    const parse=function(c){const m=c.match(/rgba?\\(([^)]+)\\)/); if(!m) return null; const a=m[1].split(',').map(Number); return {r:a[0],g:a[1],b:a[2],a:a.length>3?a[3]:1};};
    const lum=function(c){return (0.299*c.r+0.587*c.g+0.114*c.b)/255;};
    const fg=parse(getComputedStyle(pn).color);
    const bg=parse(getComputedStyle(pn).backgroundColor) || {r:20,g:25,b:35,a:1};
    const panelBg=/rgba\\(([^)]+)\\)/.exec(getComputedStyle(pn).backgroundImage);
    const base=panelBg?parse('rgba('+panelBg[1]+')'):bg;
    return { fgLum: Math.round(lum(fg)*100)/100, bgLum: Math.round(lum(base)*100)/100, diff: Math.round(Math.abs(lum(fg)-lum(base))*100)/100 };
  `);
  res.themeAfter = await ev(`const pn=root.querySelector('.ns-panel'); return { v: pn.getAttribute('data-theme'), dark: pn.classList.contains('ns-dark'), light: pn.classList.contains('ns-light'), bg: getComputedStyle(pn).backgroundImage.slice(0,46), fg: getComputedStyle(pn).color, stored: (JSON.parse(localStorage.getItem('dsh.northstar.ui')||'{}').theme) };`);
  await page.screenshot({path:path.join(OUT,'13-theme-dark.png')});
  res.themeAll = [];
  for (const th of ['glass','dark','light']) {
    await ev("const b=root.querySelector('[data-th=dark]'); root.querySelectorAll('[data-th]').forEach(function(x){ if(x.getAttribute('data-th')==='"+th+"') x.dispatchEvent(new MouseEvent('click',{bubbles:true})); }); return true;");
    await page.waitForTimeout(350);
    res.themeAll.push(await ev(`
      const pn=root.querySelector('.ns-panel');
      const parse=function(c){const m=c&&c.match(/rgba?\\(([^)]+)\\)/); if(!m) return null; const a=m[1].split(',').map(Number); return {r:a[0],g:a[1],b:a[2],a:a.length>3?a[3]:1};};
      const lum=function(c){return (0.299*c.r+0.587*c.g+0.114*c.b)/255;};
      const bi=getComputedStyle(pn).backgroundImage;
      const m=bi.match(/rgba\\(([^)]+)\\)/);
      const base=m?parse('rgba('+m[1]+')'):null;
      const fgc=getComputedStyle(pn).color;
      return { theme: pn.getAttribute('data-theme'), fg: fgc, baseLum: base?Math.round(lum(base)*100)/100:null, fgLum: Math.round(lum(parse(fgc))*100)/100, diff: base?Math.round(Math.abs(lum(base)-lum(parse(fgc)))*100)/100:null };
    `));
    await page.screenshot({path:path.join(OUT,'theme-'+th+'.png')});
  }
  // 3) 项目切换
  res.wsOptions = await ev("return Array.from(root.querySelectorAll('.ns-dditem')).map(o=>({v:o.getAttribute('data-wsval'),t:o.textContent}));");
  await ev("const b=root.querySelector('[data-ws]'); b.click(); return !!b;");
  await page.waitForTimeout(200);
  await ev("const all=Array.from(root.querySelectorAll('[data-wsval]')); const x=all.find(a=>a.getAttribute('data-wsval')==='D:/Work/second'); if(x) x.click(); return !!x;");
  await page.waitForTimeout(900);
  res.afterSwitch = await ev(`const bar=root.querySelector('.ns-panel'); const goal=root.querySelector('.ns-goal'); const tabs=root.querySelector('[data-tab="stash"]'); const act=root.querySelectorAll('.ns-act-row').length; return {ws:localStorage.getItem('dsh.northstar.ui'), goalText: goal?goal.innerText.slice(0,20):'', actRows: act};`);
  res.wsCalls = await page.evaluate(()=>window.__wsCalls.slice(-3));
  // 切到暂存页看是否按项目隔离
  await ev(`const t=root.querySelector('[data-tab="stash"]'); if(t) t.click(); return !!t;`);
  await page.waitForTimeout(400);
  res.stashAfterSwitch = await ev(`const items=root.querySelectorAll('.ns-stash .txt'); return Array.from(items).map(x=>x.textContent);`);
  await page.screenshot({path:path.join(OUT,'14-project-switch.png')});
  console.log(JSON.stringify(res,null,1));
  await browser.close();
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
