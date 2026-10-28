@echo off
chcp 65001 >nul
title 趣AI味 QuAiWei - 一键配置 API
cd /d "%~dp0"

echo ================================================
echo    趣AI味 QuAiWei - 一键配置 API
echo    回答 3 个问题，打开浏览器即自动填好
echo    （本地引擎不配置也能用，这步是可选增强）
echo ================================================
echo.

rem ---- 0. Node 检查（编码启动链接要用 node，门槛与一键启动一致）----
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js。
    echo 请先双击「环境依赖安装.bat」按提示装好 Node.js，再运行本文件。
    echo.
    pause
    exit /b 1
)

rem ---- 1. 选服务商 ----
echo 第 1 步：选择你的 API 服务商（按数字键即可，不用回车）
echo.
echo   [1] 商汤 SenseNova   国内直连快（默认模型 deepseek-v4-flash）
echo   [2] OpenAI 官方      （默认模型 gpt-4o-mini）
echo   [3] OpenRouter       一个 Key 调用多家模型
echo   [4] 其它 OpenAI 兼容网关（自己填地址和模型名）
echo.
choice /c 1234 /n /m "请按 1 / 2 / 3 / 4 选择："
if errorlevel 4 (
    set "PROVIDER=自定义网关"
    set "DEFBASE="
    set "DEFMODEL="
) else if errorlevel 3 (
    set "PROVIDER=OpenRouter"
    set "DEFBASE=https://openrouter.ai/api/v1"
    set "DEFMODEL=openai/gpt-4o-mini"
) else if errorlevel 2 (
    set "PROVIDER=OpenAI"
    set "DEFBASE=https://api.openai.com/v1"
    set "DEFMODEL=gpt-4o-mini"
) else (
    set "PROVIDER=SenseNova"
    set "DEFBASE=/sensenova/v1"
    set "DEFMODEL=deepseek-v4-flash"
)
echo 已选择：%PROVIDER%
echo.

rem ---- 2. Key ----
echo 第 2 步：粘贴你的 API Key（通常 sk- 开头，在服务商后台创建），粘好后按回车。
set "KEY="
set /p "KEY=API Key："
if not defined KEY (
    echo [错误] Key 不能为空。也可以稍后在界面右上角「设置」里手动填。
    pause
    exit /b 1
)
echo.

rem ---- 3. 网关地址与模型名（有默认值的直接回车即可）----
echo 第 3 步：确认网关地址与模型名（直接回车 = 用括号里的默认值）
if defined DEFBASE (
    set /p "BASE=网关地址（回车 = %DEFBASE%）："
) else (
    set /p "BASE=网关地址（完整地址，如 https://your-gateway.example/v1）："
)
if not defined BASE (
    if not defined DEFBASE (
        echo [错误] 自定义网关必须填地址。
        pause
        exit /b 1
    )
    set "BASE=%DEFBASE%"
)
if defined DEFMODEL (
    set /p "MODEL=模型名（回车 = %DEFMODEL%）："
) else (
    set /p "MODEL=模型名："
)
if not defined MODEL (
    if not defined DEFMODEL (
        echo [错误] 自定义网关必须填模型名。
        pause
        exit /b 1
    )
    set "MODEL=%DEFMODEL%"
)
echo.

rem ---- 4. 编码成启动链接（node 负责转 JSON + base64url，Key 里的特殊字符不用操心）----
set "APILINK="
for /f "usebackq delims=" %%b in (`node -e "const o={baseUrl:process.argv[1],apiKey:process.argv[2],model:process.argv[3]};process.stdout.write(Buffer.from(JSON.stringify(o)).toString('base64url'))" "%BASE%" "%KEY%" "%MODEL%"`) do set "APILINK=%%b"
if not defined APILINK (
    echo [错误] 配置编码失败（Key 里可能带了特殊字符）。请改在界面右上角「设置」里手动填写。
    pause
    exit /b 1
)

rem ---- 5. 顺手把 Key 写进用户环境变量：命令行批量去味（ai-humanizer）自动读取 ----
setx QUAIWEI_API_KEY "%KEY%" >nul

rem ---- 6. 依赖 / 服务检查（与一键启动.bat 同一套判定）----
if not exist "node_modules\vite" (
    echo 首次运行，正在安装依赖（约 1~2 分钟，只需一次）...
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo [错误] 依赖安装失败。请先双击「环境依赖安装.bat」看详细提示。
        pause
        exit /b 1
    )
)
curl -s -o nul --max-time 3 http://localhost:5173
if errorlevel 1 (
    echo 正在启动服务（约 10 秒）...
    start "QuAiWei 服务" cmd /c "npm run dev"
    ping -n 9 127.0.0.1 >nul
)

rem ---- 7. 带配置打开浏览器；页面保存后 hash 里的 Key 会被自动抹掉 ----
start "" "http://localhost:5173/#api=%APILINK%"
echo.
echo ================================================
echo    完成！浏览器已打开并自动填入配置
echo.
echo    · 看到绿色「已一键配置 API」字样即成功，点「去味」就会走该模型
echo    · 调用失败会自动回退本地引擎，不会卡住
echo    · 想修改或清除：界面右上角「设置」
echo    · 本窗口可以关了
echo ================================================
echo.
ping -n 6 127.0.0.1 >nul
exit /b 0
