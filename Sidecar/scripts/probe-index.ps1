# Диагностический прогон index → search → status против реальной БД Syntee.
#
# Пример:
#   $env:PROBE_DB      = "$env:APPDATA\SynteeHelper\syntee.db"   # копия БД, не оригинал!
#   $env:PROBE_PROJECT = '<projectId из таблицы projects>'
#   $env:PROBE_WORKDIR = 'C:\Projects\SomeProject'
#   $env:PROBE_QUERY   = 'как работают модули'
#   powershell -NoProfile -ExecutionPolicy Bypass -File Sidecar/scripts/probe-index.ps1
#
# PROBE_EXE по умолчанию — target/release/syntee-sidecar.exe.
$ErrorActionPreference = 'Stop'
$exe = if ($env:PROBE_EXE) { $env:PROBE_EXE } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'target\release\syntee-sidecar.exe' }
$db = $env:PROBE_DB
$projectId = $env:PROBE_PROJECT
$workdir = $env:PROBE_WORKDIR
$query = $env:PROBE_QUERY
if (-not $db -or -not $projectId -or -not $workdir -or -not $query) {
    throw 'PROBE_DB, PROBE_PROJECT, PROBE_WORKDIR and PROBE_QUERY must be set.'
}

$options = @{
    maxFiles = 5000
    maxFileSizeKb = 1500
    skipReferences = $false
    ignoreDirs = @('node_modules','dist','out','.git','__pycache__','.venv','build','.next','coverage','.cache','.turbo','.parcel-cache','target','.gradle','.idea','.vscode','logs','tmp')
}
$index = @{ id = 1; method = 'index'; params = @{ dbPath = $db; projectId = $projectId; workdir = $workdir; options = $options } } | ConvertTo-Json -Depth 8 -Compress
$search = @{ id = 2; method = 'search'; params = @{ dbPath = $db; projectId = $projectId; query = $query; maxFiles = 15; maxTokens = 4000 } } | ConvertTo-Json -Depth 8 -Compress
$status = @{ id = 3; method = 'status'; params = @{ } } | ConvertTo-Json -Depth 8 -Compress
$shutdown = @{ id = 4; method = 'shutdown'; params = @{ } } | ConvertTo-Json -Depth 8 -Compress
$requests = ($index, $search, $status, $shutdown) -join "`n"

$bytes = [System.Text.Encoding]::UTF8.GetBytes($requests + "`n")
$process = New-Object System.Diagnostics.Process
$process.StartInfo.FileName = $exe
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.RedirectStandardInput = $true
$process.StartInfo.RedirectStandardOutput = $true
$process.StartInfo.RedirectStandardError = $true
$process.StartInfo.CreateNoWindow = $true
[void]$process.Start()
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
$process.StandardInput.Close()
$output = $process.StandardOutput.ReadToEnd()
$errors = $process.StandardError.ReadToEnd()
$process.WaitForExit()
$timer.Stop()

Write-Output ("elapsed_ms=" + $timer.ElapsedMilliseconds)
foreach ($line in ($output -split "`n")) {
    if (-not $line.Trim()) { continue }
    $json = $line | ConvertFrom-Json
    switch ($json.id) {
        1 { Write-Output ("INDEX: " + ($json.result | ConvertTo-Json -Compress)) }
        2 {
            Write-Output ("SEARCH: indexedFilesCount=" + $json.result.indexedFilesCount + " topFiles=" + $json.result.topFiles.Count)
            foreach ($file in $json.result.topFiles) {
                $names = ($file.definitions | Select-Object -First 6 | ForEach-Object { $_.name }) -join ', '
                Write-Output ("  score=" + [Math]::Round($file.score, 2) + "  " + $file.path + "  [" + $names + "]")
            }
        }
        3 { Write-Output ("STATUS: " + ($json.result | ConvertTo-Json -Compress)) }
    }
}
if ($errors) {
    Write-Output '--- stderr ---'
    Write-Output $errors
}
