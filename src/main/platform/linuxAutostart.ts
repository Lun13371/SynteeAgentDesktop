import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { userConfigDirectory } from './xdg'

const ENTRY_NAME = 'com.synteehelper.app.desktop'

function entryFile(configDirectory: string): string {
  return join(configDirectory, 'autostart', ENTRY_NAME)
}

export async function getLinuxAutostartState(): Promise<boolean> {
  const systemConfig = (process.env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter(isAbsolute)
  for (const directory of [userConfigDirectory(), ...systemConfig]) {
    try {
      const file = entryFile(directory)
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > 8192) return false
      const entry = await fs.readFile(file, 'utf8')
      return /^Exec=.+/m.test(entry) && !/^Hidden=true\s*$/m.test(entry) && !/^X-GNOME-Autostart-enabled=false\s*$/m.test(entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return false
}

// Desktop Entry unescapes its string value before parsing the quoted Exec arguments.
function quoteExecArgument(arg: string): string {
  const escaped = arg.replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%')
  return `"${escaped.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`
}

export async function setLinuxAutostart(enabled: boolean, executable: string, args: string[]): Promise<void> {
  const location = entryFile(userConfigDirectory())
  // Keep a fixed executable before field-code expansion, including paths containing "%".
  const exec = ['/usr/bin/env', executable, ...args].map(quoteExecArgument).join(' ')
  // Hidden explicitly masks a system-wide desktop entry with the same ID.
  const entry = `[Desktop Entry]\nType=Application\nName=Syntee Helper\nExec=${exec}\nTerminal=false\nHidden=${!enabled}\n`
  const temporary = `${location}.${randomUUID()}.tmp`
  await fs.mkdir(dirname(location), { recursive: true })
  try {
    await fs.writeFile(temporary, entry, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, location)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}
