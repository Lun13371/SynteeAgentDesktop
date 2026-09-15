// com/word — сценарии Word.Application через PowerShell COM
const { runPs, assertOk } = require('./bridge')

/** Экранирование одинарных кавычек PS-строк. */
function q(s) {
  return String(s).replace(/'/g, "''")
}

/** Открыть документ в видимом Word. */
async function openDoc(filePath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $word = New-Object -ComObject Word.Application",
    '  $word.Visible = $true',
    "  $word.Documents.Open('" + q(filePath) + "') | Out-Null",
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 30000 })
  assertOk(r, 'Word COM open')
  return true
}

/** Экспорт .docx → .pdf (Word COM ExportAsFixedFormat, формат 17 = PDF). */
async function exportPdf(srcPath, outPath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $word = New-Object -ComObject Word.Application",
    '  $word.Visible = $false',
    "  $doc = $word.Documents.Open('" + q(srcPath) + "')",
    "  $doc.ExportAsFixedFormat('" + q(outPath) + "', 17)",
    '  $doc.Close($false)',
    '  $word.Quit()',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $word.Quit() } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Word PDF export')
  return outPath
}

module.exports = { openDoc, exportPdf }
