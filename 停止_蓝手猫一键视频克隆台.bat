@echo off
chcp 65001 >nul
title 蓝手猫 · 停止服务
echo ============================================================
echo   停止 蓝手猫一键视频克隆台（只停 Web 3000）
echo   不会动你的 H3 工作台 / ComfyUI
echo ============================================================
echo.
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if($c){$c[0].OwningProcess}else{0}"') do (
  if not "%%i"=="0" (
    echo 结束 Web 进程 PID %%i
    taskkill /PID %%i /T /F >nul 2>&1
  ) else (
    echo 端口 3000 无进程
  )
)
echo.
echo 完成。
timeout /t 3 /nobreak >nul
