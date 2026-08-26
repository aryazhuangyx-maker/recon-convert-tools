@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: ── 粮单自动化后端（8765，可选启动）──
set "PY=C:\Users\CSCI\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" set "PY=py -3"

netstat -ano | findstr ":8765 " >nul
if %errorlevel%==0 (
    echo [OK] 粮单自动化后端已在运行（8765）
) else (
    if exist "..\粮单自动化\app.py" (
        echo 正在启动粮单自动化后端（端口 8765）...
        start "粮单自动化后端" cmd /k "cd /d "..\粮单自动化" && "%PY%" app.py"
    ) else (
        echo [警告] 未找到 ..\粮单自动化\app.py，跳过
    )
)

:: ── 工作台服务器（5025）──
netstat -ano | findstr ":5025 " >nul
if %errorlevel%==0 (
    echo 端口 5025 已有服务在运行，直接打开浏览器...
    start http://localhost:5025/handover/index.html
) else (
    echo 正在启动工作台服务器（端口 5025）...
    start http://localhost:5025/handover/index.html
    py -3 serve_nocache.py 5025
)
