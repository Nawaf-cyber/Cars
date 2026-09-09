@echo off
chcp 65001 >nul
title نظام متابعة تحصيل السيارات
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Node.js غير مثبت على هذا الجهاز.
  echo       نزّله من:  https://nodejs.org  ثم شغّل هذا الملف مرة أخرى.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   جارٍ تجهيز النظام لأول مرة... انتظر قليلاً.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [!] فشل التجهيز. تأكد من الاتصال بالإنترنت وحاول مرة أخرى.
    pause
    exit /b 1
  )
)

start "" http://localhost:3000
node server.js

echo.
echo   توقّف النظام.
pause
