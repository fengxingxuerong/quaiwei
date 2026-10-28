@echo off
chcp 65001 >nul
title 趣AI味 QuAiWei v0.9.81 - 一键启动
cd /d "%~dp0"

echo ================================================
echo    趣AI味 QuAiWei v0.9.81 - 一键启动
echo    把 AI 写的文章改得更像人写的
echo    本地引擎离线可用 + 可选 LLM + 朱雀增强
echo ================================================
echo.

rem ---- 0. 检测已有服务，直接打开浏览器 ----
curl -s -o nul --max-time 3 http://localhost:5173
if not errorlevel 1 (
    echo 检测到已有服务在运行，直接打开页面...
    start "" http://localhost:5173
    exit /b 0
)

rem ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js。
    echo.
    echo 请先安装 Node.js 22.12 或更高版本（20.19+ 也可）：https://nodejs.org/ 下载 LTS 版一路下一步安装。
    echo 安装完成后再次双击本文件即可。
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set "NODEV=%%i"
rem ---- 1.5 版本门槛校验（vite 8 的 engines 是 ^20.19 || >=22.12）----
rem 此前这里写的是「Node 18+」，与 Vite 6 时代的文档一致，但构建链升到 vite 8 后
rem 18 和 20.0~20.18 都已不受支持：npm install 只报 EBADENGINE 警告，到 npm run dev
rem 才炸，用户看到的是"双击没反应"。改成按 engines 逐档判定。
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
    echo [错误] 当前 Node.js 版本为 %NODEV%，低于本项目的构建链要求。
    echo.
    echo 本项目的构建链是 vite 8：要求 Node 20.19+ 或 22.12+（推荐装 22 LTS）。
    echo 请到 https://nodejs.org/ 下载 LTS 版升级，装完再次双击本文件即可。
    echo.
    pause
    exit /b 1
)
echo [1/3] Node.js 已就绪：%NODEV%。

rem ---- 2. 安装依赖 ----
if not exist "node_modules\vite" (
    echo [2/3] 首次运行，正在安装依赖（约 1~2 分钟，只需一次）...
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败。检查网络（公司网络可能需要配置 npm 代理）：
        echo    npm config set registry https://registry.npmmirror.com
        echo 然后再次双击本文件。
        echo.
        pause
        exit /b 1
    )
) else (
    echo [2/3] 依赖已就绪，无需安装
)

rem ---- 3. 启动服务 ----
echo [3/3] 正在启动服务...
echo.
echo  * 如果浏览器没有自动打开，请手动访问 http://localhost:5173
echo  * 使用期间请保持本窗口打开，关闭即停止服务
echo  * 首次使用建议：点右上角"设置"配置 LLM 或开启朱雀增强
echo  * 想接 AI 大模型增强：关掉本窗口，双击「一键配置API.bat」自动填好
echo  * 朱雀增强：开启后叠加方言/插入语/括号自语等反检测特征
echo.

start "QuAiWei 服务" cmd /c "npm run dev"
ping -n 9 127.0.0.1 >nul
start "" http://localhost:5173

echo 服务已启动，本窗口将在几秒后自动关闭。
ping -n 4 127.0.0.1 >nul
exit /b 0
