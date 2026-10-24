@echo off
set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"
echo Building Syntee Helper (debug)...

if not exist "node_modules\electron-vite\bin\electron-vite.js" (
    echo Dependencies are missing. Installing npm packages...
    call npm install
    if errorlevel 1 (
        echo DEPENDENCY INSTALL FAILED
        pause
        exit /b 1
    )
)

REM ── Syntee-Gateway endpoints (dev) ──
REM API_URL — куда main-процесс стучится за /v1/* и /api/user/* (backend FastAPI).
REM WEB_URL — сайт gateway, где открывается consent-страница /auth/desktop.
set SYNTEE_API_URL=http://localhost:8000
set SYNTEE_WEB_URL=http://localhost:3000

call node node_modules/electron-vite/bin/electron-vite.js build
if %errorlevel% neq 0 (
    echo BUILD FAILED
    pause
    exit /b 1
)
echo.
echo ============================================
echo  SYNTEE DEBUG — логи main/worker ниже
echo  API: %SYNTEE_API_URL%
echo  WEB: %SYNTEE_WEB_URL%
echo ============================================
echo.
node_modules\electron\dist\electron.exe out\main\index.js --enable-logging 2>&1
pause
