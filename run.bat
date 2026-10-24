@echo off
set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"
echo Building Syntee Helper...
if not exist "node_modules\electron-vite\bin\electron-vite.js" (
    echo Dependencies are missing. Installing npm packages...
    call npm install
    if errorlevel 1 (
        echo DEPENDENCY INSTALL FAILED
        pause
        exit /b 1
    )
)
call node node_modules/electron-vite/bin/electron-vite.js build
if %errorlevel% neq 0 (
    echo BUILD FAILED
    pause
    exit /b 1
)
echo Starting Syntee Helper...
echo Renderer DevTools: откроется автоматически
echo Main process logs: в этом окне
echo.
node_modules\electron\dist\electron.exe out\main\index.js --devtools
