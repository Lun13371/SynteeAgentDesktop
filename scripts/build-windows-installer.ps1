$ErrorActionPreference = 'Stop'

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    if (-not $env:SYNTEE_API_URL) { $env:SYNTEE_API_URL = 'https://syntee.fun' }
    if (-not $env:SYNTEE_WEB_URL) { $env:SYNTEE_WEB_URL = 'https://syntee.fun' }
    if (-not (Test-Path .\node_modules\electron\dist\electron.exe)) {
        node .\node_modules\electron\install.js
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    npm.cmd run build:sidecar
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & .\node_modules\.bin\electron-builder.cmd --win --x64 --config electron-builder.windows.yml
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
