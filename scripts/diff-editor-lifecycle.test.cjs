/* eslint-disable @typescript-eslint/no-require-imports -- Node harness exercises React cleanup with model ownership. */
/* global require, __dirname */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = readFileSync(join(__dirname, '../src/renderer/src/components/ui/SafeDiffEditor/MonacoDiffEditor.tsx'), 'utf8')
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText

function harness() {
  const refs = []
  const frames = []
  const events = []
  let refIndex = 0
  let cleanup
  let models
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    requestAnimationFrame: fn => frames.push(fn),
    require: name => {
      if (name === 'react') return {
        useRef: value => refs[refIndex++] ?? (refs[refIndex - 1] = { current: value }),
        useEffect: (effect, dependencies) => {
          if (dependencies.length) effect()
          else cleanup ??= effect()
        }
      }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) }
      if (name === '@monaco-editor/react') return { DiffEditor() {}, loader: { config() {} } }
      if (name === 'monaco-editor') return {}
      throw Error(`Unexpected module ${name}`)
    }
  })
  const editor = {
    getModel: () => models,
    setModel: value => { events.push('detach'); models = value },
    dispose: () => events.push('widget')
  }
  return {
    events,
    render(props = {}) {
      refIndex = 0
      return module.exports.default(props)
    },
    mount(element) {
      models = {
        original: { dispose: () => events.push('original') },
        modified: { dispose: () => events.push('modified') }
      }
      element.props.onMount(editor, {})
    },
    unmount() { cleanup() },
    flushFrame() { frames.splice(0).forEach(fn => fn()) }
  }
}

test('diff unmount releases detached models and defers widget disposal', () => {
  const h = harness()
  let forwarded = false
  h.mount(h.render({ onMount: () => { forwarded = true } }))
  assert.equal(forwarded, true)
  h.unmount()
  assert.deepEqual(h.events, ['detach', 'original', 'modified'])
  h.flushFrame()
  assert.deepEqual(h.events, ['detach', 'original', 'modified', 'widget'])
})

test('caller model retention flags are honored individually', () => {
  for (const original of [false, true]) {
    for (const modified of [false, true]) {
      const h = harness()
      h.mount(h.render({ keepCurrentOriginalModel: original, keepCurrentModifiedModel: modified }))
      h.unmount()
      assert.equal(h.events.includes('original'), !original)
      assert.equal(h.events.includes('modified'), !modified)
    }
  }
})

test('cleanup observes the latest retention flags', () => {
  const h = harness()
  h.mount(h.render())
  h.render({ keepCurrentOriginalModel: true })
  h.unmount()
  assert.deepEqual(h.events, ['detach', 'modified'])
})

test('unmount before editor initialization is harmless', () => {
  const h = harness()
  h.render()
  assert.doesNotThrow(() => h.unmount())
  assert.deepEqual(h.events, [])
})
