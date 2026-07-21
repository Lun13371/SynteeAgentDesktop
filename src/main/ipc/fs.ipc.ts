import { ipcMain } from 'electron'
import { readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from 'fs/promises'
import { join, resolve as pathResolve, relative, sep } from 'path'
import { getChatWorkdirContext } from '../../core/db/database'

const DEFAULT_IGNORE_DIRS = new Set(['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build', '.next', 'coverage', '.cache'])

export interface FsEntry {
  name: string
  path: string
  relPath: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtime: number
}

export interface FsTreeEntry extends FsEntry {
  children?: FsEntry[]
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle: { read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> } | undefined
  try {
    const { open } = await import('fs/promises')
    handle = await open(filePath, 'r') as unknown as { read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> }
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buf, 0, 8192, 0)
    return buf.slice(0, bytesRead).includes(0)
  } catch {
    return false
  } finally {
    if (handle) await handle.close()
  }
}

function safeJoin(root: string, relativePath: string): string | null {
  const resolved = pathResolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null
  }
  return resolved
}

export function registerFsIPC(): void {
  ipcMain.handle('fs:getWorkdir', async (_e, chatId: string) => {
    if (!chatId) return null
    try {
      const ctx = getChatWorkdirContext(chatId)
      return ctx.workdir ?? null
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:listDirectory', async (_e, params: { root: string; relPath?: string; maxEntries?: number }) => {
    const root = params.root
    if (!root) return { success: false, entries: [], error: 'root is required' }
    const relPath = params.relPath ?? ''
    const dirPath = safeJoin(root, relPath)
    if (!dirPath) return { success: false, entries: [], error: 'Path outside root' }

    try {
      const names = await fsReaddir(dirPath)
      const entries: FsEntry[] = []
      const max = params.maxEntries ?? 500
      for (const name of names) {
        if (entries.length >= max) break
        if (DEFAULT_IGNORE_DIRS.has(name)) continue
        if (name.startsWith('.') && name !== '.env' && name !== '.gitignore') continue
        const fullPath = join(dirPath, name)
        try {
          const st = await fsStat(fullPath)
          entries.push({
            name,
            path: fullPath,
            relPath: relative(root, fullPath).split(sep).join('/'),
            isDir: st.isDirectory(),
            isSymlink: st.isSymbolicLink(),
            size: st.size,
            mtime: st.mtimeMs,
          })
        } catch {
          // пропускаем недоступные элементы
        }
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
      return { success: true, entries }
    } catch (e) {
      return { success: false, entries: [], error: String((e as Error)?.message ?? e) }
    }
  })

  ipcMain.handle('fs:readFile', async (_e, params: { root: string; relPath: string; maxBytes?: number }) => {
    const root = params.root
    if (!root) return { success: false, content: '', error: 'root is required' }
    const filePath = safeJoin(root, params.relPath)
    if (!filePath) return { success: false, content: '', error: 'Path outside root' }

    const maxBytes = params.maxBytes ?? 512 * 1024
    try {
      const st = await fsStat(filePath)
      if (st.isDirectory()) return { success: false, content: '', error: 'Is a directory' }
      if (st.size > maxBytes * 4) return { success: false, content: '', error: `File too large (${(st.size / 1024).toFixed(1)} KB). Max ${(maxBytes * 4 / 1024).toFixed(0)} KB.` }
      const binary = await isBinaryFile(filePath)
      if (binary) return { success: false, content: '', error: 'Binary file', isBinary: true, size: st.size }
      const buf = await fsReadFile(filePath)
      const truncated = buf.length > maxBytes
      const content = truncated ? buf.slice(0, maxBytes).toString('utf8') : buf.toString('utf8')
      return { success: true, content, truncated, size: st.size, mtime: st.mtimeMs }
    } catch (e) {
      return { success: false, content: '', error: String((e as Error)?.message ?? e) }
    }
  })
}
