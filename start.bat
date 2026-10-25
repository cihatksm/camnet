@echo off
chcp 65001 >nul
cd /d "%~dp0"
title CamNet

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 goto :err
)

if not exist dist\index.html (
  echo Building the UI...
  call npm run build
  if errorlevel 1 goto :err
)

node server/index.js
pause
exit /b 0

:err
echo.
echo An error occurred during setup.
pause
exit /b 1
