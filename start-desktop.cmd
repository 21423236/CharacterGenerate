@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "node_modules\electron\cli.js" (
  echo Run install.cmd first to install the desktop browser.
  pause
  exit /b 1
)
call npm.cmd run desktop
if errorlevel 1 pause
