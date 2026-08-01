import { defineConfig, externalizeDepsPlugin, bytecodePlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import JavaScriptObfuscator from 'javascript-obfuscator'
import type { Plugin } from 'vite'
import { resolve } from 'path'

const { obfuscate } = JavaScriptObfuscator
type ObfuscatorOptions = typeof JavaScriptObfuscator extends { obfuscate: (code: string, opts?: infer O) => unknown }
  ? O
  : Record<string, unknown>
// ── Source-code protection ───────────────────────────────────────────────
// Включается ТОЛЬКО через SYNTEE_PROTECT=1 (его выставляют build-release.bat
// и build-release-dev.bat). Дебаг-сборки (run.bat / run-debug.bat /
// run-prod.bat / npm run dev) идут БЕЗ защиты: читаемый JS, сорсмапы,
// быстрая сборка.
//
// main / preload : компиляция в V8-байткод (.jsc) через bytecodePlugin.
//                  removeBundleJS: true — не оставлять читаемый .js рядом
//                  с .jsc (иначе исходник утекает в app.asar как _index.js).
//                  Байткод генерируется локальным бинарником Electron, т.е.
//                  версия V8 всегда совпадает с рантаймом.
// renderer       : javascript-obfuscator, умеренный пресет — БЕЗ
//                  controlFlowFlattening / deadCodeInjection / selfDefending,
//                  чтобы не сломать mermaid/katex/React и не убить перф.
//                  Чанки, состоящие только из node_modules (публичные либы),
//                  пропускаются — защищаем только свой код.

const protect = process.env.SYNTEE_PROTECT === '1'

const RENDERER_OBFUSCATOR_OPTIONS: ObfuscatorOptions = {
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  renameProperties: false,
  stringArray: true,
  stringArrayThreshold: 0.5,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  sourceMap: false,
  target: 'browser'
}

function rendererObfuscatorPlugin(): Plugin {
  return {
    name: 'syntee-renderer-obfuscator',
    apply: 'build',
    enforce: 'post',
    renderChunk(code, chunk) {
      // Пропускаем чанки, состоящие только из node_modules (публичные либы)
      const ids = chunk.moduleIds
      if (ids.length > 0 && ids.every((id) => id.includes('node_modules'))) {
        return null
      }
      const result = obfuscate(code, RENDERER_OBFUSCATOR_OPTIONS)
      return { code: result.getObfuscatedCode(), map: null }
    }
  }
}

// ── Bake gateway URL into the main bundle ───────────────────────────────
// Vite `define` does NOT replace `process.env.*` in the main (SSR/Node) build
// because in Node `process.env` is a real runtime object, not a polyfill.
// So we do a literal text replacement via a transform plugin instead — this
// is the only reliable way to bake SYNTEE_API_URL / SYNTEE_WEB_URL into the
// packaged exe at build time. Without this, the production client falls back
// to localhost:8000 and can never reach the gateway.
// Only replaces when the env var is actually set (build-release.bat sets it);
// dev/debug runs leave the live `process.env.*` lookup in place so the
// localhost fallback keeps working.
function bakeEnvPlugin(): Plugin {
  const replacements: Record<string, string> = {}
  if (process.env.SYNTEE_API_URL) {
    replacements['process.env.SYNTEE_API_URL'] = JSON.stringify(process.env.SYNTEE_API_URL)
  }
  if (process.env.SYNTEE_WEB_URL) {
    replacements['process.env.SYNTEE_WEB_URL'] = JSON.stringify(process.env.SYNTEE_WEB_URL)
  }
  return {
    name: 'syntee-bake-env',
    apply: 'build',
    enforce: 'post',
    renderChunk(code, chunk) {
      if (Object.keys(replacements).length === 0) return null
      if (chunk.moduleIds.length > 0 && chunk.moduleIds.every((id) => id.includes('node_modules'))) {
        return null
      }
      let out = code
      let changed = false
      for (const [from, to] of Object.entries(replacements)) {
        if (out.includes(from)) {
          out = out.split(from).join(to)
          changed = true
        }
      }
      return changed ? { code: out, map: null } : null
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), bakeEnvPlugin(), ...(protect ? [bytecodePlugin({ removeBundleJS: true })] : [])],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'ai-worker': resolve('src/main/ai-worker.ts'),
        },
        external: ['web-tree-sitter', 'better-sqlite3', '@huggingface/transformers', 'onnxruntime-node'],
      },
    },
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@core': resolve('src/core'),
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), ...(protect ? [bytecodePlugin({ removeBundleJS: true })] : [])]
  },
  renderer: {
    plugins: [react(), ...(protect ? [rendererObfuscatorPlugin()] : [])],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
