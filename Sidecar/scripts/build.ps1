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
    # DirectML.dll загружается onnxruntime в рантайме, когда поднимается
    # DirectML EP (GPU-режим семантики). Без неё GPU-сессия не поднимется и
    # sidecar молча откатится на CPU. Кладётся рядом с exe.
    $dml = Join-Path $sidecarRoot 'target\release\DirectML.dll'
    if (Test-Path $dml) {
        Copy-Item -Force $dml (Join-Path $staging 'DirectML.dll')
        Write-Host "Staged DirectML.dll"
    } else {
        Write-Warning "DirectML.dll not found in target\release — GPU semantic mode will fall back to CPU"
    }
    Write-Host "Built and staged: $staging\$binaryName"
} finally {
    Pop-Location
}
