/**
 * dsh-northstar v1.1
 *
 * 1) 系统提示词段：每步注入目标 / 红线 / 台账进度 / 三段式要求。
 * 2) northstar_* 工具：读状态、改目标、台账增改、开工闸门、偏离记录。
 * 3) 硬闸门：tools/pre-execute 瀑布拦截变更类工具（write/edit/pwsh/run_code…），
 *    本回合没有通过 northstar_check 的放行凭证就直接 deny —— 这才是“不会偏离”。
 * 4) GUI：宿主 HTTP 路由 /northstar 提供看板页，/northstar/api 提供读写。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'northstar'
export const inject = ['tools', 'systemPrompt', 'webServer']

const DEFAULT_FILE = join(homedir(), '.dsh', 'northstar', 'ledger.json')
const ACT_CAP = 500;        // 每个项目最多留存的活动条数（默认只展示最近 30，可往前翻）
const DEFAULT_ORDER = 10300
const SECTION_NAME = 'deploy:northstar'
const DEFAULT_TTL_MIN = 45;
const SCHEMA_VERSION = 2;   // v2：history / deviation 状态 / activity 环形上限 / 分区归一

const GATED_TOOLS = ['write', 'edit', 'pwsh', 'run_code', 'bash', 'str_replace_editor', 'bash_persistent', 'pwsh_persistent']
const FREE_TOOLS = ['northstar_status', 'northstar_goal', 'northstar_ledger', 'northstar_check', 'northstar_deviate', 'northstar_gui', 'todo_write', 'ask_user_question', 'web_search', 'web_fetch', 'research', 'read', 'read_image', 'glob', 'grep', 'cache_search'];

const DEFAULT_RED_LINES = [
  { id: 'R1', text: '不允许用 SQL / 脚本 / 业务接口造业务单据；业务数据只能由页面录入' },
  { id: 'R2', text: '不允许新建计划文档；要做的事只能登记进台账' },
  { id: 'R3', text: '不允许跳过登录页取证（注入 token / impersonate）' }
];

function nowIso() { return new Date().toISOString(); }
function blankWs() { return { northStar: '', redLines: DEFAULT_RED_LINES.map(r => ({ id: r.id, text: r.text })), ledger: [], deviations: [] }; }

/** v1 → v2 迁移：归一项目 key、补齐 history / deviation 状态 / activity 文案，幂等可重复执行 */
function migrate(data) {
  if (!data || typeof data !== 'object' || !data.workspaces) data = { version: SCHEMA_VERSION, updatedAt: nowIso(), workspaces: {} };
  const src = data.workspaces || {};
  const out = {};
  for (const k of Object.keys(src)) {
    const nk = normKey(k);
    const v = src[k];
    if (!out[nk]) { out[nk] = v; continue; }
    const cur = out[nk];
    if (!cur.northStar && v.northStar) cur.northStar = v.northStar;
    for (const r of (v.redLines || [])) if (!(cur.redLines || []).some(x => x.id === r.id)) (cur.redLines = cur.redLines || []).push(r);
    for (const it of (v.ledger || [])) if (!(cur.ledger || []).some(x => x.id === it.id)) (cur.ledger = cur.ledger || []).push(it);
    cur.activity = ((cur.activity || []).concat(v.activity || [])).sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-ACT_CAP);
  }
  data.workspaces = out;
  for (const k of Object.keys(out)) {
    const ws = out[k];
    if (!Array.isArray(ws.ledger)) ws.ledger = [];
    if (!Array.isArray(ws.redLines)) ws.redLines = [];
    if (typeof ws.northStar !== 'string') ws.northStar = '';
    if (!ws.meta || typeof ws.meta !== 'object') ws.meta = { reads: {} };
    if (!Array.isArray(ws.activity)) ws.activity = [];
    if (!Array.isArray(ws.deviations)) ws.deviations = [];
    ws.deviations.forEach(function (d) { if (!d.status) d.status = 'open'; });
    ws.ledger.forEach(function (it) {
      if (!Array.isArray(it.history)) it.history = [{ at: it.updatedAt || nowIso(), from: '', to: String(it.status || 'todo'), by: '', via: 'migrate' }];
    });
    ws.activity.forEach(function (a) {
      if (a.session === 'ui') a.origin = 'panel';
      if (a.kind === 'ui' || !a.kind) {
        var det = String(a.detail || '');
        a.kind = /^命名会话/.test(det) ? 'session' : /^登记/.test(det) ? 'add'
          : /^(改|新增|删除)红线/.test(det) ? 'redline' : /^(改|修改)目标/.test(det) ? 'goal'
          : /^记录偏离/.test(det) ? 'deviate' : 'update';
      }
      if (!a.text) a.text = actText(a.kind, a.detail);
    });
    if (ws.activity.length > ACT_CAP) ws.activity = ws.activity.slice(-ACT_CAP);
  }
  data.version = SCHEMA_VERSION;
  return data;
}

function load(file) {
  try {
    if (!existsSync(file)) return migrate({ version: SCHEMA_VERSION, updatedAt: nowIso(), workspaces: {} });
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return migrate(data);
  } catch (err) { return migrate({ version: SCHEMA_VERSION, updatedAt: nowIso(), workspaces: {}, _err: String(err && err.message || err) }); }
}
function save(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  data.updatedAt = nowIso();
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}
const DSH_WS_STORE = join(homedir(), '.dsh', 'storages', 'workspace.json');
const DSH_SESS_CACHE = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');

