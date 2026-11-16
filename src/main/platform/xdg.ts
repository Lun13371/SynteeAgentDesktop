import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export function userConfigDirectory(): string {
  const configured = process.env.XDG_CONFIG_HOME
  return configured && isAbsolute(configured) ? configured : join(homedir(), '.config')
}
