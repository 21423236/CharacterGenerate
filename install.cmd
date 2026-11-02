@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.11+ is required.
  pause
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12+ is required.
  pause
  exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major<22||(major===22&&minor<12)?1:0)"
if errorlevel 1 (
  echo Please install Node.js 22.12+ or 24 LTS.
  pause
  exit /b 1
)
python -c "import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)"
if errorlevel 1 (
  echo Python 3.11+ is required.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" python -m venv .venv
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
call npm.cmd ci
if errorlevel 1 goto failed
node node_modules\electron\install.js
if errorlevel 1 goto failed
call npm.cmd --prefix web ci
if errorlevel 1 goto failed
call npm.cmd --prefix web run build
if errorlevel 1 goto failed
echo.
echo Ready. Double-click start.cmd to launch Character Forge.
pause
exit /b 0
:failed
echo Installation failed. See the error above.
pause
exit /b 1