/** 从 DSH 会话缓存取标题（首条消息截断），作为「记录里的用户」 */
function sessionTitleOf(sid) {
  const short = String(sid || '').replace(/^session-/, '');
  if (!short) return '';
  try {
    const j = JSON.parse(readFileSync(join(DSH_SESS_CACHE, short + '.json'), 'utf8'));
    let t = (j && j.record && j.record.rows && j.record.rows.title && j.record.rows.title.val) || '';
    t = String(t).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > 22 ? t.slice(0, 22) + '…' : t;
  } catch (e) { return ''; }
}

/** 会话 id → 所属项目路径：workspace.json 里 sessionIds 反查 */
function wsOfSession(sid) {
  const s = String(sid || '');
  if (!s) return '';
  try {
    const j = JSON.parse(readFileSync(DSH_WS_STORE, 'utf8'));
    const t = (j && j.tables && j.tables.workspaces) || {};
    for (const id of Object.keys(t)) {
      const w = t[id] || {};
      if ((w.sessionIds || []).indexOf(s) >= 0) return String(w.path || '').replace(/\\/g, '/');
    }
  } catch (e) {}
  return '';
}

/** 工具用哪个项目：只认本会话所在项目，杜绝跨项目读写 */
function wsForExec(config, exec) {
  const sid = (exec && exec.agent && exec.agent.id) || '';
  const bySess = wsOfSession(sid);
  if (bySess) return bySess;
  return (config && config.workspace) || process.cwd();
}
function dshWorkspaces() {
  try {
    const j = JSON.parse(readFileSync(DSH_WS_STORE, 'utf8'));
    const t = (j && j.tables && j.tables.workspaces) || {};
    return Object.keys(t).map(function (id) {
      const w = t[id] || {};
      return { key: String(w.path || '').replace(/\\/g, '/'), title: String(w.title || '') };
    }).filter(function (w) { return !!w.key; });
  } catch (e) { return []; }
}
function normKey(k) { return String(k || '').replace(/\\/g, '/').replace(/\/+$/, ''); }
function wsOf(config, explicit) { return normKey(explicit || (config && config.workspace) || process.cwd()); }
function ensureWs(data, key) {
  key = normKey(key);
  if (!data.workspaces[key]) {
    // 迁移旧的同项目不同分隔符分区
    const alt = Object.keys(data.workspaces).filter(function (k2) { return normKey(k2) === key && k2 !== key; });
    for (const a2 of alt) {
      const old2 = data.workspaces[a2];
      if (!data.workspaces[key]) data.workspaces[key] = old2;
      else {
        const cur = data.workspaces[key];
        if (!cur.northStar && old2.northStar) cur.northStar = old2.northStar;
        for (const r2 of (old2.redLines || [])) if (!cur.redLines.some(x => x.id === r2.id)) cur.redLines.push(r2);
        for (const it2 of (old2.ledger || [])) if (!cur.ledger.some(x => x.id === it2.id)) cur.ledger.push(it2);
        cur.activity = (cur.activity || []).concat(old2.activity || []).slice(-30);
      }
      delete data.workspaces[a2];
    }
    data.workspaces[key] = data.workspaces[key] || blankWs();
  }
  const ws = data.workspaces[key];
  if (!Array.isArray(ws.ledger)) ws.ledger = [];
  if (!Array.isArray(ws.deviations)) ws.deviations = [];
  if (!Array.isArray(ws.redLines)) ws.redLines = [];
  if (typeof ws.northStar !== 'string') ws.northStar = '';
  if (!ws.meta || typeof ws.meta !== 'object') ws.meta = { reads: {} };
  if (!ws.meta.reads || typeof ws.meta.reads !== 'object') ws.meta.reads = {};
  if (!ws.meta.rev || typeof ws.meta.rev !== 'number') ws.meta.rev = 0;   // 单调递增计数，代替会漂的机器时间
  if (!Array.isArray(ws.activity)) ws.activity = [];
  if (!ws.sessionNames || typeof ws.sessionNames !== 'object') ws.sessionNames = {};
  return ws;
}
var ACT_TEXT = {
  read: function () { return '读取台账（目标·红线·进度）'; },
  check: function (d) { return d && d !== '开工闸门校验' ? '开工校验：' + d : '开工校验'; },
  update: function (d) { return '回写台账 ' + d; },
  add: function (d) { return '登记台账 ' + d; },
  goal: function (d) { return d || '修改目标'; },
  redline: function (d) { return d || '修改红线'; },
  deviate: function (d) { return '记录偏离 ' + d; }
};
/** 活动文案唯一出处：悬浮窗与 /northstar 看板都用它，避免两处不一致 */
function actText(kind, detail) {
  var k = String(kind || ''), d = String(detail || '');
  var f = ACT_TEXT[k];
  if (f) return f(d);
  return d || k;
}
function logAct(ws, kind, detail, sessionId, exec) {
  if (!Array.isArray(ws.activity)) ws.activity = [];
  var sid = String(sessionId || '').replace(/^session-/, '');
  var short = sid ? sid.slice(0, 8) : 'agent';
  var nm = '';
  var depth = 0;
  try { nm = (exec && exec.agent && (exec.agent.title || exec.agent.name || exec.agent.label)) || ''; depth = Number((exec && exec.agent && exec.agent.delegationDepth) || 0) || 0; } catch (e) {}
  if (!nm) nm = sessionTitleOf(sid);
  if (nm && !ws.sessionNames) ws.sessionNames = {};
  if (nm) ws.sessionNames[short] = nm;
  const isSub = depth > 0;
  ws.activity.push({ at: nowIso(), kind: kind, detail: String(detail || '').slice(0, 80), text: actText(kind, detail), session: short, name: nm || (ws.sessionNames && ws.sessionNames[short]) || '', origin: (sessionId === 'ui' ? 'panel' : 'tool'), sub: isSub, depth: depth });
  ws.meta = ws.meta || {};
  ws.meta.rev = (ws.meta.rev || 0) + 1;
  if (ws.activity.length > ACT_CAP) ws.activity = ws.activity.slice(-ACT_CAP);
}
function countsOf(ws) {
  const c = { total: ws.ledger.length, todo: 0, doing: 0, done: 0, blocked: 0, void: 0 };
  for (const it of ws.ledger) { const s = String(it.status || 'todo'); c[s] = (c[s] || 0) + 1; }
  return c;
}

