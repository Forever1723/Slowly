@echo off
chcp 65001 >nul
rem ============================================================
rem  让手机能连上电脑上的 Slowly（需要管理员权限）
rem  右键本文件 →「以管理员身份运行」
rem  执行一次即可，之后不用再管
rem ============================================================
title 为 Slowly 放行防火墙

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   需要管理员权限。
  echo   请关掉这个窗口，右键本文件选「以管理员身份运行」。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在为 Slowly 添加防火墙入站规则（TCP 8787）...
netsh advfirewall firewall delete rule name="Slowly" >nul 2>&1
netsh advfirewall firewall add rule name="Slowly" dir=in action=allow protocol=TCP localport=8787 profile=private,domain

if errorlevel 1 (
  echo.
  echo   添加失败。也可以手动在「Windows 安全中心 → 防火墙和网络保护 →
  echo   高级设置 → 入站规则」里新建一条放行 TCP 8787 的规则。
) else (
  echo.
  echo   完成。现在手机连同一个 WiFi，扫码就能打开 Slowly 了。
  echo   （如果只在家里用，规则只对「专用网络」生效，公共 WiFi 下不会放行）
)
echo.
pause
