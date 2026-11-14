// ── Тесты shared/fileChanges: чипы «изменённые файлы» в сообщении ────────
//
// Запуск:
//   node --experimental-strip-types --test tests/message-file-changes.test.mjs
//
// Проверяем чистую логику (без React): подсчёт +/− по unified diff, матчинг
// tool_call → tool_result по callId, склейку повторных правок одного файла,
// отсев упавших вызовов и отображение пути относительно workdir.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countDiffLines,
  collectFileChanges,
  displayFilePath,
  fileBaseName,
  sumFileChanges,
} from '../src/shared/fileChanges.ts'

const EDIT_DIFF = ['--- src/a.ts', '+++ src/a.ts', '@@ -1,3 +1,5 @@', ' keep', '-old line', '+new line', '+extra line', ' keep2', ' keep3'].join('\n')

const CREATE_DIFF = ['--- data.csv', '+++ data.csv', '@@ -0,0 +1,3 @@', '+a,b,c', '+1,2,3', '+4,5,6'].join('\n')

const call = (id, toolName, toolArgs) => ({ id: `c-${id}`, type: 'tool_call', toolName, toolArgs, content: '', timestamp: 1, callId: id })
const result = (id, toolName, extra = {}) => ({ id: `r-${id}`, type: 'tool_result', toolName, content: 'ok', success: true, timestamp: 2, callId: id, ...extra })

test('countDiffLines считает +/− и распознаёт создание файла', () => {
  assert.deepEqual(countDiffLines(EDIT_DIFF), { adds: 2, dels: 1, created: false })
  assert.deepEqual(countDiffLines(CREATE_DIFF), { adds: 3, dels: 0, created: true })
  // Пустой/отсутствующий diff — нули, не NaN
  assert.deepEqual(countDiffLines(''), { adds: 0, dels: 0, created: false })
  // Заголовки Index:/---/+++ не считаются строками изменений
  assert.deepEqual(countDiffLines('Index: x\n--- x\n+++ x\n@@ -1 +1 @@\n-a\n+b'), { adds: 1, dels: 1, created: false })
})

test('collectFileChanges берёт путь из парного tool_call по callId', () => {
  const steps = [call('1', 'edit_file', { path: 'src/a.ts' }), result('1', 'edit_file', { diff: EDIT_DIFF })]
  const files = collectFileChanges(steps)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'src/a.ts')
  assert.equal(files[0].adds, 2)
  assert.equal(files[0].dels, 1)
  assert.equal(files[0].created, false)
  assert.equal(files[0].patches.length, 1)
})

test('параллельные тулы не путают файлы (матчинг строго по callId)', () => {
  const steps = [
    call('1', 'write_file', { path: 'data.csv' }),
    call('2', 'edit_file', { path: 'src/a.ts' }),
    result('2', 'edit_file', { diff: EDIT_DIFF }),
    result('1', 'write_file', { diff: CREATE_DIFF }),
  ]
  const byPath = Object.fromEntries(collectFileChanges(steps).map(f => [f.path, f]))
  assert.equal(byPath['data.csv'].created, true)
  assert.equal(byPath['data.csv'].adds, 3)
  assert.equal(byPath['src/a.ts'].created, false)
  assert.equal(byPath['src/a.ts'].dels, 1)
})

test('повторные правки одного пути склеиваются в один чип', () => {
  const steps = [
    call('1', 'edit_file', { path: 'src/a.ts' }),
    result('1', 'edit_file', { diff: EDIT_DIFF }),
    call('2', 'edit_file', { path: 'src/a.ts' }),
    result('2', 'edit_file', { diff: EDIT_DIFF }),
  ]
  const files = collectFileChanges(steps)
  assert.equal(files.length, 1)
  assert.equal(files[0].adds, 4)
  assert.equal(files[0].dels, 2)
  assert.equal(files[0].patches.length, 2)
})

test('разные написания пути (слэши/регистр) — один файл', () => {
  const steps = [
    call('1', 'edit_file', { path: 'src/a.ts' }),
    result('1', 'edit_file', { diff: EDIT_DIFF }),
    call('2', 'edit_file', { path: 'SRC\\A.TS' }),
    result('2', 'edit_file', { diff: EDIT_DIFF }),
  ]
  assert.equal(collectFileChanges(steps).length, 1)
})

test('упавший вызов и не файловые тулы не попадают в список', () => {
  const steps = [
    call('1', 'edit_file', { path: 'src/a.ts' }),
    { ...result('1', 'edit_file', { diff: '' }), success: false },
    call('2', 'run_command', { command: 'echo hi' }),
    result('2', 'run_command'),
    call('3', 'read_file', { path: 'src/a.ts' }),
    result('3', 'read_file'),
    call('4', 'edit_file', {}),
    result('4', 'edit_file', { diff: EDIT_DIFF }),
  ]
  assert.deepEqual(collectFileChanges(steps), [])
})

