@echo off
setlocal
set "PORT=8789"
set "OPEN_URL=http://127.0.0.1:%PORT%/?provider=moviebox-cncverse"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_bridge.ps1" %*
