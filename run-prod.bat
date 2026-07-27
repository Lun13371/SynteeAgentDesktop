@echo off
cd /d C:\Projects\SynteeHelper
echo Building Syntee Helper (prod)...

REM ── Syntee-Gateway endpoints (production) ──
REM API_URL — куда main-процесс стучится за /v1/* и /api/user/* (через nginx:80).
REM WEB_URL — сайт gateway с consent-страницей /auth/desktop (тот же origin).
REM HTTP сейчас, HTTPS добавим позже — код поддержит переключение.
set SYNTEE_API_URL=http://153.52.66.137
set SYNTEE_WEB_URL=http://153.52.66.137

call node node_modules/electron-vite/bin/electron-vite.js build
if %errorlevel% neq 0 (
    echo BUILD FAILED
    pause
    exit /b 1
)
echo.
echo ============================================
echo  SYNTEE PROD — логи main/worker ниже
echo  API: %SYNTEE_API_URL%
echo  WEB: %SYNTEE_WEB_URL%
echo ============================================
echo.
node_modules\electron\dist\electron.exe out\main\index.js --enable-logging 2>&1
pause
