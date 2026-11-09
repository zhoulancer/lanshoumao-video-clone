@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 蓝手猫 · 一键视频克隆台
cd /d "%~dp0"

echo ============================================================
echo    蓝手猫 · 一键视频克隆台   v1.0
echo    视频分析 / 台词识别 / H3 提示词 / 时间轴剪辑 / 字幕
echo    全程本机运行，不需要任何云端账号
echo ============================================================
echo.

REM ---------- 1) 检查 H3 工作台（只检测，不自动启动） ----------
echo [1/2] 检查 H3 工作台...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check-h3.ps1"
if errorlevel 1 (
  echo       未连接到 H3 工作台（地址见上方「检测地址」）。
  echo       视频分析、音频识别、剪辑、字幕都可正常使用；
  echo       只有「生成视频」需要 H3，请在「设置」里确认地址或启动你的 H3。
) else (
  echo       H3 就绪，可以生成视频
)

REM ---------- 2) 启动 Web ----------
echo [2/2] 启动 Web 服务...
REM 优先使用包内自带的 node（避免 PATH 里没有 Node.js）
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  for %%n in (node.exe) do if not "%%~$PATH:n"=="" set "NODE_EXE=%%~$PATH:n"
)
if not exist "%NODE_EXE%" (
  echo       [错误] 没有找到 Node.js 运行时。
  echo       本包已内置 runtime\node.exe，若被删除请恢复或安装 Node.js 18+。
  pause
  exit /b 1
)
echo       运行时: %NODE_EXE%

for /f "tokens=*" %%p in ('powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if($c){$c[0].OwningProcess}else{0}"') do set "PID3000=%%p"
if not "%PID3000%"=="0" (
  echo       端口 3000 已在运行（PID %PID3000%），直接打开页面
) else (
  start "蓝手猫 Web" cmd /k "cd /d %CD% && "%NODE_EXE%" "node_modules\next\dist\bin\next" start -p 3000"
  timeout /t 8 /nobreak >nul
)

start "" "http://localhost:3000/dashboard"

echo.
echo ============================================================
echo   启动完成
echo     Web     http://localhost:3000/dashboard
echo     H3      http://localhost:7860（需你自行启动）
echo   停止服务：双击「停止_蓝手猫一键视频克隆台.bat」
echo ============================================================
echo.
pause
