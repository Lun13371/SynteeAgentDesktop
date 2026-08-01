import { defineConfig, externalizeDepsPlugin, bytecodePlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { obfuscate, type ObfuscatorOptions } from 'javascript-obfuscator'
import type { Plugin } from 'vite'
import { resolve } from 'path'

// ── Source-code protection ───────────────────────────────────────────────
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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), bytecodePlugin({ removeBundleJS: true })],
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
    plugins: [externalizeDepsPlugin(), bytecodePlugin({ removeBundleJS: true })]
  },
  renderer: {
    plugins: [react(), rendererObfuscatorPlugin()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
