/**
 * §project-map-prompt — карта кода должна попадать в промпт одним правилом.
 *
 * Гарантии:
 *  - правило выбора инструмента живёт в СТАТИЧНОМ префиксе (кеш не рвётся),
 *    а не в session_context, который системный промпт объявляет фоном;
 *  - в промпте нет прежнего противоречия «сначала search_code/read_file»;
 *  - динамический блок отдаёт только состояние индекса, без списка actions;
 *  - read-only роли суб-агентов получают project_map, а подсказка выдаётся
 *    только когда есть проект и сам тул (иначе модель зовёт несуществующее);
 *  - тул вырезается у суб-агента без projectId (иначе он всегда падает).
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
const cache = new Map()

function load(relPath) {
  const abs = path.resolve(root, relPath)
  if (cache.has(abs)) return cache.get(abs)
  const source = fs.readFileSync(abs, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  const req = (spec) => {
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(abs), spec)
      for (const candidate of [target, `${target}.ts`, path.join(target, 'index.ts')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return load(path.relative(root, candidate))
        }
      }
    }
    return nodeRequire(spec)
  }
  new Function('exports', 'require', 'module', js)(module.exports, req, module)
  cache.set(abs, module.exports)
  return module.exports
}

function readSource(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8')
}

const guidance = load('src/shared/codeNavigationGuidance.ts')
const { buildCodeModeBlock } = load('src/core/prompts/sections/codeModeSection.ts')
const { buildProjectMapBlock } = load('src/core/prompts/sections/projectMapSection.ts')
const { SUBAGENT_ROLES } = load('src/shared/subagent-roles.ts')

// ─── 1. Политика — в статичном префиксе ────────────────────────────────────

test('code-navigation policy sits in the static prefix, not in session context', () => {
  const empty = () => ''
  const builder = load('src/core/prompts/buildSystemPrompt.ts')
  const parts = builder.buildSystemPromptParts({
    projectMap: { state: 'ready', files: 822, nodes: 10389, edges: 40770 },
  })

  assert.ok(parts.staticPart.includes(guidance.PROJECT_MAP_GUIDANCE), 'static prefix carries the policy')
  assert.ok(!parts.dynamicPart.includes(guidance.PROJECT_MAP_GUIDANCE), 'dynamic tail must not repeat the policy')
  assert.ok(parts.dynamicPart.includes('822 indexed files'), 'dynamic tail reports index state')
  assert.ok(empty() === '', 'sanity')
})

test('the old conflicting "search_code first" rule is gone', () => {
  const codeMode = buildCodeModeBlock('/tmp/project')
  assert.ok(!/For unfamiliar code, locate relevant files with search_code or find_files/.test(codeMode))
  assert.ok(!/BEFORE search_code\/read_file/.test(codeMode))
  assert.ok(/For exact text use search_code/.test(codeMode), 'exact-text case still points at search_code')
  assert.ok(/for file names use find_files/.test(codeMode))
})

// ─── 2. Динамический блок — только состояние ───────────────────────────────

test('project map block reports state only', () => {
  const ready = buildProjectMapBlock({ state: 'ready', files: 822, nodes: 10389, edges: 40770 })
  assert.match(ready, /ready: 822 indexed files, 10389 nodes, 40770 edges/)
  assert.ok(!/action=/.test(ready), 'no action catalogue in the session tail')
  assert.ok(!/\(some files/.test(ready), 'ready index carries no coverage caveat')

  const partial = buildProjectMapBlock({ state: 'building', files: 10, nodes: 40, edges: 60 })
  assert.match(partial, /some files or relationships may be missing/)

  assert.equal(buildProjectMapBlock(undefined), '', 'no project — no dead line in the tail')
  assert.match(buildProjectMapBlock({ state: 'idle', files: 0, nodes: 0, edges: 0 }), /unavailable/)
  assert.match(buildProjectMapBlock({ state: 'error', files: 3, nodes: 0, edges: 0 }), /unavailable/)
})

// ─── 3. Суб-агенты ─────────────────────────────────────────────────────────

test('read-only sub-agent roles can reach the map', () => {
  for (const role of ['researcher', 'deep-researcher', 'editor', 'reviewer']) {
    assert.ok(SUBAGENT_ROLES[role].allowedTools.includes('project_map'), `${role} must allow project_map`)
  }
})

test('sub-agent guidance appears only when both the project and the tool exist', () => {
  const { buildSubagentMapGuidance } = guidance
  assert.equal(buildSubagentMapGuidance({ hasProject: false, hasMapTool: true, isolatedWorktree: false }), '')
  assert.equal(buildSubagentMapGuidance({ hasProject: true, hasMapTool: false, isolatedWorktree: false }), '')

  const shared = buildSubagentMapGuidance({ hasProject: true, hasMapTool: true, isolatedWorktree: false })
  assert.ok(shared.includes(guidance.PROJECT_MAP_GUIDANCE))
  assert.ok(!/isolated worktree/.test(shared))

  const worktree = buildSubagentMapGuidance({ hasProject: true, hasMapTool: true, isolatedWorktree: true })
  assert.match(worktree, /isolated worktree/)
  assert.match(worktree, /verify paths and current code in your worktree/)
})

test('sub-agent tool list drops project_map when the run has no project', () => {
  const src = readSource('src/main/managers/AgentManager.ts')
  assert.match(src, /s\.function\.name !== 'project_map' \|\| !!context\?\.projectId/,
    'project_map must be filtered out without a projectId')
  assert.match(src, /buildSubagentMapGuidance\(\{/, 'guidance is injected from the resolved tool set')
})
