'use strict';
// 每次运行前用当前 overlay.css 重建预览页，避免断言校验的是旧样式
const fs = require('fs');
const path = require('path');
module.exports = function buildPreview() {
  const DIR = __dirname;
  const css = fs.readFileSync(path.join(DIR, '..', 'lib', 'overlay.css'), 'utf8');
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>northstar preview</title>'
    + '<style>html,body{margin:0;height:100%;background:linear-gradient(160deg,#0b1220,#17233a 60%,#0d1526);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style>'
    + '<style id="ns-css">' + css + '</style></head><body>'
    + '<div style="position:fixed;left:12px;bottom:8px;color:#8aa;font:12px/1.4 sans-serif;opacity:.6">northstar preview harness</div>'
    + '</body></html>';
  fs.writeFileSync(path.join(DIR, 'preview.html'), html, 'utf8');
  return path.join(DIR, 'preview.html');
};
