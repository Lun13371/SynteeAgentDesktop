<#
.SYNOPSIS
    Замер размера кодовой базы SynteeAgentDesktop.
.DESCRIPTION
    Считает файлы и строки по зонам и расширениям, распределение по размеру,
    hot spots (> 600 строк), вес на диске и базовую статистику git.
    Без node_modules / Sidecar\target / dist / out / .git.
.EXAMPLE
    powershell -NoProfile -File scripts/code-stats.ps1
    powershell -NoProfile -File scripts/code-stats.ps1 -HotSpotThreshold 500
#>
param(
    [int]$HotSpotThreshold = 600,
    [int]$TopFiles = 25
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$exclude = 'node_modules|\\dist\\|\\out\\|\\build\\|\\\.git\\|\\target\\|\\\.syntee\\|\\release|resources\\sidecar'
$extensions = @('*.ts', '*.tsx', '*.js', '*.cjs', '*.mjs', '*.css', '*.rs', '*.py')

function Write-Header([string]$text) {
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkGray
    Write-Host " $text" -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor DarkGray
}

Write-Header "SynteeAgentDesktop — code stats ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))"

$files = Get-ChildItem -Path $root -Recurse -File -Force -Include $extensions |
    Where-Object { $_.FullName -notmatch $exclude }

$rows = foreach ($f in $files) {
    $rel = $f.FullName.Substring($root.Length).TrimStart('\')
    $parts = $rel -split '\\'
    $area = if ($parts[0] -eq 'src' -and $parts.Count -ge 2) { "src\$($parts[1])" }
            elseif ($parts[0] -eq 'src') { 'src (root)' }
            else { $parts[0] }
    [pscustomobject]@{
        Path  = $rel
        Area  = $area
        Ext   = $f.Extension.ToLower()
        Lines = (Get-Content -LiteralPath $f.FullName | Measure-Object -Line).Lines
    }
}

$totalFiles = $rows.Count
$totalLines = ($rows | Measure-Object Lines -Sum).Sum
$avg = if ($totalFiles) { [math]::Round($totalLines / $totalFiles, 1) } else { 0 }

Write-Header 'ИТОГО'
Write-Host ("Файлов: {0}   Строк: {1:N0}   Средний файл: {2}" -f $totalFiles, $totalLines, $avg)

Write-Header 'ПО ЗОНАМ'
$rows | Group-Object Area |
    ForEach-Object {
        [pscustomobject]@{
            Area  = $_.Name
            Files = $_.Count
            LOC   = ($_.Group | Measure-Object Lines -Sum).Sum
            Share = if ($totalLines) { '{0:N1}%' -f (($_.Group | Measure-Object Lines -Sum).Sum / $totalLines * 100) } else { '0%' }
        }
    } | Sort-Object { [int]($_.LOC) } -Descending | Format-Table -AutoSize

Write-Header 'ПО РАСШИРЕНИЯМ'
$rows | Group-Object Ext |
    ForEach-Object {
        [pscustomobject]@{
            Ext   = $_.Name
            Files = $_.Count
            Lines = ($_.Group | Measure-Object Lines -Sum).Sum
        }
    } | Sort-Object Lines -Descending | Format-Table -AutoSize

Write-Header 'РАСПРЕДЕЛЕНИЕ ПО РАЗМЕРУ'
@(
    [pscustomobject]@{ Range = '> 2000';      Files = ($rows | Where-Object Lines -gt 2000).Count }
    [pscustomobject]@{ Range = '1000-2000';   Files = ($rows | Where-Object { $_.Lines -le 2000 -and $_.Lines -gt 1000 }).Count }
    [pscustomobject]@{ Range = '600-1000';    Files = ($rows | Where-Object { $_.Lines -le 1000 -and $_.Lines -gt 600 }).Count }
    [pscustomobject]@{ Range = '300-600';     Files = ($rows | Where-Object { $_.Lines -le 600 -and $_.Lines -gt 300 }).Count }
    [pscustomobject]@{ Range = '<= 300';      Files = ($rows | Where-Object Lines -le 300).Count }
) | Format-Table -AutoSize

Write-Header "HOT SPOTS (> $HotSpotThreshold строк)"
$rows | Where-Object Lines -gt $HotSpotThreshold | Sort-Object Lines -Descending |
    Select-Object Lines, Path | Format-Table -AutoSize

Write-Header "ТОП-$TopFiles САМЫХ БОЛЬШИХ ФАЙЛОВ"
$rows | Sort-Object Lines -Descending | Select-Object -First $TopFiles Lines, Path | Format-Table -AutoSize

Write-Header 'ВЕС НА ДИСКЕ'
$nm = (Get-ChildItem (Join-Path $root 'node_modules') -Recurse -File -Force | Measure-Object Length -Sum)
$tg = (Get-ChildItem (Join-Path $root 'Sidecar\target') -Recurse -File -Force | Measure-Object Length -Sum)
$all = (Get-ChildItem $root -Recurse -File -Force | Measure-Object Length -Sum)
[pscustomobject]@{
    Item        = 'node_modules'
    MB          = if ($nm.Sum) { [math]::Round($nm.Sum / 1MB, 0) } else { 0 }
    Files       = $nm.Count
} | Format-Table -AutoSize
[pscustomobject]@{
    Item        = 'Sidecar/target'
    MB          = if ($tg.Sum) { [math]::Round($tg.Sum / 1MB, 0) } else { 0 }
    Files       = $tg.Count
} | Format-Table -AutoSize
[pscustomobject]@{
    Item        = 'WHOLE DIR'
    MB          = if ($all.Sum) { [math]::Round($all.Sum / 1MB, 0) } else { 0 }
    Files       = $all.Count
} | Format-Table -AutoSize

Write-Header 'GIT'
if (Test-Path (Join-Path $root '.git')) {
    Write-Host ("Коммитов: {0}" -f (git rev-list --count HEAD))
    Write-Host ("Трекнутых файлов: {0}" -f (git ls-files | Measure-Object).Count)
    Write-Host ("Веток: {0}   Тегов: {1}" -f (git branch -a | Measure-Object).Count, (git tag | Measure-Object).Count)
    Write-Host ''
    Write-Host 'Коммиты по месяцам:'
    git log --format='%ad' --date=format:'%Y-%m' | Group-Object | Sort-Object Name -Descending |
        Select-Object -First 8 Count, Name | Format-Table -AutoSize
} else {
    Write-Host 'git не найден' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Готово.' -ForegroundColor Green
