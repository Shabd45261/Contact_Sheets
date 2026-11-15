'use strict';
/* PDF builder for the video -> PDF job. Frames are JPEGs extracted by ffmpeg;
   app\lib\pdf_frames.py embeds them as PDF DCTDecode images (one page each)
   without decoding, so thousands of frames stay cheap. */
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'pdf_frames.py');

function pythonBin() {
  const candidates = [
    process.env.PYTHON,
    'C:\\Python313\\python.exe',
    'C:\\HostDrives\\C\\Python313\\python.exe',
    'python',
  ].filter(Boolean);
  return candidates[0];
}

/** Build <out> from every frame in <framesDir>. Resolves the page count. */
function buildPdf({ framesDir, out, timeout = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const py = pythonBin();
    const p = spawn(py, [SCRIPT, framesDir, out], { windowsHide: true });
    let outText = '', errText = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('PDF build timed out')); }, timeout);
    p.stdout.on('data', d => { outText += d; });
    p.stderr.on('data', d => { errText += d; });
    p.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`could not start Python (${py}): ${e.message}`));
    });
    p.on('close', code => {
      clearTimeout(timer);
      const m = /pages=(\d+)/.exec(outText);
      if (code === 0 && m) return resolve(Number(m[1]));
      const msg = (errText || outText).trim().split('\n').slice(-2).join(' | ');
      reject(new Error(`PDF build failed${code ? ` (exit ${code})` : ''}${msg ? ': ' + msg : ''}`));
    });
  });
}

module.exports = { buildPdf, pythonBin };
