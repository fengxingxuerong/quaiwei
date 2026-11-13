@echo off
chcp 936 >nul
rem QuAiWei v0.9.88 compatibility launcher: use this if QuAiWei.exe crashes on double-click.
rem Same executable, extra Chromium switches for GPU/sandbox issues. Keep this folder intact.
cd /d "%~dp0"
if not exist "QuAiWei.exe" goto NOEXE
start "" "QuAiWei.exe" --no-sandbox --disable-gpu-sandbox --disable-gpu --disable-gpu-compositing --use-gl=swiftshader
goto :EOF
:NOEXE
echo QuAiWei.exe not found. Keep the whole extracted folder together.
pause