function applyOp(data, key, op) {
  const ws = ensureWs(data, key);
  const a = String(op.action || '');
  if (a === 'goal') {
    if (typeof op.northStar === 'string') { ws.northStar = op.northStar; logAct(ws, 'goal', '修改目标', 'ui'); }
    if (op.resetRedLines === true) ws.redLines = DEFAULT_RED_LINES.map(r => ({ id: r.id, text: r.text }));
    if (typeof op.addRedLine === 'string' && op.addRedLine.trim()) {
      const raw = op.addRedLine.trim();
      logAct(ws, 'redline', '新增红线 ' + raw, 'ui');
      const m = raw.match(/^(R[0-9]+)\s*[:：]\s*(.+)$/);
      ws.redLines.push({ id: m ? m[1] : 'R' + (ws.redLines.length + 1), text: m ? m[2] : raw });
    }
    return { ok: true };
  }
  if (a === 'add') {
    const title = String(op.title || '').trim();
    const source = String(op.source || '').trim();
    const detail = String(op.detail || '').trim();
    const st0 = String(op.status || '').trim();
    if (!title) return { ok: false, error: '登记台账必须填写 title（任务名）' };
    if (!source) return { ok: false, error: '登记台账必须填写 source（任务来源，如：用户指令/计划批次/评审意见）' };
    if (!st0) return { ok: false, error: '登记台账必须填写 status（todo/doing/blocked）' };
    if (!detail) return { ok: false, error: '登记台账必须填写 detail（任务详情：要做什么、验收标准）' };
    const id = String(op.id || '').trim() || ('T' + (ws.ledger.length + 1));
    if (ws.ledger.some(x => x.id === id)) return { ok: false, error: '已存在 ' + id };
    ws.ledger.push({ id: id, title: title, status: st0, source: source, detail: detail, evidence: op.evidence || '', note: op.note || '', result: '', updatedAt: nowIso(), history: [{ at: nowIso(), from: '', to: st0, by: String(op.by || ''), via: 'add' }] });
    logAct(ws, 'add', String(id) + '（' + String(st0) + '）', 'ui');
    return { ok: true, id: id };
  }
  if (a === 'update') {
    const it = ws.ledger.find(x => x.id === String(op.id || ''));
    if (!it) return { ok: false, error: '未找到 ' + op.id };
    const closing = ['done', 'blocked', 'void'].indexOf(String(op.status)) >= 0;
    if (closing && !String(op.result || '').trim()) return { ok: false, error: '收尾回写（status=' + op.status + '）必须填写 result（任务结果备注：做完了什么/卡在哪/证据链接）' };
    if (typeof op.result === 'string') it.result = op.result;
    if (typeof op.source === 'string' && op.source) it.source = op.source;
    if (typeof op.detail === 'string' && op.detail) it.detail = op.detail;
    const from0 = String(it.status || 'todo');
    const to0 = String(op.status || from0);
    if (!Array.isArray(it.history)) it.history = [];
    if (from0 !== to0 || typeof op.result === 'string') {
      it.history.push({ at: nowIso(), from: from0, to: to0, by: String(op.by || ''), via: String(op.via || 'update'), result: typeof op.result === 'string' ? String(op.result).slice(0, 200) : '' });
      if (it.history.length > 50) it.history = it.history.slice(-50);
    }
    logAct(ws, 'update', String(op.id) + ' → ' + String(to0), 'ui');
    it.status = to0;
    if (typeof op.evidence === 'string') it.evidence = op.evidence;
    if (typeof op.note === 'string') it.note = op.note;
    if (typeof op.title === 'string' && op.title.trim()) it.title = op.title.trim();
    it.updatedAt = nowIso();
    return { ok: true, id: it.id, status: it.status };
  }
  if (a === 'delete') {
    const n = ws.ledger.length;
    ws.ledger = ws.ledger.filter(x => x.id !== String(op.id || ''));
    return { ok: ws.ledger.length < n };
  }
  if (a === 'deviate') {
    const rec = { at: nowIso(), what: String(op.what || ''), redLine: String(op.redLine || ''), id: String(op.id || ''), status: 'open', by: String(op.by || '') };
    ws.deviations.push(rec);
    logAct(ws, 'deviate', String(op.redLine || '-') + ' ' + String(op.what || ''), 'ui');
    if (rec.id) { const it = ws.ledger.find(x => x.id === rec.id); if (it) { it.status = 'void'; it.note = '因偏离作废：' + rec.what; it.updatedAt = nowIso(); } }
    return { ok: true };
  }
  if (a === 'deviation') {
    const rec = ws.deviations.find(function (x) { return String(x.at) === String(op.at) || (op.what && x.what === op.what && x.status !== 'resolved'); });
    if (!rec) return { ok: false, error: '未找到该偏离记录' };
    rec.status = String(op.status || 'resolved');
    rec.resolvedAt = rec.status === 'resolved' ? nowIso() : '';
    logAct(ws, 'deviate', (rec.status === 'resolved' ? '标记偏离已处理：' : '重开偏离：') + String(rec.what || '').slice(0, 40), 'ui');
    return { ok: true, status: rec.status };
  }
  if (a === 'session-name') {
    const sid = String(op.session || '').trim();
    const nm = String(op.name || '').trim();
    if (!sid) return { ok: false, error: '缺少 session' };
    const w2 = ensureWs(data, String(op.workspace || key));
    w2.sessionNames[sid] = nm.slice(0, 24);
    logAct(w2, 'session', '命名会话 ' + sid + ' → ' + (nm || '（恢复短ID）'), 'ui');
    save(file, data);
    return { ok: true, session: sid, name: w2.sessionNames[sid] };
  }
  if (a === 'redline') {
    const op2 = String(op.op || 'add');
    if (op2 === 'add') { const rid = String(op.id || ('R' + (ws.redLines.length + 1))); ws.redLines.push({ id: rid, text: String(op.text || '') }); logAct(ws, 'redline', '新增红线 ' + rid, 'ui'); return { ok: true }; }
    if (op2 === 'update') { const r = ws.redLines.find(x => x.id === String(op.id)); if (!r) return { ok: false, error: '无此红线' }; const old0 = r.text; r.text = String(op.text || ''); logAct(ws, 'redline', '修改红线 ' + String(op.id), 'ui'); return { ok: true, old: old0 }; }
    if (op2 === 'delete') { ws.redLines = ws.redLines.filter(x => x.id !== String(op.id)); logAct(ws, 'redline', '删除红线 ' + String(op.id), 'ui'); return { ok: true }; }
    return { ok: false, error: 'unknown redline op' };
  }
  if (a === 'read') {
    const sid = String(op.sessionId || 'default');
    ws.meta.reads[sid] = nowIso();
    ws.meta.lastReadAt = nowIso();
    return { ok: true, sessionId: sid };
  }
  return { ok: false, error: '未知 action ' + a };
}

