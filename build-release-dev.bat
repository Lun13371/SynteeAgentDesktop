@echo off
chcp 65001 >nul 2>&1
title Syntee Helper - DEV Build
color 0A

set LAUNCHER_DIR=C:\Projects\syntee-launcher
set CLIENT_DIR=C:\Projects\SynteeHelper
set GATEWAY_RELEASES=C:\Projects\Syntee-Gateway\backend\data\releases\stable
set PG_CONTAINER=syntee-gateway-postgres-1
set PG_USER=syntee
set PG_DB=syntee
set ADMIN_ID=3a08983d-2d41-4843-a3b4-86ef79c56db5

echo.
echo  ============================================================
echo             SYNTEE HELPER - DEV BUILD (localhost)
echo  ============================================================
echo.
echo  Builds two release artifacts + auto-activates on Gateway:
echo    1. syntee-launcher.exe  (7 MB)
echo    2. Syntee Helper-X.X.X-x64.zip (~400 MB)
echo.
echo  Gateway URL: http://localhost:8000
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

go build -ldflags="-s -w -H windowsgui -X github.com/Lun13371/syntee-launcher/internal/config.DefaultUpdateServer=http://localhost:8000/api/public/updates" -o syntee-launcher.exe .
if errorlevel 1 (
    echo.
    echo  [ERROR] Launcher build failed!
    popd
    pause
    exit /b 1
)

echo  [OK] syntee-launcher.exe built

echo.
echo  Copying to client resources and gateway...
copy /Y syntee-launcher.exe "%CLIENT_DIR%\resources\syntee-launcher.exe" >nul
copy /Y syntee-launcher.exe "C:\Projects\Syntee-Gateway\backend\data\launcher\syntee-launcher.exe" >nul
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
echo  Step 4 of 4: Copy to Gateway + activate release in DB
echo  ------------------------------------------------------------
echo.

set LAUNCHER_ART=%LAUNCHER_DIR%\syntee-launcher.exe
set ZIP_ART=
set ZIP_FILENAME=Syntee Helper-%NEW_VER%-x64.zip

echo  Looking for zip in dist\...
for %%f in ("%CLIENT_DIR%\dist\*-x64.zip") do (
    set ZIP_ART=%%f
)

if not defined ZIP_ART (
    echo  [ERROR] Client zip not found in dist\!
    popd
    pause
    exit /b 1
)

echo  [OK] Launcher:  %LAUNCHER_ART%
echo  [OK] Client:    %ZIP_ART%
echo.

REM Compute SHA256
echo  Computing SHA256...
for /f "delims=" %%h in ('powershell -NoProfile -Command "(Get-FileHash '%ZIP_ART%' -Algorithm SHA256).Hash.ToLower()"') do set SHA256=%%h
echo  [OK] SHA256: %SHA256%

REM Get file size
for %%f in ("%ZIP_ART%") do set ZIP_SIZE=%%~zf
echo  [OK] Size: %ZIP_SIZE% bytes
echo.

REM Copy zip to gateway releases dir
echo  Copying zip to Gateway data dir...
if not exist "%GATEWAY_RELEASES%\%NEW_VER%" mkdir "%GATEWAY_RELEASES%\%NEW_VER%"
copy /Y "%ZIP_ART%" "%GATEWAY_RELEASES%\%NEW_VER%\"
echo  [OK] Copied to %GATEWAY_RELEASES%\%NEW_VER%\
echo.

REM Activate release in Gateway DB via docker exec
echo  Activating release %NEW_VER% on stable channel in Gateway DB...

REM Deactivate all stable releases, then UPSERT new release as active
docker exec %PG_CONTAINER% psql -U %PG_USER% -d %PG_DB% -c "UPDATE client_releases SET is_active = false WHERE channel = 'stable';"
docker exec %PG_CONTAINER% psql -U %PG_USER% -d %PG_DB% -c "INSERT INTO client_releases (id, version, channel, zip_filename, zip_size_bytes, sha256, is_active, force, activated_at, download_count, created_by_admin, created_at) VALUES (gen_random_uuid(), '%NEW_VER%', 'stable', '%ZIP_FILENAME%', %ZIP_SIZE%, '%SHA256%', true, false, NOW(), 0, '%ADMIN_ID%', NOW()) ON CONFLICT (channel, version) DO UPDATE SET zip_filename = EXCLUDED.zip_filename, zip_size_bytes = EXCLUDED.zip_size_bytes, sha256 = EXCLUDED.sha256, is_active = true, activated_at = NOW();"

if errorlevel 1 (
    echo  [WARNING] DB update failed! You may need to activate manually via admin panel.
) else (
    echo  [OK] Release %NEW_VER% activated on stable channel
)

popd

echo.
echo  ============================================================
echo                   DEV BUILD COMPLETE
echo  ============================================================
echo.
echo  Version:   %NEW_VER%
echo  Gateway:   http://localhost:8000
echo  Launcher:  %LAUNCHER_DIR%\syntee-launcher.exe
echo  Client:    %CLIENT_DIR%\dist\
echo.
echo  Release is active on Gateway. The launcher will detect and
echo  download this version on next run.
echo.
echo  To test: delete %%LOCALAPPDATA%%\Programs\Syntee Helper\
echo  then run syntee-launcher.exe
echo.

echo  Opening dist folder in Explorer...
explorer "%CLIENT_DIR%\dist"

echo.
echo  Done! Press any key to exit.
pause >nul
