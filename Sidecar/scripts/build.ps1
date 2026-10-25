$ErrorActionPreference = 'Stop'

$sidecarRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $sidecarRoot
$binaryName = 'syntee-sidecar.exe'
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    throw 'cargo was not found on PATH. Install Rust MSVC and restart the terminal.'
}

Push-Location $sidecarRoot
try {
    & $cargo.Source build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
    $built = Join-Path $sidecarRoot "target\release\$binaryName"
    if (-not (Test-Path $built)) { throw "Cargo completed but binary was not found: $built" }
    $staging = Join-Path $repoRoot 'resources\sidecar'
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Copy-Item -Force $built (Join-Path $staging $binaryName)
    Write-Host "Built and staged: $staging\$binaryName"
} finally {
    Pop-Location
}
