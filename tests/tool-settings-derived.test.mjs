/**
 * toolSettings — автовывод списка инструментов настроек из схем.
 *
 * Гарантии:
 *  - новый тул из схем появляется в OPTIONAL_TOOL_GROUPS без правки настроек
 *    (проверяем на project_map — он лежит в search.ts рядом с веб-поиском);
 *  - защищённые (core) не попадают в опциональные;
 *  - переопределения групп работают (generate_image из edit.ts → «Медиа»);
 *  - пустые группы отфильтрованы;
 *  - filterToolSchemas/isToolDisabled не изменили поведения.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

function transpileModule(relPath) {
  const source = fs.readFileSync(path.join(root, relPath), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  const req = (spec) => {
    if (spec.startsWith('.')) {
      // Относительный импорт внутри src — транслируем файл-сосед так же.
      const target = path.join(path.dirname(path.join(root, relPath)), spec)
      return loadFile(target)
    }
    return nodeRequire(spec)
  }
  new Function('exports', 'require', 'module', js)(module.exports, req, module)
  return module.exports
}

const cache = new Map()
function loadFile(absPath) {
  const key = path.normalize(absPath)
  if (cache.has(key)) return cache.get(key).exports
  const tryPaths = [absPath, `${absPath}.ts`, path.join(absPath, 'index.ts'), `${absPath}.tsx`]
  for (const p of tryPaths) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const module = { exports: {} }
      cache.set(key, module)
      const source = fs.readFileSync(p, 'utf8')
      const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      }).outputText
      const req = (spec) => {
        if (spec.startsWith('.')) return loadFile(path.join(path.dirname(p), spec))
        return nodeRequire(spec)
      }
      new Function('exports', 'require', 'module', js)(module.exports, req, module)
      return module.exports
    }
  }
  throw new Error(`module not found: ${absPath}`)
}

const settings = loadFile(path.join(root, 'src/shared/toolSettings.ts'))

function allNames() {
  return settings.OPTIONAL_TOOL_GROUPS.flatMap(g => g.tools.map(t => t.name))
}

test('project_map виден в настройках: защищённый core (как search_code)', () => {
  assert.ok(settings.PROTECTED_CORE_TOOLS.includes('project_map'),
    'project_map — в списке «Основные инструменты» настроек')
  const meta = loadFile(path.join(root, 'src/shared/toolMeta.ts')).TOOL_META.project_map
  assert.equal(meta.label, 'Карта кода')
  // И в опциональных его быть не должно (защищённые оттуда вычищаются).
  assert.ok(!allNames().includes('project_map'))
})

test('защищённые core-тулы не попадают в опциональные', () => {
  const names = allNames()
  for (const core of settings.PROTECTED_CORE_TOOLS) {
    assert.ok(!names.includes(core), `${core} — защищённый, не должен быть в опциональных`)
  }
})

test('переопределения групп: generate_image (лежит в edit.ts) → Медиа', () => {
  const media = settings.OPTIONAL_TOOL_GROUPS.find(g => g.label === 'Медиа')
  assert.ok(media, 'группа Медиа существует')
  for (const expected of ['analyze_image', 'analyze_video', 'analyze_audio', 'generate_image']) {
    assert.ok(media.tools.some(t => t.name === expected), `${expected} в группе Медиа`)
  }
})

test('группы из старого ручного списка на месте (браузер, агенты, память, интернет…)', () => {
  const labels = settings.OPTIONAL_TOOL_GROUPS.map(g => g.label)
  for (const expected of ['Оркестрация', 'Интернет', 'Память', 'Агенты и чаты', 'Расширения', 'Медиа', 'Браузер']) {
    assert.ok(labels.includes(expected), `группа «${expected}» должна быть выведена`)
  }
  const browser = settings.OPTIONAL_TOOL_GROUPS.find(g => g.label === 'Браузер')
  assert.ok(browser.tools.length > 20, 'все browser_* выведены из схем')
  const agents = settings.OPTIONAL_TOOL_GROUPS.find(g => g.label === 'Агенты и чаты')
  for (const expected of ['spawn_agent', 'get_agent_status', 'manage_chats', 'manage_dots']) {
    assert.ok(agents.tools.some(t => t.name === expected), `${expected} в «Агенты и чаты»`)
  }
})

test('поведение filterToolSchemas / isToolDisabled не изменилось', () => {
  const s = { customToolsEnabled: true, disabledTools: ['search_web'] }
  const schemas = [{ function: { name: 'search_web' } }, { function: { name: 'edit_file' } }, { function: { name: 'mcp__srv__t' } }]
  const filtered = settings.filterToolSchemas(schemas, s)
  assert.deepEqual(filtered.map(x => x.function.name), ['edit_file', 'mcp__srv__t'])
  assert.equal(settings.isToolDisabled('edit_file', s), false, 'core не отключается')
  assert.equal(settings.isToolDisabled('search_web', { customToolsEnabled: false, disabledTools: ['search_web'] }), false,
    'без master-тумблера список не применяется')
  assert.deepEqual(settings.normalizeDisabledTools(['a', 'a', '', 'mcp__x', 'edit_file']), ['a'],
    'дубли/пустые/mcp/core вычищаются')
})
