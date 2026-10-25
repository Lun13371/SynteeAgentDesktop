$ErrorActionPreference = 'Stop'

$sidecarRoot = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $sidecarRoot 'target\release\syntee-sidecar.exe'
if (-not (Test-Path $binary)) {
    throw "Sidecar binary not found. Run scripts/build.ps1 first."
}

$requests = @(
    '{"id":1,"method":"health","params":{}}',
    '{"id":2,"method":"capabilities","params":{}}',
    '{"id":3,"method":"tokensCount","params":{"text":"Hello, world!"}}',
    '{"id":4,"method":"tokensTruncate","params":{"text":"one two three four","maxTokens":2}}',
    '{"id":5,"method":"symbols","params":{"path":"src/ast.rs","skipReferences":true}}',
    '{"id":6,"method":"shutdown","params":{}}'
) -join "`n"

# PowerShell 5.1 can emit a UTF-8 BOM when piping strings. The runtime accepts
# a BOM on the first JSONL line, but writing explicit UTF-8 bytes is portable.
$bytes = [System.Text.Encoding]::UTF8.GetBytes($requests + "`n")
$process = New-Object System.Diagnostics.Process
$process.StartInfo.FileName = $binary
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.RedirectStandardInput = $true
$process.StartInfo.RedirectStandardOutput = $true
$process.StartInfo.RedirectStandardError = $true
$process.StartInfo.CreateNoWindow = $true
[void]$process.Start()
$process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
$process.StandardInput.Close()
$output = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
$output | Write-Output
if ($process.ExitCode -ne 0) {
    throw "Sidecar smoke test failed with exit code $($process.ExitCode)"
}
