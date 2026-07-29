@echo off
chcp 65001 >nul 2>&1
title Syntee Helper - Release Build
color 0F

set LAUNCHER_DIR=C:\Projects\syntee-launcher
set CLIENT_DIR=C:\Projects\SynteeHelper

echo.
echo  ============================================================
echo             SYNTEE HELPER - RELEASE BUILD SCRIPT
echo  ============================================================
echo.
echo  Builds two release artifacts:
echo    1. syntee-launcher.exe  (7 MB)   - for website
echo    2. Syntee Helper-X.X.X-x64.zip (400 MB) - for Gateway
echo.
echo  Gateway URL: https://gateway.syntee.dev
echo  Build time: ~6-10 minutes
echo.

if not exist "%LAUNCHER_DIR%\main.go" (
    echo  [ERROR] Launcher not found: %LAUNCHER_DIR%\main.go
    pause
    exit /b 1
)
if not exist "%CLIENT_DIR%\package.json" (
    echo  [ERROR] Client not found: %CLIENT_DIR%\package.json
    pause
    exit /b 1
)

echo  ------------------------------------------------------------
echo  Step 0: Version
echo  ------------------------------------------------------------
echo.

REM Parse current version from package.json
for /f "delims=" %%v in ('powershell -NoProfile -Command "(Get-Content '%CLIENT_DIR%\package.json' -Raw | ConvertFrom-Json).version"') do set CURR_VER=%%v

if "%CURR_VER%"=="" (
    echo  [ERROR] Could not read version from package.json
    pause
    exit /b 1
)

REM Auto-bump patch (0.1.3 -> 0.1.4)
for /f "delims=" %%v in ('powershell -NoProfile -Command "$p='%CURR_VER%'.Split('.'); $p[2]=[int]$p[2]+1; $p -join '.'"') do set AUTO_VER=%%v

echo  Current version: %CURR_VER%
echo  Auto-bump suggestion: %AUTO_VER%
echo.
set /p NEW_VER="  Enter new version (Enter = %AUTO_VER%, or type your own): "
if "%NEW_VER%"=="" set NEW_VER=%AUTO_VER%

echo.
echo  Building version: %NEW_VER%
echo.

REM Update version in package.json (using node to avoid PowerShell quoting issues)
pushd "%CLIENT_DIR%"
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='%NEW_VER%';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
if errorlevel 1 (
    echo  [ERROR] Failed to update package.json version
    popd
    pause
    exit /b 1
)
popd
echo  [OK] package.json updated to %NEW_VER%
echo.

echo  ------------------------------------------------------------
echo  Step 1 of 4: Build syntee-launcher.exe
echo  ------------------------------------------------------------
echo.

pushd "%LAUNCHER_DIR%"

echo  Building launcher (Go, no CGO)...
if exist syntee-launcher.exe del /q syntee-launcher.exe

go build -ldflags="-s -w -H windowsgui -X github.com/Lun13371/syntee-launcher/internal/config.DefaultUpdateServer=https://gateway.syntee.dev/api/public/updates" -o syntee-launcher.exe .
if errorlevel 1 (
    echo.
    echo  [ERROR] Launcher build failed!
    popd
    pause
    exit /b 1
)

echo  [OK] syntee-launcher.exe built

echo.
echo  Copying to client resources...
copy /Y syntee-launcher.exe "%CLIENT_DIR%\resources\syntee-launcher.exe" >nul
echo  [OK] Copied

popd

echo.
echo  ------------------------------------------------------------
echo  Step 2 of 4: Check client dependencies
echo  ------------------------------------------------------------
echo.

pushd "%CLIENT_DIR%"

if not exist "node_modules" (
    echo  node_modules not found. Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install failed!
        popd
        pause
        exit /b 1
    )
)

echo  [OK] Dependencies ready

echo.
echo  ------------------------------------------------------------
echo  Step 3 of 4: Build client (electron-builder)
echo  ------------------------------------------------------------
echo.
echo  This will take 5-10 minutes. Do not close this window.
echo.