function renderSection(config) {
  const data = load(config.file || DEFAULT_FILE);
  const ws = ensureWs(data, wsOf(config));
  const c = countsOf(ws);
  const head = '台账 ' + c.done + '/' + c.total + ' 完成（doing ' + c.doing + '，blocked ' + c.blocked + '）';
  const items = ws.ledger.slice(0, 14).map(it => it.id + ' ' + (it.title || '') + '[' + (it.status || 'todo') + ']' + (it.evidence ? ' ' + it.evidence : ''));
  const L2 = [];
  L2.push('## 北极星台账（northstar · 强制约束）');
  L2.push('');
  L2.push('**目标**：' + (ws.northStar || '（未设置，调用 northstar_goal 设置）'));
  L2.push('');
  L2.push('**红线**：' + (ws.redLines.length ? ws.redLines.map(r => r.id + ' ' + r.text).join('；') : '（空）'));
  L2.push('');
  L2.push('**进度**：' + head + (items.length ? '：' + items.join('；') : '（空，先登记）'));
  if (ws.deviations.length) {
    L2.push('');
    L2.push('**最近偏离**：' + ws.deviations.slice(-3).map(d => (d.redLine || '-') + ' ' + d.what).join('；'));
  }
  L2.push('');
  L2.push('**工作口径（先读后做，收工回填）**：');
  L2.push('【开局硬性动作】会话开始后先调用 northstar_status，读出未完成台账（doing 优先、其次 todo），复述本次做哪一项再动手；用户没有新指令时默认续做 doing 第一项。');
  L2.push('1. 开工前先 northstar_status 读一遍目标与台账，确认本次任务对应哪一项；不在台账就先 northstar_ledger action=add 登记。');
  L2.push('2. 登记（add）必填：title + source（来源）+ status + detail（详情/验收标准）；收工回写（status=done/blocked/void）必填 result（结果备注）。缺字段会被拒绝。');
  L2.push('3. 每轮回复三段：① 本轮对应台账哪一项 ② 产出与证据 ③ 自检（R1/R2/R3 是否触发、台账是否已更新）。');
  L2.push('4. 偏离立即 northstar_deviate 记录；用户说「回计划」就停手复述台账。');
  L2.push('5. 看板：' + (config.guiUrl || 'http://127.0.0.1:<port>/northstar'));
  return L2.join('\n');
}

