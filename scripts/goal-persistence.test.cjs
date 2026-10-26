const fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), assert = require('node:assert/strict')
const rows = new Map()
const db = {
  exec() {},
  transaction(fn) { return fn },
  prepare(sql) {
    return {
      get(chat) { return rows.has(chat) ? { data: rows.get(chat) } : undefined },
      run(...args) {
        if (sql.startsWith('INSERT INTO chat_goals')) rows.set(args[0], args[1])
        else if (sql.startsWith('DELETE FROM chat_goals')) rows.delete(args[0])
        else if (sql.startsWith('UPDATE chat_goals')) rows.set(args[2] ?? args[1], args[0])
      },
      all() {
        if (sql.includes('FROM chat_goals')) return [...rows].map(([chat_id, data]) => ({ chat_id, data }))
        return []
      },
    }
  },
}
const goalTypesSource = fs.readFileSync(path.join(__dirname, '../src/shared/types/goal.ts'), 'utf8')
const goalTypesJs = ts.transpileModule(goalTypesSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const goalTypes = { exports: {} }
new Function('require', 'module', 'exports', goalTypesJs)(require, goalTypes, goalTypes.exports)

const source = fs.readFileSync(path.join(__dirname, '../src/core/db/taskSummaries.ts'), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', output)(id => {
  if (id === './handle') return { getDB: () => db }
  if (id === 'uuid') return { v4: () => 'id' }
  if (id.includes('taskSummary')) return { ensureTaskSummaryStateRow() {} }
  if (id === '../../shared/types/goal') return goalTypes.exports
  throw new Error(id)
}, mod, mod.exports)
const { getChatGoal, setChatGoal, recoverInterruptedTaskSummaries } = mod.exports
const goal = { id: 'goal', chatId: 'chat', objective: 'npm test exits 0', criteria: [], constraints: [], progress: [], evidence: [], status: 'running', steps: 0, maxSteps: 0, createdAt: 1, startedAt: 1, updatedAt: 1, turnsEvaluated: 0, tokensSpent: 0, idleTurns: 0 }
setChatGoal(goal)
assert.equal(getChatGoal('chat').status, 'running', 'reading a goal must NOT pause active execution')
assert.equal(getChatGoal('other'), null)
// §goal ([CC]): перезапуск приложения не снимает активную цель — следующий ход её продолжит.
recoverInterruptedTaskSummaries()
assert.equal(getChatGoal('chat').status, 'running', 'active goal survives a restart')
assert.match(getChatGoal('chat').progress.at(-1), /перезапущено/)
assert.equal(getChatGoal('chat').objective, goal.objective)
setChatGoal({ ...goal, status: 'completed', evidence: ['Ход 1 · выполнено: tests pass'] })
recoverInterruptedTaskSummaries()
assert.equal(getChatGoal('chat').status, 'completed', 'recovery preserves terminal states')
assert.equal(getChatGoal('chat').evidence[0], 'Ход 1 · выполнено: tests pass')
// Лимит раундов больше не зажимается в 12: 0 = без лимита (как в [CC]).
assert.equal(setChatGoal({ ...goal, maxSteps: 0 }).maxSteps, 0)
assert.equal(setChatGoal({ ...goal, maxSteps: 50 }).maxSteps, 50)
// Условие цели — одна строка до 4000 символов.
assert.equal(setChatGoal({ ...goal, objective: 'x'.repeat(5000) }).objective.length, 4000)
// Цель старой версии без новых полей читается без падения.
rows.set('chat', JSON.stringify({ id: 'g', chatId: 'chat', objective: 'legacy', criteria: [], constraints: [], progress: [], evidence: [], status: 'running', steps: 0, maxSteps: 5, createdAt: 1, updatedAt: 1 }))
assert.equal(getChatGoal('chat').turnsEvaluated, 0)
assert.equal(getChatGoal('chat').startedAt, 1)
setChatGoal(null, 'chat')
assert.equal(getChatGoal('chat'), null)
console.log('goal persistence regressions passed')