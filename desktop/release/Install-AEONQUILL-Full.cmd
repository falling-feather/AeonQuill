@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-AEONQUILL-Full.ps1"
if errorlevel 1 (
  echo.
  echo AEONQUILL full installation failed. Review the message above.
  pause
  exit /b 1
)
endlocal
