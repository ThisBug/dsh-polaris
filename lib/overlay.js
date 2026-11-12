/* dsh-northstar overlay v4 · 项目自动切换 + 状态栏 */
(function () {
  if (window.__nsOverlay) return;
  window.__nsOverlay = true;
  var CSS_URL = '/northstar/overlay.css', STORE = 'dsh.northstar.ui', STASH = 'dsh.northstar.stash';
  var state = { data: null, tab: 'board', collapsed: false, pos: null, err: null, stash: [], ws: null,
    sel: null, open: {}, editing: false, sig: '', loading: false, baseline: 0, capsIx: 0,
    filter: ['todo', 'doing'], theme: 'glass', actShow: 30 };
  try { var s = JSON.parse(localStorage.getItem(STORE) || '{}');
    state.collapsed = !!s.collapsed; state.pos = s.pos || null; state.tab = s.tab || 'board';
    state.ws = s.ws || null; state.open = s.open || {}; if (Array.isArray(s.filter)) state.filter = s.filter; if (s.theme) state.theme = s.theme; } catch (e) {}
  function stashKey() { return STASH + '.' + (state.ws || (state.data && state.data.workspace) || 'default').replace(/[^a-zA-Z0-9]/g, '_'); }
  function loadStash() { try { state.stash = JSON.parse(localStorage.getItem(stashKey()) || '[]') || []; } catch (e) { state.stash = []; } }

  function save() { try { localStorage.setItem(STORE, JSON.stringify({ collapsed: state.collapsed, pos: state.pos, tab: state.tab, ws: state.ws, open: state.open, filter: state.filter, theme: state.theme })); } catch (e) {} }
  function saveStash() { try { localStorage.setItem(stashKey(), JSON.stringify(state.stash)); } catch (e) {} }
  function sid() { return (location.hash || location.pathname || '').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'default'; }

  // 本会话基线：首次打开时间，用来判断「本会话里 AI 有没有读过台账」
  (function () {
    var k = 'dsh.northstar.sess.' + sid();
    try { var v = localStorage.getItem(k); if (!v) { v = new Date().toISOString(); localStorage.setItem(k, v); } state.baseline = new Date(v).getTime(); } catch (e) { state.baseline = 0; }
  })();

  var host = document.createElement('div'); host.id = 'ns-host';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  document.body.appendChild(host);
  var styleEl = document.createElement('style'); root.appendChild(styleEl);
  fetch(CSS_URL).then(function (r) { return r.text(); }).then(function (t) { styleEl.textContent = t; }).catch(function () {});
  var panel = document.createElement('div'); panel.className = 'ns-panel' + (state.collapsed ? ' ns-collapsed' : ''); root.appendChild(panel);
  var drawerEl = document.createElement('div'); drawerEl.className = 'ns-side'; drawerEl.setAttribute('aria-hidden', 'true'); try { drawerEl.inert = true; } catch (e) {} root.appendChild(drawerEl);
  var toastEl = document.createElement('div'); toastEl.className = 'ns-toast'; root.appendChild(toastEl);
  var peekEl = document.createElement('div'); peekEl.className = 'ns-peek2'; root.appendChild(peekEl);
  function placeToast() {
    if (!panel) return;
    var r = panel.getBoundingClientRect();
    toastEl.style.cssText = [
      'position:fixed', 'bottom:auto', 'height:auto', 'z-index:2147482100', 'pointer-events:none',
      'padding:8px 14px', 'border-radius:12px', 'box-sizing:border-box',
      'background:rgba(10,15,24,.97)', 'border:1px solid rgba(255,255,255,.22)',
      'color:#f1f5fb', 'font-size:12px', 'line-height:1.45', 'font-weight:500',
      'text-align:center', 'max-width:min(300px,calc(100vw - 32px))',
      'box-shadow:0 14px 34px -10px rgba(0,0,0,.85)', 'backdrop-filter:blur(10px)',
      'transition:opacity .18s ease,transform .18s ease',
      'left:' + Math.round(r.left + r.width / 2) + 'px',
      'transform:translateX(-50%)',
      'top:' + Math.round(r.bottom - 54) + 'px'
    ].join(';');
  }
  function toast(m) { placeToast(); toastEl.textContent = m; toastEl.classList.add('on'); clearTimeout(toast._t); toastEl._t = setTimeout(function () { toastEl.classList.remove('on'); }, 1600); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pct(c) { return c && c.total ? Math.round((c.done || 0) * 100 / c.total) : 0; }
  // 文案与宿主 actText 完全一致；宿主若已给文本（text 字段）优先用
  function fmtAct(a) {
    if (a && a.text) return String(a.text);
    var k = String(a.kind || ''), d = String(a.detail || '');
    if (k === 'read') return '读取台账（目标·红线·进度）';
    if (k === 'check') return (d && d !== '开工闸门校验') ? '开工校验：' + d : '开工校验';
    if (k === 'update') return '回写台账 ' + d;
    if (k === 'add') return '登记台账 ' + d;
    if (k === 'deviate') return '记录偏离 ' + d;
    if (k === 'goal') return d || '修改目标';
    if (k === 'redline') return d || '修改红线';
    if (k === 'session') return d || '命名会话';
    return d || k;
  }
  function hhmm(iso) { if (!iso) return '--'; var d = new Date(iso); return isNaN(d) ? '--' : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function base(key) { return String(key).split(/[\\/]/).filter(Boolean).pop() || key; }

  // 用当前页面线索猜项目
  function detectWs(list) {
    if (!list || !list.length) return null;
    var hay = (location.hash + ' ' + location.pathname + ' ' + document.title + ' ' + (document.body.innerText || '').slice(0, 4000)).toLowerCase();
    var best = null, bestLen = 0;
    list.forEach(function (w) {
      var b = base(w.key).toLowerCase();
      if (b && b.length > 1 && hay.indexOf(b) >= 0 && b.length > bestLen) { best = w.key; bestLen = b.length; }
    });
    return best;
  }

  function render() {
    var d = state.data, c = (d && d.counts) || {}, p = pct(c);
    var doing = d ? (d.ledger || []).filter(function (x) { return x.status === 'doing'; }) : [];
    var step = doing.length ? (doing[0].id + ' ' + doing[0].title).slice(0, 22) : (d ? (c.done === c.total ? '全部完成' : '未开始') : '…');
    var readAt = d && d.meta && d.meta.lastToolReadAt;
    var readRev = (d && d.meta && d.meta.lastToolReadRev) || 0;
    var revKey = 'dsh.northstar.rev0.' + (state.ws || (d && d.workspace) || 'default');
    if (state.rev0 == null) {
      try { var sv = localStorage.getItem(revKey); state.rev0 = sv === null ? null : Number(sv); } catch (e) { state.rev0 = null; }
    }
    // 首帧拿到数据时把当时的 rev 记为基线（本会话开始前的读取不算）
    if (state.rev0 === null && d) { state.rev0 = (d.meta && d.meta.rev) || 0; try { localStorage.setItem(revKey, String(state.rev0)); } catch (e) {} }
    // 判定：① 会话 uuid 命中 ② 读取时间晚于本会话基线
    var byId = d && d.meta && d.meta.lastToolReadBy;
    var uuidInUrl = false;
    if (byId) { var mm2 = String(byId).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (mm2) uuidInUrl = location.href.indexOf(mm2[0]) >= 0; }
    var isRead = (state.rev0 !== null && readRev > state.rev0) || uuidInUrl;

    var TH = [['glass', '液态玻璃', '❄'], ['dark', '黑夜', '☾'], ['light', '白天', '☀']];
    var head = '<div class="ns-head" data-drag="1"><span class="ns-dot' + (state.err ? ' warn' : '') + '"></span>' +
      '<span class="ns-title">北极星</span>' +
      '<div class="ns-theme" data-theme="1">' + TH.map(function (t) {
        return '<button class="ns-thb' + (state.theme === t[0] ? ' on' : '') + '" data-th="' + t[0] + '" title="' + t[1] + '">' + t[2] + '</button>';
      }).join('') + '</div>' +
      '<span class="ns-pct">' + p + '%</span>' +
      '<button class="ns-btn" data-act="toggle">' + (state.collapsed ? '▢' : '—') + '</button></div>';
    var bar = '<div class="ns-bar"><span class="ns-proj" title="' + esc(d && d.workspace) + '">' + esc(d ? base(d.workspace) : '…') + '</span>' +
      '<span class="ns-step" title="' + esc(step) + '">' + esc(step) + '</span>' +
      '<span class="ns-read ' + (isRead ? 'ok' : 'no') + '" title="本会话 AI 是否读过台账">' + (isRead ? 'AI已读 ' + hhmm(readAt) : 'AI未读') + '</span></div>';

    if (state.collapsed) {
      var acts = (d && d.activity) || [];
      var last = acts.length ? acts[acts.length - 1] : null;
      var kindMap = { read: '读', check: '校验', update: '回写', add: '登记', goal: '目标', redline: '红线' };
      var names = (d && (d.sessionTitles || d.sessionNames)) || {};
      var nmOf = function (s) { return (names && names[s]) || s; };
      var ago = function (t) { var ms = Date.now() - new Date(t).getTime(); if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + 's前'; if (ms < 3600000) return Math.round(ms / 60000) + 'm前'; return Math.round(ms / 3600000) + 'h前'; };
      var slots = [
        { t: (d ? base(d.workspace) : '…') + ' ' + (c.done || 0) + '/' + (c.total || 0), p: p },
        { t: step },
        { t: last ? (nmOf(last.session) + ' ' + (kindMap[last.kind] || last.kind) + ' ' + last.detail) : '暂无活动' }
      ];
      var idx = (state.capsIx || 0) % slots.length;
      var cur = slots[idx];
      var peek = '<div class="ns-peek">' + (acts.length ? acts.slice(-4).reverse().map(function (a2) {
        return '<div class="row"><span class="s">' + esc(hhmm(a2.at)) + '</span><span class="k">' + esc(kindMap[a2.kind] || a2.kind) + '</span>' +
          '<span class="d"><b class="ns-tag" data-rename="' + esc(a2.session) + '" title="点击命名">' + esc(nmOf(a2.session)) + '</b>' + esc(a2.text || fmtAct(a2)) + '<span class="ns-ago">' + esc(ago(a2.at)) + '</span></span></div>';
      }).join('') : '<div class="row empty">本项目暂无活动记录</div>') + '</div>';
      panel.innerHTML =
        '<div class="ns-caps" data-drag="1">' +
          '<span class="ns-dot' + (state.err ? ' warn' : '') + '"></span>' +
          '<div class="cbody"><span class="ctext">' + esc(cur.t) + '</span>' +
          (idx === 0 ? '<span class="cprog"><i style="width:' + p + '%"></i></span><span class="cpct">' + p + '%</span>' : '') +
          '</div>' +
          '<button class="ns-thb" data-th-cycle="1" title="切换主题">' + ({ glass: '❄', dark: '☾', light: '☀' }[state.theme] || '❄') + '</button>' +
          '<button class="ns-btn" data-act="toggle">▢</button>' +
        '</div>';
      var cyc = panel.querySelector('[data-th-cycle]');
      if (cyc) cyc.onclick = function (e) {
        e.stopPropagation();
        var seq = ['glass', 'dark', 'light'];
        state.theme = seq[(seq.indexOf(state.theme) + 1) % seq.length];
        applyTheme(); save(); render();
      };
      bind();
      var cap = panel.querySelector('.ns-caps');
      if (cap) enableDrag(cap);
      peekEl.innerHTML = peek.replace('<div class="ns-peek">', '').replace(/<\/div>$/, '');
      cap.onmouseenter = function () {
        var r = cap.getBoundingClientRect();
        peekEl.style.left = Math.max(8, Math.min(window.innerWidth - 308, r.left)) + 'px';
        peekEl.style.top = (r.bottom + 8) + 'px';
        peekEl.classList.add('on');
      };
      cap.onmouseleave = function () { peekEl.classList.remove('on'); };
      peekEl.querySelectorAll('[data-rename]').forEach(function (b) {
        b.onclick = function (ev) {
          ev.stopPropagation();
          var sid = b.getAttribute('data-rename');
          var cur = b.textContent;
          var v = window.prompt('给这个会话起个名字（留空恢复短ID）', cur);
          if (v === null) return;
          post({ action: 'session-name', session: sid, name: v }).then(function () { state.data = null; fetchData(true); });
        };
      });
      return;
    }

    peekEl.classList.remove('on');
    var b = '<div class="ns-body">' + bar;
    var foot = '';
    if (!d) b += '<div class="ns-skeleton" style="width:88%"></div>';
    else {
      var wss = d.workspaces || [];
      b += '<div class="ns-tabs"><button class="ns-tab' + (state.tab === 'board' ? ' on' : '') + '" data-tab="board">台账</button>' +
        '<button class="ns-tab' + (state.tab === 'stash' ? ' on' : '') + '" data-tab="stash">暂存 ' + (state.stash.length || '') + '</button>' +
        '<button class="ns-tab' + (state.tab === 'act' ? ' on' : '') + '" data-tab="act">记录 ' + (((d && d.activity) || []).length || '') + '</button></div>';
      if (wss.length >= 1) {
        var labOf = function (w) {
          var bn = base(w.key);
          return (w.title && w.title !== bn ? w.title + ' · ' : '') + bn + (w.registered ? ' · ' + (w.counts.done || 0) + '/' + (w.counts.total || 0) : ' · 无台账');
        };
        var curWs = wss.filter(function (w) { return w.key === d.workspace; })[0] || wss[0];
        b += '<div class="ns-wsrow"><span class="ns-wslab">项目</span><div class="ns-dd" data-dd="ws">' +
          '<button class="ns-ddbtn" data-ws="' + esc(curWs.key) + '"><span>' + esc(labOf(curWs)) + '</span><i>▼</i></button>' +
          '<div class="ns-ddlist">' + wss.map(function (w) {
            return '<button class="ns-dditem' + (w.key === curWs.key ? ' on' : '') + '" data-wsval="' + esc(w.key) + '">' + esc(labOf(w)) + '</button>';
          }).join('') + '</div></div></div>';
      }

      b += '<div class="ns-pane' + (state.tab === 'board' ? ' on' : '') + '">';
      if (state.editing) {
        b += '<textarea class="ns-ta" id="ns-goal-edit">' + esc(d.northStar || '') + '</textarea>' +
          '<div class="ns-edit"><button class="ns-ghost primary" data-act="goal-save">保存目标</button><button class="ns-ghost" data-act="goal-cancel">取消</button></div>';
      } else {
        b += '<div class="ns-goal" data-act="goal">' + esc(d.northStar || '（未设置目标）') + '</div><div class="ns-acts"><button class="ns-mini" data-act="goal-edit">改目标</button></div>';
      }
      b += '<div class="ns-track"><div class="ns-fill" style="width:' + p + '%"></div></div>' +
        '<div class="ns-meta"><span>完成 ' + (c.done || 0) + '/' + (c.total || 0) + '</span><span>进行 ' + (c.doing || 0) + '</span><span>阻塞 ' + (c.blocked || 0) + '</span></div>';

      var redOpen = state.open.red !== false;
      b += '<details class="ns-sec"' + (redOpen ? ' open' : '') + ' data-sec="red"><summary><span class="chev">▸</span>红线<span class="cnt">' + (d.redLines || []).length + ' 条</span></summary><ul class="ns-red">' +
        (d.redLines || []).map(function (r) {
          return '<li><span><b>' + esc(r.id) + '</b> ' + esc(r.text) + '</span><button class="ns-mini" data-red-edit="' + esc(r.id) + '">改</button><button class="ns-mini" data-red-del="' + esc(r.id) + '">删</button></li>';
        }).join('') + '</ul><div class="ns-edit"><input class="ns-ta" id="ns-red-in" style="min-height:32px" placeholder="新增红线…"><button class="ns-ghost" data-act="red-add">加</button></div></details>';

      var devs = (d.deviations || []).filter(function (x) { return x.status !== 'resolved'; });
      if ((d.deviations || []).length) {
        b += '<details class="ns-sec" data-sec="dev"' + (devs.length ? ' open' : '') + '><summary><span class="chev">▸</span>偏离<span class="cnt">' + devs.length + ' 未处理 / ' + (d.deviations || []).length + ' 条</span></summary>' +
          '<ul class="ns-red ns-dev">' + (d.deviations || []).slice().reverse().slice(0, 12).map(function (x) {
            var done0 = x.status === 'resolved';
            return '<li class="' + (done0 ? 'ok' : '') + '"><span><b>' + esc(x.redLine || '-') + '</b> ' + esc(String(x.what || '').slice(0, 60)) +
              '<i class="muted"> ' + esc(String(x.at || '').slice(5, 16).replace('T', ' ')) + '</i></span>' +
              (done0 ? '<span class="ns-pill ns-done">已处理</span>' : '<button class="ns-mini" data-devok="' + esc(x.at) + '">标记已处理</button>') + '</li>';
          }).join('') + '</ul></details>';
      }

      var fdef = [['all','全部'],['todo','待办'],['doing','进行'],['done','完成'],['blocked','阻塞'],['void','作废']];
      var isOn = function (k) { return state.filter.indexOf('all') >= 0 ? k === 'all' : (k !== 'all' && state.filter.indexOf(k) >= 0); };
      var shown = (state.filter.indexOf('all') >= 0) ? (d.ledger || []) : (d.ledger || []).filter(function (x) { return state.filter.indexOf(x.status || 'todo') >= 0; });
      var ledOpen = state.open.ledger !== false;
      b += '<details class="ns-sec"' + (ledOpen ? ' open' : '') + ' data-sec="ledger"><summary><span class="chev">▸</span>台账<span class="cnt">' + (c.total || 0) + ' 项 · 当前筛出 ' + shown.length + '</span></summary>' +
        '<div class="ns-filter">' + fdef.map(function (f) { return '<button class="ns-f' + (isOn(f[0]) ? ' on' : '') + '" data-f="' + f[0] + '">' + f[1] + '<b>' + (f[0] === 'all' ? (c.total || 0) : (c[f[0]] || 0)) + '</b></button>'; }).join('') + '</div>' +
        '<div class="ns-list">' +
        shown.map(function (it) {
          var st = it.status || 'todo', on = state.sel === it.id;
          return '<div class="ns-row' + (on ? ' sel' : '') + '" data-item="' + esc(it.id) + '"><span class="ns-id">' + esc(it.id) + '</span>' +
            '<span class="ns-name" title="' + esc(it.title) + '">' + esc(it.title) + '</span><span class="ns-pill ns-' + st + '">' + st + '</span></div>';
        }).join('') + '</div></details>';

      if (state.sel) {
        var it = (d.ledger || []).filter(function (x) { return x.id === state.sel; })[0];
        if (it) {
          drawerEl.className = 'ns-side on';
          drawerEl.setAttribute('aria-hidden', 'false');
          try { drawerEl.inert = false; } catch (e) {}
          drawerEl.innerHTML = '<div class="ns-side-hd"><h4>' + esc(it.id) + ' · ' + esc(it.title) + '</h4><button class="ns-mini" data-act="item-close">✕</button></div>' +
            '<div class="kvs">' +
              '<div class="kv"><b>状态</b>' + esc(it.status || 'todo') + '　<b>更新</b>' + esc(hhmm(it.updatedAt)) + '</div>' +
              '<div class="kv"><b>来源</b>' + esc(it.source || '（未填）') + '</div>' +
              '<div class="kv"><b>详情</b>' + esc(it.detail || '（未填）') + '</div>' +
              '<div class="kv"><b>结果</b>' + esc(it.result || '（未回写）') + '</div>' +
              '<div class="kv"><b>证据</b>' + esc(it.evidence || '（无）') + '</div>' +
              '<div class="kv"><b>备注</b>' + esc(it.note || '（无）') + '</div>' +
            '</div>' +
            '<textarea class="ns-ta" id="ns-ev" placeholder="补充证据…">' + esc(it.evidence || '') + '</textarea>' +
            '<div class="ns-acts"><button class="ns-mini" data-st="todo">待办</button><button class="ns-mini" data-st="doing">进行</button>' +
            '<button class="ns-mini" data-st="done">完成</button><button class="ns-mini" data-st="blocked">阻塞</button>' +
            '<button class="ns-mini" data-st="void">作废</button></div>' +
            ((it.history || []).length > 1 ? '<div class="ns-hist"><b>状态轨迹</b>' + it.history.slice(-6).map(function (h) {
              return '<div class="hrow"><span>' + esc(hhmm(h.at)) + '</span><span>' + esc((h.from || '-') + ' → ' + h.to) + '</span><span class="muted">' + esc(h.via || '') + '</span></div>';
            }).join('') + '</div>' : '');
        } else { closeDrawer(); }
      } else { closeDrawer(); }
      b += '</div>';

      b += '<div class="ns-pane' + (state.tab === 'act' ? ' on' : '') + '">';
      var allActs = (d && d.activity) || [];
      var actWin = Math.max(30, Math.min(allActs.length, (state.actShow || 30)));
      var acts2 = allActs.slice(-actWin);
      var names2 = (d && d.sessionTitles) || {};
      var named2 = (d && d.sessionNames) || {};
      if (!acts2.length) b += '<div class="ns-empty">暂无活动记录（仅记录北极星工具调用）</div>';
      else {
        if (allActs.length > acts2.length) {
          b += '<div class="ns-more"><button class="ns-mini" data-act="act-more">加载更早的记录（还有 ' + (allActs.length - acts2.length) + ' 条）</button></div>';
        }
        b += '<div class="ns-actlist">';
        acts2.slice().reverse().forEach(function (a3) {
          var sid = a3.session;
          var nm = (names2 && names2[sid]) || (named2 && named2[sid]) || '';
          var who = (sid === 'ui' || a3.origin === 'panel') ? '本机用户·面板' : (nm || ('DSH 会话 ' + sid.slice(0, 6)));
          var full = nm || sid;
          b += '<div class="ns-act-row"><span class="t">' + esc(hhmm(a3.at)) + '</span>' +
            '<b class="ns-tag' + (a3.origin === 'panel' ? ' ui' : '') + '" data-rename="' + esc(sid) + '" title="' + esc(full) + '（点击命名）">' + esc(who) + '</b>' +
            '<span class="d">' + esc(fmtAct(a3)) + '</span></div>';
        });
        b += '</div>';
      }
      b += '</div>';
      b += '<div class="ns-pane' + (state.tab === 'stash' ? ' on' : '') + '">' +
        '<textarea class="ns-ta" id="ns-stash-input" placeholder="写点稍后要发的提示词…"></textarea>' +
        '<div class="ns-srow"><button class="ns-ghost primary" data-act="stash-add">存入暂存</button><button class="ns-ghost" data-act="stash-grab">取当前输入</button></div>';
      if (!state.stash.length) b += '<div class="ns-empty">还没有暂存。</div>';
      else {
        b += '<ul class="ns-stash">';
        state.stash.slice().reverse().forEach(function (it2, i) {
          var real = state.stash.length - 1 - i;
          b += '<li><span class="txt" title="' + esc(it2.text) + '">' + esc(it2.text) + '</span>' +
            '<button class="ns-mini use" data-use="' + real + '">填入</button><button class="ns-mini" data-del="' + real + '">删</button></li>';
        });
        b += '</ul>';
      }
      b += '</div>';
      foot = '<div class="ns-foot"><button class="ns-ghost" data-act="refresh">刷新</button><span class="ns-time">' + (state.err ? '离线' : '更新 ' + hhmm(d.updatedAt)) + '</span></div>';
    }
    b += '</div>' + foot;
    var prev = panel.querySelector('.ns-body');
    var sc = prev ? prev.scrollTop : 0;
    var lists = {};
    panel.querySelectorAll('.ns-list').forEach(function (l, i) { lists[i] = l.scrollTop; });
    panel.innerHTML = head + b;
    applyTheme();
    bind();
    bindDrawer();
    var nb = panel.querySelector('.ns-body'); if (nb) nb.scrollTop = sc;
    panel.querySelectorAll('.ns-list').forEach(function (l, i) { if (lists[i] != null) l.scrollTop = lists[i]; });
    clampIntoView();
    if (state.sel) { var dr0 = panel.querySelector('.ns-drawer'); if (dr0 && dr0.scrollIntoView) dr0.scrollIntoView({ block: 'nearest' }); }
  }

  function post(body) { state.sig = ''; body.workspace = state.data && state.data.workspace; var pr = fetch('/northstar/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); pr.then(function () { state.sig = ''; fetchData(true); }).catch(function () {}); return pr.then(function (r) { return r.json(); }); }
  function reload() { state.sig = ''; return fetchData(true); }

  function closeDrawer() {
    if (!drawerEl) return;
    drawerEl.className = 'ns-side';
    drawerEl.innerHTML = '';
    drawerEl.setAttribute('aria-hidden', 'true');
    try { drawerEl.inert = true; } catch (e) {}
  }

  function bindDrawer() {
    drawerEl.querySelectorAll('[data-act="item-close"]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); state.sel = null; drawerEl.className = 'ns-side'; drawerEl.innerHTML = ''; render(); });
    });
    drawerEl.querySelectorAll('[data-st]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var st = b.getAttribute('data-st');
        if (!state.sel) return;
        post({ action: 'update', id: state.sel, status: st, result: ['done','blocked','void'].indexOf(st) >= 0 ? (st + '（看板手动标记）') : '', by: 'panel', via: 'panel' })
          .then(function () { state.sel = null; drawerEl.className = 'ns-side'; drawerEl.innerHTML = ''; toast('已标记 ' + st); reload(); });
      });
    });
  }

  function bind() {
    panel.querySelectorAll('[data-dd]').forEach(function (dd) {
      var btn = dd.querySelector('.ns-ddbtn');
      if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); dd.classList.toggle('open'); });
      dd.querySelectorAll('[data-wsval]').forEach(function (it) {
        it.addEventListener('click', function (e) {
          e.stopPropagation();
          state.ws = it.getAttribute('data-wsval');
          state.sel = null;
          state.filter = ['todo', 'doing'];
          save();
          dd.classList.remove('open');
          reload();
        });
      });
    });
    panel.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('[data-dd]')) return;
      panel.querySelectorAll('.ns-dd.open').forEach(function (d2) { d2.classList.remove('open'); });
    });
    panel.querySelectorAll('[data-devok]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        post({ action: 'deviation', at: el.getAttribute('data-devok'), status: 'resolved' })
          .then(function () { toast('已标记处理'); reload(); });
      });
    });
    panel.querySelectorAll('[data-act="act-more"]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        state.actShow = Math.min(((state.data && state.data.activity) || []).length, (state.actShow || 30) + 30);
        render();
      });
    });
    panel.querySelectorAll('[data-th]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        state.theme = el.getAttribute('data-th') || 'glass';
        applyTheme();
        panel.querySelectorAll('[data-th]').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-th') === state.theme); });
        save();
      });
    });
    panel.querySelectorAll('[data-tab]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); state.tab = el.getAttribute('data-tab'); save(); render(); }); });
    panel.querySelectorAll('details[data-sec]').forEach(function (dd) { dd.addEventListener('toggle', function () { state.open[dd.getAttribute('data-sec')] = dd.open; if (dd.getAttribute('data-sec') === 'ledger' && !dd.open && state.sel) { state.sel = null; render(); return; } save(); }); });
    panel.querySelectorAll('[data-item]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); var id = el.getAttribute('data-item'); state.sel = state.sel === id ? null : id; render(); }); });
    panel.querySelectorAll('[data-f]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var f = el.getAttribute('data-f');
        if (f === 'all') { state.filter = (state.filter.indexOf('all') >= 0) ? ['todo', 'doing'] : ['all']; }
        else {
          state.filter = state.filter.filter(function (x) { return x !== 'all'; });
          var i = state.filter.indexOf(f);
          if (i >= 0) state.filter.splice(i, 1); else state.filter.push(f);
          if (!state.filter.length) state.filter = ['todo', 'doing'];
        }
        save(); render();
      });
    });
    panel.querySelectorAll('.ns-act-row [data-rename]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var sid = el.getAttribute('data-rename');
        var inp = document.createElement('input');
        inp.className = 'ns-ta';
        inp.style.cssText = 'min-height:24px;width:118px;padding:1px 7px;font-size:11px';
        inp.value = el.textContent;
        el.replaceWith(inp);
        inp.focus(); inp.select();
        var done = false;
        function commit(keep) {
          if (done) return; done = true;
          if (keep) post({ action: 'session-name', session: sid, name: inp.value });
          else render();
        }
        inp.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
          else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
        });
        inp.addEventListener('blur', function () { commit(true); });
      });
    });
    panel.querySelectorAll('[data-red-edit]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = el.getAttribute('data-red-edit');
        var cur = (state.data.redLines || []).filter(function (r) { return r.id === id; })[0];
        var li = el.closest('li');
        var span = li && li.querySelector('span');
        if (!span) return;
        var inp = document.createElement('input');
        inp.className = 'ns-ta';
        inp.value = cur ? cur.text : '';
        span.replaceWith(inp);
        inp.focus(); inp.select();
        var done = false;
        function commit(save) {
          if (done) return; done = true;
          if (save && inp.value.trim()) {
            post({ action: 'redline', op: 'update', id: id, text: inp.value.trim() }).then(function () { toast('红线已更新'); });
          } else { render(); }
        }
        inp.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
          else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
        });
        inp.addEventListener('blur', function () { commit(true); });
      });
    });
    panel.querySelectorAll('[data-red-del]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); var id = el.getAttribute('data-red-del'); if (!confirm('删除红线 ' + id + '？')) return; post({ action: 'redline', op: 'delete', id: id }).then(reload).then(function () { toast('已删除'); }); }); });
    panel.querySelectorAll('[data-st]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); var rowEl = el.closest('.ns-row'); if (rowEl) rowEl.classList.add('out'); var ta = panel.querySelector('#ns-ev'); var _st = el.getAttribute('data-st'); if (state.filter.indexOf('all') < 0 && state.filter.indexOf(_st) < 0) { state.filter.push(_st); save(); } var _res = (_st === 'done' || _st === 'blocked' || _st === 'void') ? ((ta && ta.value.trim()) || ('看板手动标记为 ' + _st)) : undefined; post({ action: 'update', id: state.sel, status: _st, result: _res, evidence: ta ? ta.value : '', _old: el.getAttribute('data-st'), evidence: ta ? ta.value : undefined }).then(reload).then(function () { toast('已更新'); }); }); });
    panel.querySelectorAll('[data-act]').forEach(function (el) {
      var act = el.getAttribute('data-act');
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        if (act === 'toggle') { state.collapsed = !state.collapsed; panel.classList.toggle('ns-collapsed', state.collapsed); save(); render(); }
        else if (act === 'refresh') fetchData(true);
        else if (act === 'goal-edit') { state.editing = true; render(); }
        else if (act === 'goal-cancel') { state.editing = false; render(); }
        else if (act === 'goal-save') { var v = panel.querySelector('#ns-goal-edit'); if (v) post({ action: 'goal', northStar: v.value }).then(function () { state.editing = false; return reload(); }).then(function () { toast('目标已保存'); }); }
        else if (act === 'red-add') { var r = panel.querySelector('#ns-red-in'); if (r && r.value.trim()) post({ action: 'redline', op: 'add', text: r.value.trim() }).then(reload).then(function () { toast('已加红线'); }); }
        else if (act === 'item-close') { state.sel = null; render(); }
        else if (act === 'stash-add') stashAdd();
        else if (act === 'stash-grab') stashGrab();
      });
    });
    panel.querySelectorAll('[data-use]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); var it = state.stash[+el.getAttribute('data-use')]; if (it) fillComposer(it.text); }); });
    panel.querySelectorAll('[data-del]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); state.stash.splice(+el.getAttribute('data-del'), 1); saveStash(); render(); }); });
    var h = panel.querySelector('.ns-head'); if (h) enableDrag(h);
  }

  function stashAdd() { var ta = panel.querySelector('#ns-stash-input'); var t = ta && ta.value ? ta.value.trim() : ''; if (!t) { toast('先写点什么'); return; } state.stash.push({ text: t, at: new Date().toISOString() }); saveStash(); render(); toast('已存入暂存'); }
  function stashGrab() { var t = readComposer(); if (!t) { toast('没找到输入框内容'); return; } state.stash.push({ text: t, at: new Date().toISOString() }); saveStash(); render(); toast('已取当前输入'); }
  function readComposer() { var ta = document.querySelector('textarea'); if (ta && ta.value && ta.value.trim()) return ta.value.trim(); var ce = document.querySelector('[contenteditable="true"]'); if (ce && ce.innerText && ce.innerText.trim()) return ce.innerText.trim(); return ''; }
  function fillComposer(text) {
    var ta = document.querySelector('textarea');
    if (ta) { var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); var l = ta.value.length; ta.setSelectionRange(l, l); toast('已填入输入框'); return; }
    var ce = document.querySelector('[contenteditable="true"]');
    if (ce) { ce.focus(); var sel = window.getSelection(), r = document.createRange(); r.selectNodeContents(ce); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); document.execCommand('insertText', false, text); toast('已填入输入框'); return; }
    try { navigator.clipboard.writeText(text); toast('未找到输入框，已复制'); } catch (e) { toast('未找到输入框'); }
  }

  function enableDrag(handle) {
    var sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    handle.addEventListener('pointerdown', function (e) { if (e.target.closest('button')) return; drag = true; panel.classList.add('ns-dragging'); sx = e.clientX; sy = e.clientY; var r = panel.getBoundingClientRect(); ox = r.left; oy = r.top; handle.setPointerCapture(e.pointerId); });
    handle.addEventListener('pointermove', function (e) { if (!drag) return; var x = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, ox + e.clientX - sx)); var y = Math.max(8, Math.min(window.innerHeight - 60, oy + e.clientY - sy)); panel.style.left = x + 'px'; panel.style.top = y + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; });
    handle.addEventListener('pointerup', function () { if (!drag) return; drag = false; panel.classList.remove('ns-dragging'); var r = panel.getBoundingClientRect(); state.pos = { left: r.left, top: r.top }; save(); });
  }
  function clampIntoView() {
    if (!state.pos) { panel.style.right = panel.style.right || '22px'; return; }
    var r = panel.getBoundingClientRect();
    var maxL = Math.max(8, window.innerWidth - r.width - 8), maxT = Math.max(8, window.innerHeight - 60);
    var l = Math.min(Math.max(8, r.left), maxL), t = Math.min(Math.max(8, r.top), maxT);
    if (l !== r.left || t !== r.top) { state.pos = { left: l, top: t }; panel.style.left = l + 'px'; panel.style.top = t + 'px'; save(); }
  }
  function applyPos() { if (!state.pos) return; panel.style.left = state.pos.left + 'px'; panel.style.top = state.pos.top + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; }

  function fetchData(force) {
    if (state.loading) return; state.loading = true;
    var q = state.ws ? '?ws=' + encodeURIComponent(state.ws) : '';
    fetch('/northstar/api' + q, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.loading = false;
        // 自动按当前项目选台账（仅在用户没手动指定时）
        if (!state.ws && j.workspaces && j.workspaces.length) {
          var hit = detectWs(j.workspaces);
          if (hit && hit !== j.workspace) { state.ws = hit; save(); return fetchData(true); }
        }
        var sig = JSON.stringify([j.workspace, j.counts, j.ledger, j.redLines, j.northStar, j.updatedAt, j.meta]);
        if (!force && sig === state.sig) return;
        var first = !state.data; var wsChanged = (state._ws !== j.workspace); state.sig = sig; state.data = j; state._ws = j.workspace; state.err = null;
        if (first || wsChanged) { loadStash(); state.rev0 = null; }
        render();
      })
      .catch(function () { state.loading = false; if (state.err) return; state.err = 'offline'; render(); });
  }

  window.addEventListener('hashchange', function () { state.sig = ''; fetchData(true); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) fetchData(false); });
  function onResize() { clampIntoView(); }
  window.addEventListener('resize', onResize);
  setInterval(function () {
    if (!state.collapsed) return;
    state.capsIx = ((state.capsIx || 0) + 1);
    render();
  }, 4000);

  function applyTheme() {
    if (!panel) return;
    var th = state.theme || 'glass';
    panel.setAttribute('data-theme', th);
    panel.classList.toggle('ns-dark', th === 'dark');
    panel.classList.toggle('ns-light', th === 'light');
    // 抽屉挂在 root 上（不在 panel 内），主题变量必须单独下发，否则白天主题下抽屉仍是深色
    if (drawerEl) {
      drawerEl.setAttribute('data-theme', th);
      drawerEl.classList.toggle('ns-dark', th === 'dark');
      drawerEl.classList.toggle('ns-light', th === 'light');
    }
  }
  render(); applyPos(); applyTheme(); fetchData(true);
  // 轮询：页面隐藏时完全停；数据指纹没变就不重绘（原来是 1 秒一次全量请求 + 重绘）
  var POLL_MS = 6000;
  function poll() {
    if (document.hidden) return;
    fetchData(false);
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) fetchData(false); });
})();
