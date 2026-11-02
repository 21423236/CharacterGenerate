@echo off
setlocal
cd /d "%~dp0"
echo Select your account region. Do not infer it from language.
echo 1. CN - developers.tripo3d.com
echo 2. OV - developers.tripo3d.ai
set /p REGION_CHOICE=Region [1/2]:
if "%REGION_CHOICE%"=="1" (
  node node_modules\tripo-cli\dist\cli.js login --region cn
) else if "%REGION_CHOICE%"=="2" (
  node node_modules\tripo-cli\dist\cli.js login --region ov
) else (
  echo Invalid selection.
)
pause
