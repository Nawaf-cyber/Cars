@echo off
chcp 65001 >nul
title نسخة احتياطية لقاعدة البيانات
cd /d "%~dp0"

if not exist "data\app.db" (
  echo.
  echo   [!] لا توجد قاعدة بيانات بعد. شغّل النظام أولاً.
  echo.
  pause
  exit /b 1
)

if not exist "backups" mkdir "backups"

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set STAMP=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%_%DT:~8,2%-%DT:~10,2%

REM ملف app.db-wal يحتوي أحدث البيانات ما لم تُدمج بعد،
REM لذلك ننسخ الملفات الثلاثة معاً حتى تكون النسخة كاملة حتى لو كان النظام يعمل.
copy /y "data\app.db" "backups\app_%STAMP%.db" >nul
if exist "data\app.db-wal" copy /y "data\app.db-wal" "backups\app_%STAMP%.db-wal" >nul
if exist "data\app.db-shm" copy /y "data\app.db-shm" "backups\app_%STAMP%.db-shm" >nul

echo.
echo   تمت النسخة الاحتياطية:
echo      backups\app_%STAMP%.db
echo.
echo   ملاحظة: إذا نُسخت ملفات db-wal معها فاحتفظ بها جميعاً — للاسترجاع
echo   انسخ الثلاثة إلى مجلد data بعد إيقاف النظام.
echo.
echo   الأسهل: أوقف النظام أولاً، عندها يكفي ملف app.db وحده.
echo.
pause
