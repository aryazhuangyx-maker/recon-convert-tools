@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: 检查端口 5025 是否已被占用
netstat -ano | findstr ":5025 " >nul
if %errorlevel%==0 (
    echo 端口 5025 已有服务在运行，直接打开浏览器...
    start http://localhost:5025/handover/index.html
) else (
    echo 正在启动工作台服务器（端口 5025）...
    start http://localhost:5025/handover/index.html
    py -3 serve_nocache.py 5025
)