test('правки внутри execute_code берутся из trace вложенных вызовов', () => {
  // У скрипта нет собственных tool_result-шагов для вложенных тулов: их
  // правки живут в codeMode.trace. Раньше они полностью терялись в чипах.
  const steps = [
    call('s', 'execute_code', { code: 'await tools.edit_file({...})' }),
    {
      ...result('s', 'execute_code'),
      codeMode: {
        code: 'x',
        trace: [
          { name: 'edit_file', args: { path: 'src/a.ts' }, result: 'ok', status: 'success', diff: EDIT_DIFF },
          { name: 'write_file', args: { path: 'data.csv' }, result: 'ok', status: 'success', diff: CREATE_DIFF },
          { name: 'edit_file', args: { path: 'src/broken.ts' }, result: 'fail', status: 'failure', diff: EDIT_DIFF },
          { name: 'run_command', args: { command: 'npm test' }, result: 'ok', status: 'success' },
        ],
      },
    },
  ]
  const byPath = Object.fromEntries(collectFileChanges(steps).map(f => [f.path, f]))
  assert.deepEqual(Object.keys(byPath).sort(), ['data.csv', 'src/a.ts'])
  assert.equal(byPath['src/a.ts'].adds, 2)
  assert.equal(byPath['src/a.ts'].dels, 1)
  assert.equal(byPath['data.csv'].created, true)
})

test('трейс execute_code с JSON-строкой args учитывает вложенную правку', () => {
  // Настоящий Agent сохраняет args как JSON-строку после sanitizeTrace.
  // Это было точной причиной: сборщик проверял typeof args === 'object' и
  // молча выбрасывал все edit_file/write_file из скрипта.
  const steps = [
    call('s', 'execute_code', { code: 'x' }),
    {
      ...result('s', 'execute_code'),
      codeMode: {
        code: 'x',
        trace: [
          {
            name: 'edit_file',
            args: JSON.stringify({ path: 'src/string-args.ts', old_str: 'before', new_str: 'after\nsecond' }),
            result: 'ok',
            status: 'success',
          },
        ],
      },
    },
  ]
  const files = collectFileChanges(steps)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'src/string-args.ts')
  assert.equal(files[0].adds, 2)
  assert.equal(files[0].dels, 1)
  assert.equal(files[0].patches.length, 1)
})

test('старый трейс без diff — правка восстанавливается из аргументов вызова', () => {
  // Записи, сохранённые до появления поля diff: вывод карточки и счётчики
  // собираются из old_str/new_str (edit_file) и content (write_file).
  const steps = [
    call('s', 'execute_code', { code: 'x' }),
    {
      ...result('s', 'execute_code'),
      codeMode: {
        code: 'x',
        trace: [
          { name: 'edit_file', args: JSON.stringify({ path: 'src/a.ts', old_str: 'old line', new_str: 'new line\nextra line' }), result: 'ok', status: 'success' },
          { name: 'write_file', args: JSON.stringify({ path: 'new.ts', content: 'a\nb' }), result: 'ok', status: 'success' },
        ],
      },
    },
  ]
  const byPath = Object.fromEntries(collectFileChanges(steps).map(f => [f.path, f]))
  assert.equal(byPath['src/a.ts'].dels, 1)
  assert.equal(byPath['src/a.ts'].adds, 2)
  assert.equal(byPath['new.ts'].adds, 2)
  assert.equal(byPath['new.ts'].created, true)
})

test('нет шагов — пустой результат (сообщение без тулов)', () => {
  assert.deepEqual(collectFileChanges(undefined), [])
  assert.deepEqual(collectFileChanges([]), [])
})

test('sumFileChanges и displayFilePath готовят данные для заголовка и чипа', () => {
  const files = [
    { path: 'src/a.ts', adds: 2, dels: 1, created: false, patches: [] },
    { path: 'C:\\proj\\data.csv', adds: 3, dels: 0, created: true, patches: [] },
  ]
  assert.deepEqual(sumFileChanges(files), { adds: 5, dels: 1, created: 1 })
  assert.equal(displayFilePath('C:\\proj\\src\\a.ts', 'C:\\proj'), 'src/a.ts')
  assert.equal(displayFilePath('src/a.ts', 'C:\\proj'), 'src/a.ts')
  assert.equal(displayFilePath('D:\\other\\b.ts', 'C:\\proj'), 'D:/other/b.ts')
  assert.equal(fileBaseName('src/components/a.ts'), 'a.ts')
  assert.equal(fileBaseName('C:\\proj\\data.csv'), 'data.csv')
})
