@echo off
setlocal
rem Start the localhost Cloudstream bridge (default http://127.0.0.1:8787)
rem Override the port by setting PORT before running, e.g.  set PORT=9000
if not defined PORT set "PORT=8787"
if not defined OPEN_URL set "OPEN_URL=http://127.0.0.1:%PORT%/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_bridge.ps1" %*
