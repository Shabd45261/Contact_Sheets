'use strict';
/* Generate per-extension .bat launchers (one per targeted plugin) plus a root launcher.
   Ports match the existing root start_<id>.bat files. */
const fs = require('fs');
const path = require('path');
const registry = require('../app/lib/providers');

const ROOT = registry.ROOT;
const BASE_PORT = 8788;
const crlf = lines => lines.join('\r\n') + '\r\n';

function writeBat(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'ascii');
  return file;
}

// Root launcher (all providers, provider picker in the UI).
writeBat(path.join(ROOT, 'start.bat'), crlf([
  '@echo off',
  'setlocal',
  'title CloudStream Local Runtime',
  'if not defined PORT set "PORT=8787"',
  'if not defined OPEN_URL set "OPEN_URL=http://127.0.0.1:%PORT%/"',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\run_bridge.ps1" %*',
]));

const entries = registry.list();
const lines = ['repo\tprovider\tfile\tport\tlauncher'];
entries.forEach((p, i) => {
  const port = BASE_PORT + i;
  const batName = `start-${p.id}.bat`;
  const batPath = path.join(p.dir, batName);
  const url = `http://127.0.0.1:${port}/?provider=${p.id}`;
  writeBat(batPath, crlf([
    '@echo off',
    'setlocal',
    `title ${p.name}`,
    'cd /d "%~dp0..\\.."',
    '',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Node.js was not found on PATH. Install Node 22+ and try again.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    `set "PORT=${port}"`,
    `set "OPEN_URL=${url}"`,
    '',
    `echo ${p.name}`,
    `echo   ${p.repo}\\${p.file}`,
    `echo   ${url}`,
    'echo.',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\\..\\scripts\\run_bridge.ps1" %*',
    '',
    'echo.',
    'echo Server stopped.',
    'pause',
  ]));
  lines.push([p.repo, p.name, p.file, String(port), path.relative(ROOT, batPath).replace(/\\/g, '/')].join('\t'));
});

fs.writeFileSync(path.join(ROOT, 'launchers.tsv'), lines.join('\n') + '\n', 'utf8');
for (const l of lines) console.log(l);
