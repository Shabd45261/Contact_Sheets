'use strict';
/* On-demand zip builder for a job's contact sheets. Mirrors pdf.js: shells out
   to the stdlib Python helper so we don't need an npm zip dependency. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, 'zip_sheets.py');

function pythonBin() {
  const candidates = [
    process.env.PYTHON,
    'C:\\Python313\\python.exe',
    'C:\\HostDrives\\C\\Python313\\python.exe',
    'python',
  ].filter(Boolean);
  return candidates[0];
}

/** Build <out> from `files`. Resolves { files, bytes }. */
function buildZip({ files, out, base, timeout = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const manifest = out.replace(/\.zip$/i, '.manifest.json');
    try { fs.writeFileSync(manifest, JSON.stringify({ out, files, base })); }
    catch (e) { return reject(e); }
    const py = pythonBin();
    const p = spawn(py, [SCRIPT, manifest], { windowsHide: true });
    let outText = '', errText = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('zip build timed out')); }, timeout);
    p.stdout.on('data', d => { outText += d; });
    p.stderr.on('data', d => { errText += d; });
    p.on('error', e => { clearTimeout(timer); reject(new Error(`could not start Python (${py}): ${e.message}`)); });
    p.on('close', code => {
      clearTimeout(timer);
      try { fs.rmSync(manifest, { force: true }); } catch {}
      const m = /"files"\s*:\s*(\d+)/.exec(outText);
      if (code === 0 && m) {
        const bm = /"bytes"\s*:\s*(\d+)/.exec(outText);
        return resolve({ files: Number(m[1]), bytes: bm ? Number(bm[1]) : 0 });
      }
      const msg = (errText || outText).trim().split('\n').slice(-2).join(' | ');
      reject(new Error(`zip build failed${code ? ` (exit ${code})` : ''}${msg ? ': ' + msg : ''}`));
    });
  });
}

module.exports = { buildZip, pythonBin };