param(
  [Parameter(Mandatory = $true)][string]$Docx,
  [Parameter(Mandatory = $true)][string]$Pdf
)

# Convert .docx to .pdf via MS Word COM automation (Study Docs plugin).
$ErrorActionPreference = 'Stop'
$word = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($Docx, $false, $true)
  # 17 = wdExportFormatPDF
  $doc.ExportAsFixedFormat($Pdf, 17)
  $doc.Close($false)
  Write-Output "OK: $Pdf"
  exit 0
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($word) { $word.Quit() | Out-Null }
}
