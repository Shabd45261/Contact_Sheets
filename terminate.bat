@echo off
setlocal
title CloudStream Local Runtime - Terminate
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\terminate.ps1"
echo.
pause
