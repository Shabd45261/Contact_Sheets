@echo off
setlocal
title CloudStream Local Runtime
if not defined PORT set "PORT=8787"
if not defined OPEN_URL set "OPEN_URL=http://127.0.0.1:%PORT%/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_bridge.ps1" %*
