@echo off
setlocal
title CloudStream - Delete cache
rem Lists the disposable caches with sizes, then asks three times (y + Enter) before deleting.
rem Any answer other than y cancels. Use "DELETE_CACHE.bat -ListOnly" to only list.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\delete_cache.ps1" %*
echo.
pause
