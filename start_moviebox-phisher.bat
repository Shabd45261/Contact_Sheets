@echo off
setlocal
set "PORT=8788"
set "OPEN_URL=http://127.0.0.1:%PORT%/?provider=moviebox-phisher"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_bridge.ps1" %*
