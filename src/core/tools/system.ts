import type { ToolResult } from './_shared'

export function getSystemInfo(): ToolResult {
  const os = process.platform
  const arch = process.arch
  const mem = process.memoryUsage()
  const info = [
    'OS: ' + os + ' ' + arch,
    'Node: ' + process.version,
    'Memory: ' + Math.round(mem.heapUsed/1024/1024) + 'MB / ' + Math.round(mem.heapTotal/1024/1024) + 'MB',
    'Uptime: ' + Math.round(process.uptime()) + 's',
  ].join('\n')
  return { success: true, output: info }
}
