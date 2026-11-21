@echo off
chcp 65001 >nul
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-napcat.ps1" %*
if errorlevel 1 (
  echo.
  echo 安装失败，请把上面的报错发给 DSH。
  pause
  exit /b 1
)
echo.
pause
