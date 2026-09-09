@echo off
chcp 65001 >nul
title السماح للموظفين بالوصول للنظام

REM يحتاج صلاحيات مدير — يرفع نفسه تلقائياً
net session >nul 2>&1
if errorlevel 1 (
  echo   يحتاج صلاحيات مدير... اضغط "نعم" في النافذة التي ستظهر.
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo ==========================================================
echo   السماح لأجهزة الشبكة بالوصول لنظام السيارات
echo ==========================================================
echo.

REM احذف أي قاعدة سابقة بنفس الاسم حتى لا تتكرر
netsh advfirewall firewall delete rule name="CarSystem-3000" >nul 2>&1

netsh advfirewall firewall add rule ^
  name="CarSystem-3000" ^
  description="نظام متابعة تحصيل السيارات - منفذ 3000" ^
  dir=in action=allow protocol=TCP localport=3000 ^
  profile=private,domain >nul

if errorlevel 1 (
  echo   [!] فشل إضافة القاعدة. تأكد أنك شغّلت الملف كمسؤول.
  echo.
  pause
  exit /b 1
)

echo   تم فتح المنفذ 3000 لأجهزة الشبكة المحلية بنجاح.
echo.
echo   ملاحظة: القاعدة تسري على الشبكات "الخاصة" فقط — وهذا هو المطلوب.
echo   لن يستطيع أحد من الإنترنت الوصول للنظام.
echo.
echo ==========================================================
echo   عناوين الدخول من أجهزة الموظفين:
echo ==========================================================
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%B in ("%%A") do echo      http://%%B:3000
)
echo.
echo   افتح أحد هذه العناوين من جوال أو جهاز موظف للتأكد.
echo.
pause
