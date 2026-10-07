@echo off
chcp 65001 >nul
rem ============================================================
rem  Slowly · 启动器（带控制台窗口，用来排错时用）
rem  想要"像个软件一样"没有黑窗口，请双击「启动 Slowly.vbs」
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js，Slowly 需要它才能运行。
  echo   请到 https://nodejs.org 下载安装 LTS 版本，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

title Slowly · 慢慢来，比较快

rem 默认以"应用窗口"模式打开（没有地址栏，看着就是一个独立软件）
set SLOWLY_MODE=%1
if "%SLOWLY_MODE%"=="" set SLOWLY_MODE=--app

node "%~dp0server.mjs" %SLOWLY_MODE%

echo.
echo   Slowly 已停止。
pause
