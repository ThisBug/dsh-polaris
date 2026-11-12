'use strict';
/* run6：工具契约回归 —— 每个工具都必须能调用成功，且校验/越权行为符合预期
   做法：把 index.js 的工具注册段抽出来执行，用假 ctx 捕获 def，再直接调 execute(args, fakeExec)。 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname, LIB = path.join(DIR, '..', 'lib');
const SRC = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');

// 抽出 applyOp / ensureWs / logAct / actText / countsOf / normKey / wsOf / migrate / load / save 等纯函数
const cutStart = SRC.indexOf('const DEFAULT_FILE');
const cutEnd = SRC.indexOf('export function apply(ctx, config)');
const body = SRC.slice(cutStart, cutEnd)
  .replace(/const DEFAULT_FILE = \$\([^;]*;/g, 'const DEFAULT_FILE = process.env.NS_TEST_FILE;')
  .replace(/const DSH_WS_STORE = \$\([^;]*;/g, 'const DSH_WS_STORE = "";')
  .replace(/const DSH_SESS_CACHE = \$\([^;]*;/g, 'const DSH_SESS_CACHE = "";');

const HEAD = `const { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } = require('node:fs');\n`
  + `const { dirname, join } = require('node:path');\n`
  + `const { homedir } = require('node:os');\n`
  + `const FILE = process.env.NS_TEST_FILE;\n`
  + `const CONFIG = { file: FILE, workspace: 'D:/Work/demo', grantMinutes: 45 };\n`;

const mod = { exports: {} };
const fn = new Function('module', 'exports', 'require', '__filename', '__dirname',
  HEAD + body + '\nmodule.exports = { load, save, applyOp, ensureWs, countsOf, normKey, wsOf, wsForExec, migrate, actText, renderSection, DEFAULT_TTL_MIN, SCHEMA_VERSION, ACT_CAP };');
fn(mod, mod.exports, require, path.join(LIB, 'index.js'), LIB);
const M = mod.exports;

// ---- 测试 ----
const CONFIG = { file: process.env.NS_TEST_FILE, workspace: 'D:/Work/demo', grantMinutes: 45 };
const out = { checks: [], errors: [] };
const T = path.join(DIR, 'tmp-run6.json');
const seed = () => {
  fs.writeFileSync(T, JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), workspaces: {
    'D:/Work/demo': { northStar: '演示目标', redLines: [{ id: 'R1', text: '不许脚本造数' }], ledger: [
      { id: 'P01', title: '环境准备', status: 'todo', source: '演示', detail: '详情', result: '', evidence: '', history: [] }
    ], deviations: [], activity: [], sessionNames: {}, meta: { reads: {}, rev: 0 } }
  } }), 'utf8');
};
const ok = (name, cond, extra) => out.checks.push({ name, pass: !!cond, extra: extra || '' });

// 1) add 四字段必填
seed();
let r = M.applyOp(M.load(T), 'D:/Work/demo', { action: 'add', title: 'X' });
ok('add 缺 source 被拒', !r.ok && /source/.test(r.error), r.error);
seed();
r = M.applyOp(M.load(T), 'D:/Work/demo', { action: 'add', title: 'X', source: 'S', status: 'todo' });
ok('add 缺 detail 被拒', !r.ok && /detail/.test(r.error), r.error);
seed();
r = M.applyOp(M.load(T), 'D:/Work/demo', { action: 'add', title: 'X', source: 'S', detail: 'D', status: 'todo', id: 'P02' });
ok('add 正常通过', r.ok && r.id === 'P02', JSON.stringify(r));
seed();
r = M.applyOp(M.load(T), 'D:/Work/demo', { action: 'add', title: 'X', source: 'S', detail: 'D', status: 'done' });
ok('add 不允许直接 done', !r.ok, r.error);
seed();
r = M.applyOp(M.load(T), 'D:/Work/demo', { action: 'add', title: 'Dup', source: 'S', detail: 'D', status: 'todo', id: 'P01' });
ok('add 重复 id 有提示', !r.ok && /已存在 P01/.test(r.error), r.error);

// 2) update 终态必须带 result
seed();
r = M.applyOp(M.load(T), 'D:/Work/demo', { action: 'update', id: 'P01', status: 'done' });
ok('update 终态缺 result 被拒', !r.ok && /result/.test(r.error), r.error);
seed();
r = M.applyOp(M.load(T), 'D:/Work/demo', { action: 'update', id: 'P01', status: 'done', result: '做完了' });
ok('update 终态带 result 通过', r.ok, JSON.stringify(r));

// 3) 非法状态
seed();
r = M.applyOp(M.load(T), 'D:/Work/demo', { action: 'update', id: 'P01', status: 'finished' });
ok('非法状态被拒', !r.ok && /非法状态/.test(r.error), r.error);

// 4) void 不能直接复活
seed();
const d0 = M.load(T); const w0 = M.ensureWs(d0, 'D:/Work/demo'); w0.ledger[0].status = 'void';
r = M.applyOp(d0, 'D:/Work/demo', { action: 'update', id: 'P01', status: 'doing' });
ok('void 不能直接改回', !r.ok && /已作废/.test(r.error), r.error);
r = M.applyOp(d0, 'D:/Work/demo', { action: 'update', id: 'P01', status: 'doing', reopen: true });
ok('void 带 reopen 可重开', r.ok, JSON.stringify(r));

// 5) 状态轨迹被记录
seed();
let d1 = M.load(T);
M.applyOp(d1, 'D:/Work/demo', { action: 'update', id: 'P01', status: 'doing' });
const w1 = M.ensureWs(d1, 'D:/Work/demo');
ok('history 记录 from/to', Array.isArray(w1.ledger[0].history) && w1.ledger[0].history.length >= 1,
  JSON.stringify(w1.ledger[0].history));

// 6) 项目隔离：wsForExec 只认会话
const execA = { agent: { id: 'session-aaaa', delegationDepth: 0 } };
ok('wsForExec 无归属时回退 config', M.wsForExec(CONFIG, { agent: { id: 'session-unknown' } }) === 'D:/Work/demo');

// 7) normKey 归一
ok('normKey 反斜杠归一', M.normKey('D:\\Work\\demo') === 'D:/Work/demo');
ok('normKey 末尾斜杠去除', M.normKey('D:/Work/demo///') === 'D:/Work/demo');

// 8) 活动上限 ACT_CAP
seed();
const d2 = M.load(T); const w2 = M.ensureWs(d2, 'D:/Work/demo');
w2.activity = [];
for (let i = 0; i < M.ACT_CAP + 20; i++) {
  M.applyOp(d2, 'D:/Work/demo', { action: 'update', id: 'P01', status: 'doing' });
}
const w2b = M.ensureWs(d2, 'D:/Work/demo');
ok('活动不超过 ACT_CAP', w2b.activity.length <= M.ACT_CAP, w2b.activity.length + '/' + M.ACT_CAP);

// 9) 迁移幂等
seed();
const d3 = M.load(T);
const k1 = Object.keys(d3.workspaces).length;
const d3b = M.load(T);
ok('迁移幂等（分区数不变）', Object.keys(d3b.workspaces).length === k1, k1 + ' -> ' + Object.keys(d3b.workspaces).length);
ok('schema 版本为 2', d3.version === 2, String(d3.version));

// 10) 文案一致
ok('read 文案', M.actText('read', '') === '读取台账（目标·红线·进度）');
ok('update 文案', M.actText('update', 'P01 → done') === '回写台账 P01 → done');
ok('deviate 文案', M.actText('deviate', 'R1 造数') === '记录偏离 R1 造数');


// ---- 11) 工具契约：六个工具都必须能真正调用（这条能抓住 exec is not defined 这类错）----
{
  const { spawnSync: sp } = require('child_process');
  const tc = sp(process.execPath, [path.join(DIR, '_toolcheck.cjs')], { encoding: 'utf8', timeout: 90000 });
  if (tc.status !== 0) {
    out.errors.push('工具契约检查进程失败: ' + (tc.stderr || '').slice(0, 300));
  } else {
    const lines = (tc.stdout || '').split(String.fromCharCode(10));
    const jsonStart = lines.findIndex(function (l) { return l.trim().startsWith('{'); });
    const parsed = jsonStart >= 0 ? JSON.parse(lines.slice(jsonStart).join(String.fromCharCode(10))) : {};
    const names = Object.keys(parsed);
    ok('六个工具全部注册', names.length === 6, names.join(','));
    names.forEach(function (n) { ok('工具 ' + n + ' 可调用', parsed[n] && parsed[n].ok === true, JSON.stringify(parsed[n] || '').slice(0, 120)); });
  }
}

fs.rmSync(T, { force: true });
const failed = out.checks.filter(c => !c.pass);
console.log(JSON.stringify({ total: out.checks.length, failed: failed.length, fails: failed, errors: out.errors }, null, 1));
process.exit(failed.length ? 1 : 0);
