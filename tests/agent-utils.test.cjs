/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Read project source. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

// utils.ts тянет contextManager с extensionless-импортами (Node ESM их не
// резолвит), поэтому проверяем контракт по исходнику — как другие тесты
// рендерера в этом репозитории.
const source = readFileSync('src/core/agent/utils.ts', 'utf8')

test('edit_file: пустой new_str — легальное удаление, а не «missing arg»', () => {
  assert.ok(source.includes("const EMPTY_STRING_ALLOWED = new Set(['edit_file:new_str'])"))
  assert.ok(source.includes('if (value === \'\') return !EMPTY_STRING_ALLOWED.has(`${name}:${key}`)'))
  // Инлайновая проверка «=== '' = missing» больше не должна фильтровать required.
  assert.ok(!source.includes("args[key] === null || args[key] === '')"))
})

test('schema: new_str документирован как обязательный, но допускает пустую строку', () => {
  const schema = readFileSync('src/shared/toolSchemas/edit.ts', 'utf8')
  assert.ok(schema.includes('Pass empty string "" to delete old_str'))
  assert.ok(schema.includes("required: ['path', 'old_str', 'new_str']"))
})

test('fileEdit принимает пустой new_str (проверка только на undefined)', () => {
  const impl = readFileSync('src/core/tools/fileEdit.ts', 'utf8')
  assert.ok(impl.includes('if (params.new_str === undefined)'))
  assert.ok(!impl.includes('if (!params.new_str)'))
})