function guiHtml() {
  const h = [];
  h.push('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">');
  h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  h.push('<title>北极星台账</title><style>');
  h.push(':root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a7;--ok:#3fb950;--do:#d29922;--bad:#f85149;--todo:#6e7681}');
  h.push('*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,Segoe UI,Microsoft YaHei,sans-serif}');
  h.push('.wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}');
  h.push('h1{font-size:20px;margin:0 0 4px}.sub{color:var(--dim);font-size:12px;margin-bottom:20px}');
  h.push('.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}');
  h.push('.bar{height:8px;background:#222632;border-radius:6px;overflow:hidden;margin:10px 0}');
  h.push('.bar>i{display:block;height:100%;background:linear-gradient(90deg,#3fb950,#56d364)}');
  h.push('table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}');
  h.push('th{color:var(--dim);font-weight:500;font-size:12px}');
  h.push('.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid}');
  h.push('.done{color:var(--ok);border-color:var(--ok)}.doing{color:var(--do);border-color:var(--do)}');
  h.push('.blocked{color:var(--bad);border-color:var(--bad)}.todo{color:var(--todo);border-color:var(--todo)}.void{color:#888;border-color:#444;text-decoration:line-through}');
  h.push('input,select,textarea,button{font:inherit;background:#0d1016;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 9px}');
  h.push('button{cursor:pointer}button:hover{border-color:#4b5568}');
  h.push('.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}');
  h.push('.muted{color:var(--dim);font-size:12px}.tag{color:var(--dim);margin-right:6px}');
  h.push('</style></head><body><div class="wrap">');
  h.push('<h1>北极星台账</h1><div class="sub" id="sub">加载中…</div>');
  h.push('<div class="card"><div class="row" style="justify-content:space-between"><b>目标</b><span class="muted" id="pct"></span></div>');
  h.push('<div id="goal" style="margin:8px 0"></div><div class="bar"><i id="bar" style="width:0"></i></div>');
  h.push('<div class="row"><input id="goalInput" style="flex:1;min-width:320px" placeholder="修改目标">');
  h.push('<button onclick="saveGoal()">保存目标</button></div></div>');
  h.push('<div class="card"><b>红线</b><ul id="redlines" style="margin:8px 0 0 18px;padding:0"></ul>');
  h.push('<div class="row" style="margin-top:10px"><input id="redInput" style="flex:1" placeholder="新增红线，如 R4:不许改产品代码只为截图好看"><button onclick="addRed()">加红线</button></div></div>');
  h.push('<div class="card"><div class="row" style="justify-content:space-between"><b>台账</b><span class="muted" id="stat"></span></div>');
  h.push('<table><thead><tr><th style="width:70px">ID</th><th>任务</th><th style="width:90px">状态</th><th>证据</th><th style="width:150px">操作</th></tr></thead><tbody id="rows"></tbody></table>');
  h.push('<div class="row" style="margin-top:12px"><input id="newId" style="width:90px" placeholder="ID"><input id="newTitle" style="flex:1" placeholder="新任务标题"><button onclick="addItem()">登记</button></div></div>');
  h.push('<div class="card"><b>活动记录</b><ul id="acts" style="margin:8px 0 0 18px;padding:0"></ul></div>');
h.push('<div class="card"><b>偏离记录</b><ul id="devs" style="margin:8px 0 0 18px;padding:0"></ul>');
  h.push('<div class="row" style="margin-top:10px"><input id="devWhat" style="flex:1" placeholder="偏离了什么"><input id="devRed" style="width:80px" placeholder="R1"><button onclick="addDev()">记录偏离</button></div></div>');
  h.push('</div><script>');
  h.push('let D=null;');
  h.push('function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]})}');
  h.push('function api(body){return fetch("/northstar/api",{method:body?"POST":"GET",headers:{"content-type":"application/json"},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json()}).then(function(j){D=j;render();return j})}');
  h.push('function render(){');
  h.push('  var c=D.counts||{};');
  h.push('  document.getElementById("sub").textContent="工作区 "+(D.workspace||"")+" · 更新 "+(D.updatedAt||"")+" · 强制模式 "+(D.enforce||"block");');
  h.push('  document.getElementById("goal").textContent=D.northStar||"（未设置）";');
  h.push('  document.getElementById("goalInput").value=D.northStar||"";');
  h.push('  var pct=c.total?Math.round((c.done||0)*100/c.total):0;');
  h.push('  document.getElementById("bar").style.width=pct+"%";');
  h.push('  document.getElementById("pct").textContent="完成 "+(c.done||0)+"/"+(c.total||0)+"（"+pct+"%）";');
  h.push('  document.getElementById("stat").textContent="进行 "+(c.doing||0)+" · 阻塞 "+(c.blocked||0)+" · 作废 "+(c.void||0);');
  h.push('  document.getElementById("redlines").innerHTML=(D.redLines||[]).map(function(r){return "<li><b>"+esc(r.id)+"</b> "+esc(r.text)+"</li>"}).join("");');
  h.push('  document.getElementById("rows").innerHTML=(D.ledger||[]).map(function(it){');
  h.push('    var s=it.status||"todo";');
  h.push('    return "<tr><td>"+esc(it.id)+"</td><td>"+esc(it.title)+"</td><td><span class=\"pill "+s+"\">"+s+"</span></td><td class=\"muted\">"+esc(it.evidence)+"</td>"+');
  h.push('      "<td><button onclick=\"setStatus(\x27"+esc(it.id)+"\x27,\x27doing\x27)\">进行</button> <button onclick=\"setStatus(\x27"+esc(it.id)+"\x27,\x27done\x27)\">完成</button></td></tr>"');
  h.push('  }).join("");');
  h.push('  document.getElementById("acts").innerHTML=(D.activity||[]).slice().reverse().map(function(a){var w=(a.origin==="panel"||a.session==="ui")?"本机用户·面板":((D.sessionTitles||{})[a.session]||("DSH 会话 "+(a.session||"").slice(0,6)));return "<li><span class=muted>"+esc(a.at.slice(11,16))+"</span> <b>"+esc(w)+"</b> "+esc(a.text||a.detail||a.kind)+"</li>"}).join("")||"<li class=muted>暂无</li>";');
h.push('  document.getElementById("devs").innerHTML=(D.deviations||[]).map(function(d){return "<li>"+esc(d.at)+" <b>"+esc(d.redLine||"-")+"</b> "+esc(d.what)+"</li>"}).join("")||"<li class=muted>暂无</li>";');
  h.push('}');
  h.push('function saveGoal(){api({action:"goal",northStar:document.getElementById("goalInput").value})}');
  h.push('function addRed(){var v=document.getElementById("redInput").value;if(v){api({action:"goal",addRedLine:v});document.getElementById("redInput").value=""}}');
  h.push('function addItem(){var i=document.getElementById("newId").value,t=document.getElementById("newTitle").value;if(t){api({action:"add",id:i,title:t});document.getElementById("newId").value="";document.getElementById("newTitle").value=""}}');
  h.push('function setStatus(id,s){api({action:"update",id:id,status:s})}');
  h.push('function addDev(){var w=document.getElementById("devWhat").value,r=document.getElementById("devRed").value;if(w){api({action:"deviate",what:w,redLine:r})}}');
  h.push('api();');
  h.push('</script></body></html>');
  return h.join('');
}

