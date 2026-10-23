@echo off
chcp 936 >nul
title 趣AI味 QuAiWei - 环境依赖安装
cd /d "%~dp0"

echo ================================================
echo    趣AI味 QuAiWei v0.9.65 - 环境依赖安装
echo ================================================
echo.

rem ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js！
    echo.
    echo 依赖只有一项：Node.js 22.12 或更高版本（20.19+ 也可以）。
    echo 下载：https://nodejs.org/ （选 LTS 版，安装时一路下一步）
    echo 装完后重新双击本文件。
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set "NODEV=%%i"
rem ---- 1.5 版本门槛（vite 8 的 engines：^20.19 || >=22.12）----
set "NV=%NODEV:v=%"
set "NODE_MAJOR=0"
set "NODE_MINOR=0"
for /f "tokens=1,2 delims=." %%a in ("%NV%") do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)
set "NODE_OK="
if %NODE_MAJOR% EQU 20 if %NODE_MINOR% GEQ 19 set "NODE_OK=1"
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% GEQ 12 set "NODE_OK=1"
if %NODE_MAJOR% GTR 22 set "NODE_OK=1"
if not defined NODE_OK (
    echo [错误] 当前 Node.js 版本为 %NODEV%，低于构建链要求（20.19+ 或 22.12+）。
    echo 请到 https://nodejs.org/ 下载 LTS 版升级后重试。
    echo.
    pause
    exit /b 1
)
echo [1/2] Node.js 已就绪（%NODEV%）
echo.

rem ---- 2. 安装 npm 依赖 ----
echo [2/2] 正在安装项目依赖（react / vite / typescript 等，约 1~2 分钟）...
echo.
call npm install --no-fund --no-audit
if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。常见原因及解决办法：
    echo   1. 网络不通公司内网 → 换网络
    echo   2. 官方源慢/超时 → 先执行下面命令换国内镜像再重试：
    echo      npm config set registry https://registry.npmmirror.com
    echo.
    pause
    exit /b 1
)

echo.
echo ================================================
echo    依赖安装完成！双击「一键启动.bat」即可使用
echo ================================================
echo.
pause
exit /b 0
