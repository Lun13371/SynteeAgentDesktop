/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, setTimeout */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')

async function run() {
  if (process.platform !== 'linux') return console.log('SKIP Linux autostart checks require Linux')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syntee-autostart-'))
  const savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CONFIG_DIRS: process.env.XDG_CONFIG_DIRS }
  const originalTs = Module._extensions['.ts']
  Module._extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(require('node:fs').readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText, filename)
  try {
    process.env.XDG_CONFIG_HOME = path.join(root, 'user')
    process.env.XDG_CONFIG_DIRS = path.join(root, 'system')
    const { getLinuxAutostartState, setLinuxAutostart } = require('../src/main/platform/linuxAutostart.ts')
    const entry = path.join(process.env.XDG_CONFIG_HOME, 'autostart', 'com.synteehelper.app.desktop')
    assert.equal(await getLinuxAutostartState(), false)
    const systemEntry = path.join(process.env.XDG_CONFIG_DIRS, 'autostart', path.basename(entry))
    await fs.mkdir(path.dirname(systemEntry), { recursive: true })
    await fs.writeFile(systemEntry, '[Desktop Entry]\nType=Application\nExec=/usr/bin/syntee-helper\n')
    assert.equal(await getLinuxAutostartState(), true)
    await setLinuxAutostart(false, '/opt/syntee-helper/syntee-helper', [])
    assert.equal(await getLinuxAutostartState(), false, 'user Hidden=true masks system autostart')
    const executable = path.join(root, 'run $%"`\\ with spaces')
    const resultFile = path.join(root, 'received.json')
    const args = [resultFile, 'literal $HOME', 'quote" slash\\ percent% backtick`', 'кириллица']
    await fs.writeFile(executable, '#!/usr/bin/node\nrequire("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))\n', { mode: 0o755 })
    await setLinuxAutostart(true, executable, args)
    assert.equal(await getLinuxAutostartState(), true)
    const validate = spawnSync('desktop-file-validate', [entry], { encoding: 'utf8' })
    assert.equal(validate.status, 0, validate.stderr)
    const launch = spawnSync('gio', ['launch', entry], { encoding: 'utf8' })
    assert.equal(launch.status, 0, `${launch.stderr}\n${await fs.readFile(entry, 'utf8')}`)
    for (let attempt = 0; attempt < 30; attempt++) {
      try { assert.deepEqual(JSON.parse(await fs.readFile(resultFile, 'utf8')), args.slice(1)); break }
      catch (error) { if (attempt === 29) throw error; await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    await fs.appendFile(entry, 'X-GNOME-Autostart-enabled=false\n')
    assert.equal(await getLinuxAutostartState(), false)
    process.env.XDG_CONFIG_HOME = 'relative-config'
    assert.equal(require('../src/main/platform/xdg.ts').userConfigDirectory(), path.join(os.homedir(), '.config'))
    process.env.XDG_CONFIG_HOME = path.join(root, 'file')
    await fs.writeFile(process.env.XDG_CONFIG_HOME, 'unchanged')
    await assert.rejects(setLinuxAutostart(true, executable, args))
    assert.equal(await fs.readFile(process.env.XDG_CONFIG_HOME, 'utf8'), 'unchanged')
    console.log('PASS Linux autostart system fallback, toggle, atomic file, Desktop Entry validation, real Exec argument parsing and write failure')
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (originalTs) Module._extensions['.ts'] = originalTs
    else delete Module._extensions['.ts']
    await fs.rm(root, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