function readBody(req) {
  return new Promise(function (resolve) {
    let buf = '';
    req.on('data', function (c) { buf += c; });
    req.on('end', function () { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); } });
  });
}

export function apply(ctx, config) {
  config = config || {};
  const file = config.file || DEFAULT_FILE;
  const order = typeof config.order === 'number' ? config.order : DEFAULT_ORDER;
  const logger = ctx.logger || console;
  const enforce = 'off';
  const ttlMs = (typeof config.grantMinutes === 'number' ? config.grantMinutes : DEFAULT_TTL_MIN) * 60000;
  const GRANTS_FILE = join(homedir(), '.dsh', 'northstar', 'grants.json');
  const grants = new Map();
  (function restoreGrants() {
    try {
      const j = JSON.parse(readFileSync(GRANTS_FILE, 'utf8') || '{}');
      const now = Date.now();
      for (const k of Object.keys(j)) { const g = j[k]; if (g && g.at && now - g.at < (g.ttl || DEFAULT_TTL_MIN * 60000)) grants.set(k, g); }
    } catch (e) {}
  })();
  function persistGrants() {
    try {
      mkdirSync(dirname(GRANTS_FILE), { recursive: true });
      const o = {}; const now = Date.now();
      grants.forEach(function (v, k) { if (v && v.at && now - v.at < (v.ttl || DEFAULT_TTL_MIN * 60000)) o[k] = v; });
      writeFileSync(GRANTS_FILE, JSON.stringify(o, null, 2), 'utf8');
    } catch (e) {}
  }

  const registerSection = function () {
    ctx.systemPrompt.section({ name: SECTION_NAME, order: order, text: function () { return renderSection(config); } });
  };
  if (typeof ctx.effect === 'function') ctx.effect(registerSection, 'dsh-northstar: prompt section');
  else registerSection();

  // v1.2：硬闸门已取消（读—做—更口径）；enforce 仅为兼容旧字段保留，不再拦截。

  // ---- GUI ----
  let guiUrl = '';
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const port = ctx.webServer.port;
    guiUrl = 'http://127.0.0.1:' + port + '/northstar';
    config.guiUrl = guiUrl;
    try {
      const once = !globalThis.__nsRoutes;
      globalThis.__nsRoutes = true;
      const d1 = !once ? function () {} : ctx.webServer.register({ kind: 'exact', path: '/northstar', handler: function (req, res) {
        const html = guiHtml();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      } });
      const d2 = !once ? function () {} : ctx.webServer.register({ kind: 'exact', path: '/northstar/api', handler: async function (req, res) {
        const data = load(file);
        const u = new URL(req.url || '/', 'http://local');
        const wantSess = u.searchParams.get('session') || '';
        const key = wsOfSession(wantSess) || wsOf(config, u.searchParams.get('ws') || undefined);
        try {
          if (req.method === 'POST') {
            const body = await readBody(req);
            const r = applyOp(data, wsOf(config, body.workspace), body);
            if (!r.ok) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); return; }
            save(file, data);
          }
          const ws = ensureWs(data, key);
          const seen = {};
          const all = [];
          const pushWs = function (k2, title2) {
            const norm = String(k2 || '').replace(/\\/g, '/');
            if (!norm || seen[norm]) return;
            seen[norm] = 1;
            const w = ensureWs(data, norm);
            all.push({ key: norm, title: title2 || '', northStar: w.northStar, counts: countsOf(w), registered: (w.ledger || []).length > 0 });
          };
          const dshList = dshWorkspaces();
          for (const dw of dshList) pushWs(dw.key, dw.title);
          for (const k2 of Object.keys(data.workspaces || {})) pushWs(k2, '');
          if (config && config.workspace) pushWs(config.workspace, '');
          all.sort(function (a, b) { return (a.registered === b.registered) ? String(a.key).localeCompare(String(b.key)) : (a.registered ? -1 : 1); });
          (ws.activity || []).forEach(function (a) {
        if (a.session === 'ui') a.origin = 'panel';
        if (a.kind === 'ui' || !a.kind) {
          var det = String(a.detail || '');
          if (/^命名会话/.test(det)) a.kind = 'session';
          else if (/^登记/.test(det)) a.kind = 'add';
          else if (/^改红线|^新增红线|^删除红线/.test(det)) a.kind = 'redline';
          else if (/^改目标|^修改目标/.test(det)) a.kind = 'goal';
          else if (/^记录偏离/.test(det)) a.kind = 'deviate';
          else if (/→/.test(det)) a.kind = 'update';
          else a.kind = 'update';
        }
        if (!a.text) a.text = actText(a.kind, a.detail);
      });
      const sessTitles = {};
      (ws.activity || []).forEach(function (a) { if (a.session && a.session !== 'ui' && !sessTitles[a.session]) sessTitles[a.session] = sessionTitleOf(a.session); });
      const out = { workspace: key, workspaces: all, updatedAt: data.updatedAt, enforce: enforce, guiUrl: guiUrl, northStar: ws.northStar, redLines: ws.redLines, counts: countsOf(ws), ledger: ws.ledger, deviations: ws.deviations.slice(-60), meta: ws.meta, activity: (ws.activity || []).slice(-ACT_CAP), sessionNames: ws.sessionNames || {}, sessionTitles: sessTitles };
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
        }
      } });
      // ---- 悬浮窗资源 ----
      const here = dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
      const readAsset = function (name) { try { return readFileSync(join(here, name), 'utf8'); } catch (e) { return ''; } };
      const CSS = readAsset('overlay.css');
      const JS = readAsset('overlay.js');
      const serve = function (path, type, body) {
        if (!once) return function () {};
        return ctx.webServer.register({ kind: 'exact', path: path, handler: function (req, res) {
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
          res.end(body);
        } });
      };
      const d3 = serve('/northstar/overlay.css', 'text/css; charset=utf-8', CSS);
      const d4 = serve('/northstar/overlay.js', 'application/javascript; charset=utf-8', JS);
      // 注入到 DSH Web 的 index.html：样式进 head，脚本进 body 末尾
      if (typeof ctx.on === 'function') {
        if (once) ctx.on('webserver/index-inject', function (table) {
          if (CSS) table.push({ kind: 'style', text: CSS });
          if (JS) table.push({ kind: 'script-src', placement: 'body', src: '/northstar/overlay.js' });
        });
      }
      if (typeof ctx.effect === 'function') ctx.effect(function () { return function () { try { d1(); d2(); } catch (e) {} }; }, 'dsh-northstar: gui routes');
      if (typeof ctx.effect === 'function') ctx.effect(function () { return function () { try { d3(); d4(); } catch (e) {} }; }, 'dsh-northstar: overlay assets');
      logger.info('[northstar] 悬浮窗资源已挂载：/northstar/overlay.js + /northstar/overlay.css');
      logger.info('[northstar] GUI: ' + guiUrl);
    } catch (err) { logger.error('[northstar] GUI 路由注册失败：' + String(err && err.message || err)); }
  }

  const text = function (s) { return [{ type: 'text', text: s }]; };
  const out = function (s) { return { schema: { type: 'string' }, render: function (a, v) { return text(String(v)); } }; };

  async function defineTools() {
    let defineTool = null;
    try { const m = await import('@deepseek-ai/dsh-tools'); if (m && typeof m.defineTool === 'function') defineTool = m.defineTool; } catch (e) {}
    const mk = function (def) { return defineTool ? defineTool(def) : { name: def.name, description: def.description, parameters: def.parameters, output: out(''), execute: def.execute }; };
    const reg = function (def) { return ctx.tools.register(mk(def)); };

    reg({ name: 'northstar_status', description: '读取北极星：目标、红线、台账进度与最近偏离（含 GUI 地址）。只读本会话所属项目。', parameters: {}, output: out(''), async execute(args, exec) {
      const data = load(file); const key = wsForExec(config, exec); const ws = ensureWs(data, key);
      ws.meta.lastToolReadAt = nowIso(); ws.meta.lastToolReadBy = (exec && exec.agent && exec.agent.id) || 'agent'; ws.meta.lastToolReadRev = (ws.meta.rev || 0) + 1;
      logAct(ws, 'read', '', exec && exec.agent && exec.agent.id, exec);
      save(file, data);
      return JSON.stringify({ workspace: key, guiUrl: guiUrl, enforce: enforce, version: data.version, northStar: ws.northStar, redLines: ws.redLines, counts: countsOf(ws), ledger: ws.ledger, deviations: ws.deviations.slice(-10), deviationsOpen: (ws.deviations || []).filter(function (x) { return x.status !== 'resolved'; }).length, activity: (ws.activity || []).length, meta: ws.meta }, null, 2);
    } });

    reg({ name: 'northstar_goal', description: '设置目标 / 加红线 / 恢复默认红线。只改本会话所属项目。', parameters: { northStar: { type: 'string' }, addRedLine: { type: 'string' }, resetRedLines: { type: 'boolean' } }, output: out(''), async execute(args) {
      const data = load(file); const r = applyOp(data, wsForExec(config, exec), { action: 'goal', northStar: args.northStar, addRedLine: args.addRedLine, resetRedLines: args.resetRedLines });
      save(file, data); return r.ok ? 'ok 目标/红线已更新' : ('ERROR: ' + r.error);
    } });

    reg({ name: 'northstar_ledger', description: '台账：add 登记 / update 回填状态与证据 / list 列出。', parameters: { action: { type: 'string', required: true }, id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, source: { type: 'string', description: '任务来源（add 必填）' }, detail: { type: 'string', description: '任务详情/验收标准（add 必填）' }, result: { type: 'string', description: '任务结果备注（status=done/blocked/void 必填）' }, evidence: { type: 'string' }, note: { type: 'string' } }, output: out(''), async execute(args, exec) {
      const data = load(file); const key = wsForExec(config, exec);
      if (args.action === 'list') { const ws = ensureWs(data, key); return JSON.stringify({ counts: countsOf(ws), ledger: ws.ledger }, null, 2); }
      const r = applyOp(data, key, args);
      if (!r.ok) return 'ERROR: ' + r.error;
      save(file, data);
      const agentId = (exec && exec.agent && exec.agent.id) || 'anon';
      const wsUpd = ensureWs(data, key);
      logAct(wsUpd, args.action === 'add' ? 'add' : 'update', (args.id || '') + (args.status ? ' → ' + args.status : ''), agentId, exec);
      if (args.action === 'update' && ['done', 'blocked', 'void'].indexOf(String(args.status)) >= 0) { grants.delete(agentId); persistGrants(); }
      return 'ok ' + args.action + (r.id ? ' ' + r.id : '') + (r.status ? ' -> ' + r.status : '');
    } });

    reg({ name: 'northstar_check', description: '开工闸门：任务在台账里且未作废才返回 allowed，并发放本回合的写操作放行凭证。只校验本会话所属项目。', parameters: { task: { type: 'string', required: true }, id: { type: 'string' } }, output: out(''), async execute(args, exec) {
      const data = load(file); const ws = ensureWs(data, wsForExec(config, exec));
      ws.meta.lastToolReadAt = nowIso();
      ws.meta.lastToolReadRev = (ws.meta.rev || 0) + 1; ws.meta.lastToolReadBy = (exec && exec.agent && exec.agent.id) || 'agent';
      logAct(ws, 'check', String((args && (args.id || args.task)) || ''), exec && exec.agent && exec.agent.id, exec);
      save(file, data);
      const want = (args && args.id) || ''; const task = String((args && args.task) || '');
      let hit = want ? ws.ledger.find(function (x) { return x.id === want; }) : null;
      if (!hit && task) hit = ws.ledger.find(function (x) { return task.indexOf(x.id) >= 0 || (x.title && task.indexOf(x.title) >= 0); });
      const tmpl = '回复三段：① 本轮对应 <台账项> ② 产出与证据 ③ 自检 R1/R2/R3 | 台账已更新';
      if (!hit) return JSON.stringify({ verdict: 'blocked', reason: '台账里没有对应任务', next: '先 northstar_ledger action=add 登记，再开工；或问用户这属于哪一项', template: tmpl }, null, 2);
      if (hit.status === 'void') return JSON.stringify({ verdict: 'blocked', reason: '该台账项已作废', item: hit }, null, 2);
      const agentId = (exec && exec.agent && exec.agent.id) || 'anon';
      grants.set(agentId, { at: Date.now(), id: hit.id, ttl: ttlMs, task: String(task).slice(0, 120) });
      persistGrants();
      return JSON.stringify({ verdict: 'allowed', item: hit, grantMinutes: Math.round(ttlMs / 60000), template: tmpl }, null, 2);
    } });

    reg({ name: 'northstar_deviate', description: '记录偏离（可把相关台账项置为作废）。只写本会话所属项目。', parameters: { what: { type: 'string', required: true }, redLine: { type: 'string' }, id: { type: 'string' } }, output: out(''), async execute(args) {
      const data = load(file); const r = applyOp(data, wsForExec(config, exec), { action: 'deviate', what: args.what, redLine: args.redLine, id: args.id });
      save(file, data); return r.ok ? ('ok 已记录 ' + (args.redLine || '-') + ' ' + args.what) : ('ERROR: ' + r.error);
    } });

    reg({ name: 'northstar_gui', description: '返回北极星看板地址（浏览器打开可查看/修改台账）。', parameters: {}, output: out(''), async execute() {
      return guiUrl || 'GUI 未启用（webServer 服务不可用）';
    } });
  }

  defineTools().catch(function (err) { logger.error('[northstar] 工具注册失败：' + String(err && err.message || err)); });
}
