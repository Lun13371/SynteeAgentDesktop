// Копирует prebuilt tree-sitter WASM файлы в resources/tree-sitter/
// для упаковки в electron-builder (extraResources) и загрузки в runtime.
// Запускается из postinstall. Idempotent.

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const destDir = path.join(root, 'resources', 'tree-sitter')

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function copyIfExists(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest)
    return true
  }
  console.warn(`[copy-tree-sitter-wasms] WARN: source not found: ${src}`)
  return false
}

function main() {
  ensureDir(destDir)

  let copied = 0

  // 1. web-tree-sitter runtime WASM (0.25.x: tree-sitter.wasm; 0.26.x: web-tree-sitter.wasm)
  const wtsSrc = path.join(root, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm')
  if (copyIfExists(wtsSrc, path.join(destDir, 'web-tree-sitter.wasm'))) copied++
  const tsSrc = path.join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
  if (copyIfExists(tsSrc, path.join(destDir, 'tree-sitter.wasm'))) copied++

  // 2. Grammar WASMs из tree-sitter-wasms/out
  const grammarDir = path.join(root, 'node_modules', 'tree-sitter-wasms', 'out')
  if (fs.existsSync(grammarDir)) {
    const files = fs.readdirSync(grammarDir).filter(f => f.endsWith('.wasm'))
    for (const f of files) {
      fs.copyFileSync(path.join(grammarDir, f), path.join(destDir, f))
      copied++
    }
  } else {
    console.warn(`[copy-tree-sitter-wasms] WARN: grammar dir not found: ${grammarDir}`)
  }

  console.log(`[copy-tree-sitter-wasms] copied ${copied} wasm files to ${path.relative(root, destDir)}`)
}

main()
