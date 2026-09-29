// Ребилд better-sqlite3 под УСТАНОВЛЕННУЮ версию Electron.
//
// Раньше target был захардкожен в package.json ("--target=36.0.0") — при
// апгрейде Electron его забывали менять, better-sqlite3 собирался под чужой
// ABI и падал в рантайме ("was compiled against a different Node.js version").
// Этот скрипт читает версию из node_modules/electron/package.json, так что
// target всегда совпадает с фактически установленным Electron.
//
// Запускается из postinstall ПОСЛЕ electron-builder install-app-deps
// (см. коммит aeeb0ef — ручной ребилд был добавлен как фикс ABI-мисматча).
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let electronVersion
try {
  electronVersion = require('electron/package.json').version
} catch {
  console.error('[rebuild-better-sqlite3] electron не установлен — пропускаю ребилд')
  process.exit(0)
}

console.log(`[rebuild-better-sqlite3] target electron v${electronVersion}`)
execSync(
  `npm rebuild better-sqlite3 --runtime=electron --target=${electronVersion} --dist-url=https://electronjs.org/headers`,
  { stdio: 'inherit', shell: true }
)
