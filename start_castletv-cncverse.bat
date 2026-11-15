@echo off
setlocal
set "PORT=8791"
set "OPEN_URL=http://127.0.0.1:%PORT%/?provider=castletv-cncverse"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_bridge.ps1" %*
