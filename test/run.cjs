'use strict';
const fs = require('fs');
const path = require('path');
const PW = process.env.PLAYWRIGHT_PATH || 'playwright-core';
const { chromium } = require(PW);
require('./_preview.cjs')();
const CHROME = process.env.CHROME_PATH || null; // 留空则用 Playwright 自带 Chromium
const DIR = __dirname;
const OUT = path.join(DIR, 'out');
fs.mkdirSync(OUT, { recursive: true });
const MOCK = JSON.parse(fs.readFileSync(path.join(DIR, 'mock.json'), 'utf8'));

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME, headless: true } : { headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.addInitScript((mock) => {
    window.__posted = [];
    const cssText = () => document.getElementById('ns-css').textContent;
    window.fetch = function (url, opts) {
      url = String(url);
      if (url.indexOf('/northstar/overlay.css') >= 0) return Promise.resolve({ ok: true, text: () => Promise.resolve(cssText()) });
      if (url.indexOf('/northstar/api') >= 0) {
        if (opts && opts.method === 'POST') {
          const b = JSON.parse(opts.body);
          window.__posted.push(b);
          const L = mock.ledger;
          if (b.action === 'update') {
            const it = L.find(x => x.id === b.id);
            if (it) { it.status = b.status; if (b.result) it.result = b.result; if (b.evidence) it.evidence = b.evidence; }
            mock.counts = { total: L.length, todo: 0, doing: 0, done: 0, blocked: 0, void: 0 };
            for (const x of L) mock.counts[x.status] = (mock.counts[x.status] || 0) + 1;
            mock.activity.push({ at: new Date().toISOString(), kind: 'ui', detail: b.id + ' → ' + b.status, session: 'ui', name: '' });
          }
          if (b.action === 'session-name') { mock.sessionNames[b.session] = b.name; mock.activity.push({ at: new Date().toISOString(), kind: 'ui', detail: '命名会话 ' + b.session + ' → ' + b.name, session: 'ui', name: '' }); }
          if (b.action === 'redline') { mock.activity.push({ at: new Date().toISOString(), kind: 'ui', detail: '改红线 ' + b.id, session: 'ui', name: '' }); }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mock) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
    };
    try {
      localStorage.setItem('dsh.northstar.stash.D__Work_demo', JSON.stringify([
        { text: '帮我审阅 P03 批次里的 8 张截图，逐张对照验收标准，指出不一致的地方并登记到台账', at: new Date().toISOString() },
        { text: '短的一条', at: new Date().toISOString() }
      ]));
      localStorage.setItem('dsh.northstar.ui', JSON.stringify({ tab: 'stash', filter: ['todo','doing'] }));
    } catch (e) {}
  }, MOCK);

  await page.goto('file:///' + path.join(DIR, 'preview.html').replace(/\\/g, '/'));
  await page.addScriptTag({ path: path.join(DIR, '..', 'lib', 'overlay.js') });
  await page.waitForTimeout(1200);

  const res = { errors, steps: [] };
  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name + '.png') }); };
  const host = () => page.evaluate(() => {
    const h = document.getElementById('dsh-northstar-host') || document.querySelector('[data-northstar-root]');
    return h ? h.shadowRoot !== null : null;
  });

  // 找到 shadow root 的辅助
  const shadowEval = (fn, arg) => page.evaluate(({ code, a }) => {
    const roots = [];
    for (const el of document.body.children) if (el.shadowRoot) roots.push(el.shadowRoot);
    const root = roots[0];
    if (!root) return { error: 'no shadow root', body: document.body.innerHTML.slice(0, 400) };
    return new Function('root', 'arg', code)(root, a);
  }, { code: fn, a: arg });

  // 1) 面板已渲染
  res.steps.push({ name: 'mounted', value: await page.evaluate(() => document.body.children.length) });
  await shot('01-board');

  // 2) 台账横向溢出检测
  res.overflow = await shadowEval(`
    const out = {};
    for (const sel of ['.ns-stash', '.ns-list', '.ns-actlist', '.ns-body']) {
      const el = root.querySelector(sel);
      out[sel] = el ? { sw: el.scrollWidth, cw: el.clientWidth, over: el.scrollWidth - el.clientWidth } : null;
    }
    const fill = root.querySelector('.ns-fill');
    out.fill = fill ? { w: fill.getBoundingClientRect().width, track: (root.querySelector('.ns-track')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width, style: fill.getAttribute('style') } : null;
    return out;
  `);

  // 3) 打开详情，检查来源/详情/结果
  await shadowEval(`const rows=root.querySelectorAll('[data-item]'); if(rows[1]) rows[1].click(); return rows.length;`);
  await page.waitForTimeout(400);
  res.detail = await shadowEval(`const d=root.querySelector('.ns-drawer'); return d ? d.innerText.slice(0,300) : 'no drawer';`);
  await shot('02-detail');

  // 4) 红线改：点"改"应出现 input（而不是 window.prompt）
  await shadowEval(`const b=root.querySelector('[data-red-edit]'); if(b) b.click(); return !!b;`);
  await page.waitForTimeout(300);
  res.redEdit = await shadowEval(`const i=root.querySelector('.ns-red input.ns-ta'); return i ? {ok:true, value:i.value.slice(0,40)} : {ok:false};`);
  await shot('03-red-edit');

  // 5) 暂存页
  await shadowEval(`const t=root.querySelector('[data-tab="stash"]'); if(t) t.click(); return !!t;`);
  await page.waitForTimeout(300);
  res.stash = await shadowEval(`
    const el = root.querySelector('.ns-stash');
    if (!el) return 'no .ns-stash';
    return { items: el.children.length, sw: el.scrollWidth, cw: el.clientWidth, over: el.scrollWidth - el.clientWidth };
  `);
  await shot('04-stash');
  await shadowEval(`const b=root.querySelector('[data-act="stash-add"]'); if(b) b.click(); return !!b;`);
  await page.waitForTimeout(500);
  res.stashToast = await shadowEval(`
    const t=root.querySelector('.ns-toast'); const p=root.querySelector('.ns-panel');
    if(!t||!p) return 'none';
    const r=t.getBoundingClientRect(), pr=p.getBoundingClientRect();
    const cs=getComputedStyle(t); return { text: (t.textContent||'').slice(0,20), on: t.classList.contains('on'), w: Math.round(r.width), h: Math.round(r.height), pad: cs.padding, br: cs.borderRadius, bg: cs.backgroundColor, centered: Math.abs((r.left+r.width/2)-(pr.left+pr.width/2)) < 2, aboveBottom: Math.round(pr.bottom - r.bottom) };
  `);
  await shot('04b-stash-toast');

  // 6) 记录页
  await shadowEval(`const t=root.querySelector('[data-tab="act"]'); if(t) t.click(); return !!t;`);
  await page.waitForTimeout(300);
  await shot('05-act');

  // 7) toast 位置
  res.toast = await shadowEval(`
    const t = root.querySelector('.ns-toast');
    if (!t) return 'none';
    t.textContent = '暂存已保存'; t.classList.add('on');
    const r = t.getBoundingClientRect(), p = root.querySelector('.ns-panel').getBoundingClientRect();
    return { toastX: Math.round(r.left + r.width/2), panelX: Math.round(p.left + p.width/2), top: Math.round(r.top), bg: getComputedStyle(t).backgroundColor };
  `);
  await page.waitForTimeout(200);
  await shot('06-toast');

  await shadowEval(`const t=root.querySelector('[data-tab="board"]'); if(t) t.click(); return !!t;`);
  await page.waitForTimeout(400);
  res.boardFill = await shadowEval(`
    const f=root.querySelector('.ns-fill'), tr=root.querySelector('.ns-track');
    if(!f||!tr) return 'none';
    return { fill: Math.round(f.getBoundingClientRect().width), track: Math.round(tr.getBoundingClientRect().width), pct: root.querySelector('.ns-pct') ? root.querySelector('.ns-pct').textContent : '' };
  `);
  await shot('07-board-final');
  res.layout = await shadowEval(`
    const pn=root.querySelector('.ns-panel'), bd=root.querySelector('.ns-body'), dr=root.querySelector('.ns-drawer');
    const g=(el)=>el?el.getBoundingClientRect():null;
    const cs=pn?getComputedStyle(pn):{};
    return { vh: window.innerHeight, panel: g(pn)&&Math.round(g(pn).height), panelTop: g(pn)&&Math.round(g(pn).top), panelBottom: g(pn)&&Math.round(g(pn).bottom),
      maxH: cs.maxHeight, bodyH: g(bd)&&Math.round(g(bd).height), bodyScroll: bd?bd.scrollHeight:0, drawerH: g(dr)&&Math.round(g(dr).height), drawerVisible: dr ? (g(dr).top < window.innerHeight) : null };
  `);
  await shot('08-layout');
  // 筛选：逐个点击 chip，记录可见行数/高亮/标题计数
  res.filters = [];
  for (const f of ['todo', 'doing', 'done', 'blocked', 'void']) {
    const clicked = await shadowEval('const ch = root.querySelector(' + JSON.stringify('[data-f="' + f + '"]') + '); if (!ch) return false; ch.click(); return true;');
    await page.waitForTimeout(150);
    const st = await shadowEval(`
      const sum = root.querySelector('[data-sec="ledger"] summary');
      const rows = root.querySelectorAll('.ns-list .ns-row');
      const on = Array.from(root.querySelectorAll('[data-f]')).filter(b=>b.classList.contains('on')).map(b=>b.getAttribute('data-f'));
      return { summary: sum ? sum.innerText.split(String.fromCharCode(10)).join(' ') : '', rows: rows.length, on: on };
    `);
    res.filters.push({ chip: f, clicked, ...st });
  }
  // 全部按钮
  await shadowEval("const a=root.querySelector('[data-f=\"all\"]'); if(a) a.click(); return !!a;");
  await page.waitForTimeout(250);
  res.allFilter = await shadowEval("const rows=root.querySelectorAll('.ns-list .ns-row'); const on=Array.from(root.querySelectorAll('[data-f]')).filter(b=>b.classList.contains('on')).map(b=>b.getAttribute('data-f')); const sum=root.querySelector('[data-sec=\"ledger\"] summary'); return { rows: rows.length, on: on, summary: sum ? sum.innerText.split(String.fromCharCode(10)).join(' ') : '' };");
  await shot('10-filter-all');

  // 改状态：打开 B02 → 点完成 → 断言状态落库 + 自动出现在"完成"筛选
  await shadowEval("const rows=Array.from(root.querySelectorAll('[data-item]')); const r=rows.find(x=>x.getAttribute('data-item')==='B02'); if(r) r.click(); return !!r;");
  await page.waitForTimeout(400);
  res.rowProbe = await shadowEval(`
    const sel = Array.from(root.querySelectorAll('.ns-row.sel')).map(r=>r.getAttribute('data-item'));
    const dr = root.querySelector('.ns-drawer');
    const itemCount = root.querySelectorAll('[data-item]').length;
    const b02 = Array.from(root.querySelectorAll('[data-item]')).find(x=>x.getAttribute('data-item')==='B02');
    if (!dr && b02) { b02.click(); }
    return { selBefore: sel, drawerBefore: !!dr, itemCount: itemCount, hadB02: !!b02 };
  `);
  await page.waitForTimeout(400);
  res.rowProbe2 = await shadowEval("const dr=root.querySelector('.ns-drawer'); const sel=Array.from(root.querySelectorAll('.ns-row.sel')).map(r=>r.getAttribute('data-item')); return {drawer: !!dr, sel: sel, drawerText: dr?dr.innerText.slice(0,60):''};");
  await shadowEval("const b=root.querySelector('.ns-drawer [data-st=done]'); if(b) b.click(); return !!b;");
  await page.waitForTimeout(700);
  res.probe = await shadowEval(`
    const dr = root.querySelector('.ns-drawer');
    const btns = dr ? dr.querySelectorAll('[data-st]') : [];
    const target = dr ? dr.querySelector('[data-st=done]') : null;
    if (target) target.click();
    return { hasDrawer: !!dr, btnCount: btns.length, labels: Array.from(btns).map(b=>b.getAttribute('data-st')), clicked: !!target, postedLen: (window.__posted||[]).length, last: (window.__posted||[]).slice(-1)[0] || null };
  `);
  await page.waitForTimeout(500);
  res.statusChange = await shadowEval(`
    const rows = Array.from(root.querySelectorAll('.ns-list .ns-row')).map(r=>({id:r.getAttribute('data-item'), pill:(r.querySelector('.ns-pill')||{}).textContent||''}));
    const on = Array.from(root.querySelectorAll('[data-f]')).filter(b=>b.classList.contains('on')).map(b=>b.getAttribute('data-f'));
    return { rows: rows, on: on, posted: window.__posted.slice(-1)[0] };
  `);
  await shot('11-after-status');

  // 记录页内容
  await shadowEval('const t=root.querySelector(' + JSON.stringify('[data-tab="act"]') + '); if(t) t.click(); return !!t;');
  await page.waitForTimeout(300);
  res.actText = await shadowEval("const a=root.querySelector('.ns-actlist'); return a ? a.innerText.split(String.fromCharCode(10)).join(' | ') : 'none';");
  await shot('09-act-final');
  console.log(JSON.stringify(res, null, 2));
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
