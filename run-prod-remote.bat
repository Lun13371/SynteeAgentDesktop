@echo off
set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"
echo Building Syntee Helper (prod + remote debugging)...

if not exist "node_modules\electron-vite\bin\electron-vite.js" (
    echo Dependencies are missing. Installing npm packages...
    call npm install
    if errorlevel 1 (
        echo DEPENDENCY INSTALL FAILED
        pause
        exit /b 1
    )
)

REM ── Syntee-Gateway endpoints (production) ──
REM API_URL — куда main-процесс стучится за /v1/* и /api/user/* (через Caddy/nginx).
REM WEB_URL — сайт gateway с consent-страницей /auth/desktop (тот же origin).
REM HTTPS через Caddy (Let's Encrypt). wsUrl() делает https->wss автоматически.
set SYNTEE_API_URL=https://syntee.fun
set SYNTEE_WEB_URL=https://syntee.fun

REM ── Remote debugging (DevTools Protocol) ──
REM CDP_PORT — порт CDP. Даёт DevTools для renderer, Performance-профиль,
REM Tracing (Paint/CompositeLayers/FunctionCall), Memory heap snapshot,
REM chrome://gpu и доступ к overlay-хабу (#/notifications).
REM Слушает только 127.0.0.1 — снаружи не доступен.
set "CDP_PORT=9222"

REM MAIN_INSPECT_PORT — node-inspector для MAIN-процесса (heap snapshot).
REM По умолчанию пусто = выключено: MainWindow.ts:207 сам откроет DevTools,
REM если увидит --inspect, а открытые DevTools искажают замер CPU.
set "MAIN_INSPECT_PORT="

REM SYNTEE_PERF_DIAGNOSTICS=1 — сэмплер в main: каждые 10 с пишет RSS,
REM cpuUserMs/cpuSystemMs, event-loop delay p95/max в
REM %APPDATA%\SynteeHelper\logs\performance-main.jsonl
set SYNTEE_PERF_DIAGNOSTICS=1

call node node_modules/electron-vite/bin/electron-vite.js build
if %errorlevel% neq 0 (
    echo BUILD FAILED
    pause
    exit /b 1
)

REM ── Порт уже занят? (остался старый экземпляр) ──
netstat -ano 2>nul | findstr ":%CDP_PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo.
    echo [WARN] Порт %CDP_PORT% уже занят — CDP может подключиться не к тому процессу.
    echo        Закрой старый Syntee Helper и запусти заново.
    echo.
)

REM ── Аргументы Electron ──
REM Флаги идут ПОСЛЕ пути приложения: process.argv[1] должен остаться
REM out\main\index.js (его используют автозапуск и регистрация протокола).
set "ELECTRON_ARGS=--enable-logging --remote-debugging-port=%CDP_PORT% --remote-debugging-address=127.0.0.1"
if defined MAIN_INSPECT_PORT set "ELECTRON_ARGS=%ELECTRON_ARGS% --inspect=%MAIN_INSPECT_PORT%"

echo.
echo ============================================
echo  SYNTEE PROD + REMOTE DEBUG — логи ниже
echo  API: %SYNTEE_API_URL%
echo  WEB: %SYNTEE_WEB_URL%
echo.
echo  CDP targets:    http://127.0.0.1:%CDP_PORT%/json/list
echo  DevTools:       chrome://inspect  ^(Configure... -^> 127.0.0.1:%CDP_PORT%^)
echo  Perf-лог main:  %APPDATA%\SynteeHelper\logs\performance-main.jsonl
if defined MAIN_INSPECT_PORT echo  Main inspector: 127.0.0.1:%MAIN_INSPECT_PORT%  ^(chrome://inspect^)
echo ============================================
echo.

node_modules\electron\dist\electron.exe out\main\index.js %ELECTRON_ARGS% 2>&1
pause