echo  Cleaning old build cache (dist, out, electron-builder cache)...
if exist dist rmdir /s /q dist
if exist out rmdir /s /q out
if exist node_modules\.cache rmdir /s /q node_modules\.cache
if exist "%LOCALAPPDATA%\electron-builder\Cache" rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache"
if exist "%APPDATA%\electron-builder\Cache" rmdir /s /q "%APPDATA%\electron-builder\Cache"
echo  [OK] Clean

echo  Building client...
call npm run build:win
if errorlevel 1 (
    echo.
    echo  [ERROR] Client build failed!
    popd
    pause
    exit /b 1
)

echo.
echo  [OK] Client built

echo.
echo  ------------------------------------------------------------
echo  Step 4 of 4: Verify artifacts
echo  ------------------------------------------------------------
echo.

set LAUNCHER_ART=%LAUNCHER_DIR%\syntee-launcher.exe
set ZIP_ART=

echo  Looking for zip in dist\...
for %%f in ("%CLIENT_DIR%\dist\*-x64.zip") do (
    set ZIP_ART=%%f
)

if exist "%LAUNCHER_ART%" (
    echo  [OK] Launcher:  %LAUNCHER_ART%
) else (
    echo  [ERROR] Launcher not found!
)

if defined ZIP_ART (
    echo  [OK] Client:    %ZIP_ART%
) else (
    echo  [ERROR] Client zip not found in dist\!
)

popd

echo.
echo  ============================================================
echo                      BUILD COMPLETE
echo  ============================================================
echo.
echo  Version:   %NEW_VER%
echo.
echo  ------------------------------------------------------------
echo  WHAT TO DO NEXT - INSTRUCTIONS
echo  ------------------------------------------------------------
echo.
echo  Two files are ready for release:
echo.
echo  +----------------------------------------------------------+
echo  ^| 1. syntee-launcher.exe                                   ^|
echo  ^|    Path: C:\Projects\syntee-launcher\syntee-launcher.exe ^|
echo  ^|    Size: ~7 MB                                            ^|
echo  ^|    WHERE: Upload to website (Download button)             ^|
echo  ^|    This is what users download                            ^|
echo  +----------------------------------------------------------+
echo.
echo  +----------------------------------------------------------+
echo  ^| 2. Syntee Helper-%NEW_VER%-x64.zip                      ^|
echo  ^|    Path: C:\Projects\SynteeHelper\dist\                   ^|
echo  ^|    Size: ~400 MB                                          ^|
echo  ^|    WHERE: Syntee Gateway Admin -> Releases -> Upload      ^|
echo  ^|    This is the client the launcher downloads on install   ^|
echo  +----------------------------------------------------------+
echo.
echo  ------------------------------------------------------------
echo  HOW TO PUBLISH A RELEASE
echo  ------------------------------------------------------------
echo.
echo  Step A - Upload launcher to website:
echo    1. Open website admin panel
echo    2. Replace the download file with:
echo       C:\Projects\syntee-launcher\syntee-launcher.exe
echo    3. Users will download this file (7 MB)
echo.
echo  Step B - Upload client to Gateway:
echo    1. Open: https://gateway.syntee.dev/admin
echo    2. Go to: Releases
echo    3. Click "Upload New Release"
echo    4. Select the zip file from:
echo       C:\Projects\SynteeHelper\dist\
echo    5. Fill in:
echo       - Version:   %NEW_VER%
echo       - Channel:   stable
echo       - Force:     no (normal update)
echo       - Changelog: description of changes
echo    6. Click "Activate" to make the release active
echo.
echo  Step C - Verify:
echo    1. Download syntee-launcher.exe from website to a clean PC
echo    2. Run it - launcher will download client and install
echo    3. Verify Syntee Helper launches correctly
echo.

echo  Opening dist folder in Explorer...
explorer "%CLIENT_DIR%\dist"

echo.
echo  Done! Press any key to exit.
pause >nul
