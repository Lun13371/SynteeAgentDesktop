@echo off
cd /d C:\Projects\SynteeHelper
echo Building Syntee Helper...
call node node_modules/electron-vite/bin/electron-vite.js build
if %errorlevel% neq 0 (
    echo BUILD FAILED
    pause
    exit /b 1
)
echo Starting Syntee Helper...
set ELECTRON_ENABLE_DEVTOOLS=1
node_modules\electron\dist\electron.exe out\main\index.js
