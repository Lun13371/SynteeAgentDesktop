# Исследование: что нужно AI-агенту для хорошей работы

> Дата: 04.08.2026
> Проект: SynteeHelper
> Цель: понять, что делает AI-агента эффективным (программно и промптом), что уже есть в SynteeHelper, чего не хватает, и как улучшить.

---

## 1. Ключевые исследования

### Anthropic — "Effective Context Engineering" (декабрь 2025)
Главный вывод: **"Prompt engineering" мёртв, "context engineering" — король.** Качество агента зависит не от текста system prompt, а от того, **какой контекст подаётся в модель в каждый момент**.

| Принцип | Суть | В SynteeHelper |
|---|---|---|
| Compaction | Сжатие истории до summary при приближении к лимиту | ✅ (rolling window + emergency valve) |
| Tool clearing | Очистка старых tool_results из контекста | ⚠️ Частично (dropOldestRoundsIfOverflow) |
| Few-shot examples | Примеры в prompt улучшают tool selection | ⚠️ Только для memory |
| Context window as "RAM" | Контекст — дефицитный ресурс, нужно управлять | ✅ (usageTracker, breakdown) |

Источник: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

### Andrew Ng — 4 agentic design patterns (2024-2025)
| Паттерн | Суть | В SynteeHelper |
|---|---|---|
| **Reflection** | AI критикует свой ответ и улучшает | ❌ **Нет** |
| Tool use | AI вызывает инструменты | ✅ |
| Planning | AI разбивает задачу на шаги | ✅ (planning mode + update_todo) |
| Multi-agent collaboration | Агенты работают параллельно | ✅ (spawn_agent + worktree) |

### SWE-bench / Terminal-bench 2026 — что работает у лидеров
Лидеры (Claude Opus 4.7 — 87.6%, GPT-5.3 Codex — 85%, Gemini 3.1 Pro — 80.6%) используют:
- Multi-step reasoning (chain-of-thought) — ✅ есть
- Tool calling со строгими схемами — ✅ есть
- Self-verification перед ответом — ⚠️ частично
- Error recovery с retry + different strategy — ⚠️ есть loop guard, но нет reflection
- Context management (compaction) — ✅ есть

### Memory research (arXiv:2502.06975, "Episodic Memory is the Missing Piece for Long-Term LLM Agents")
5 свойств эпизодической памяти:
1. Long-term storage (persistence) — ✅ SQLite memory_items
2. Explicit reasoning (reflect on memory) — ⚠️ recall_memory, но не auto
3. Single-shot learning — ✅ save_memory
4. Temporal ordering — ✅ createdAt/timestamps
5. Selective retrieval — ✅ 5-source search, scope filter

### Self-improving agents (NeurIPS 2025, "A Self-Improving Coding Agent", arXiv:2504.15228)
Агенты, которые **извлекают уроки из своих действий**, работают на 15-30% лучше на повторяющихся задачах.

В SynteeHelper есть `outcomeExtractor.ts` — **редкая фича**, но работает **постфактум** (после сессии), а не **в реальном времени**.

---

## 2. Что уже хорошо в SynteeHelper

### ✅ ReAct loop
`src/core/agent/Agent.ts:190-956` — классический ReAct: reasoning → tool_call → tool_result → снова reasoning.

### ✅ Planning mode (4-step protocol)
`src/core/prompts/buildSystemPrompt.ts:435-516` — Assess scope (S/M/L) → Research → Write plan → Review. Сильнее чем у Cline, на уровне Claude Code.

### ✅ Loop guard с hard block
`Agent.ts:75-79, 488-554` — 3 уровня: warning → warning → hard block. Ловит и прямые повторы, и чередования (A-B-A-B). У Claude Code только warning.

### ✅ Error fingerprinting
`Agent.ts:736-764` — повторяющиеся ошибки с тем же fingerprint → stop (circuit breaker pattern).

### ✅ Auto-verification
`Agent.ts:794-809` — `verificationCommand` запускается после N успешных edit'ов.

### ✅ Context management
- `src/core/tokens/usageTracker.ts` — точный подсчёт токенов (tiktoken cl100k_base)
- `dropOldestRoundsIfOverflow` — аварийный клапан
- `src/core/context/contextManager.ts` — rolling window с trigger %

### ✅ Memory system
5 типов памяти, 5 источников recall, scope-фильтрация, dedup, decay. Уникальная система.

### ✅ Sub-agents с worktree isolation
`spawn_agent` + `src/main/WorktreeIsolation.ts` — параллельные агенты в git worktree.

### ✅ Tool selection guidance
System prompt подробно описывает, когда какой тул использовать.

---

## 3. Чего не хватает — и как добавить

### 🔴 P0-1. Self-Reflection Pass (критично)
**Проблема:** AI выдаёт ответ без самопроверки. Reflection добавляет 10-30% к качеству (Andrew Ng, Wharton 2025).
**Что есть:** Инструкция в system prompt (строка 425-432), но нет механизма.

**Решение (программно)** — reflection gate в `Agent.ts` перед `callbacks.onDone`:
```ts
// Если был хотя бы 1 tool_call и ответ >200 символов:
if (response.tool_calls?.length > 0 && answer.length > 200 && !signal?.aborted) {
  const reflectionPrompt = `Before giving this answer, verify:
1. Did you actually DO what was asked, or just describe it?
2. Did you check for TypeScript/lint errors (get_diagnostics)?
3. Are there any uncommitted side effects (files changed but not verified)?
4. Is the answer complete, or did you skip a step from the plan?

If you find an issue — fix it now with another tool call.
If everything is good — give the answer as-is.`
  messages.push({ role: 'user', content: reflectionPrompt })
  continue  // даём шанс ещё раз вызвать тул
}
```

**Альтернатива (промптом):** Усилить секцию "Verification" в system prompt:
```
## CRITICAL: Self-verification protocol
Before your final answer, you MUST:
1. If you edited code → call get_diagnostics (no exceptions)
2. If you ran commands → verify exit code was 0
3. If you had a plan → check every [ ] item is [x]
4. If you skipped any step → say so explicitly
NEVER claim "done" without verification.
```

---

### 🔴 P0-2. Proactive Recall при старте задачи
**Проблема:** AI не вызывает `recall_memory` автоматически. Инструкция есть, но модель может забыть.

**Решение (программно):** Автоматический recall перед первым tool_call'ом:
```ts
// Agent.ts, перед первым chatWithTools, если это первый turn чата:
if (history?.length === 0 && this.projectId) {
  const recallResults = await autoRecallMemory(userMessage, this.projectId)
  if (recallResults) {
    messages.splice(1, 0, {
      role: 'system',
      content: `[Auto-recalled memory]\n${recallResults}`
    })
  }
}
```

---

### 🟡 P1-3. Progressive Summarization (не только emergency)
**Проблема:** Compaction работает только при лимите (реактивный). Нужен proactive compaction при ~70% контекста.
**Что есть:** `dropOldestRoundsIfOverflow` — реактивный клапан. Rolling window дропает, но не суммаризирует.

**Решение (программно):**
```ts
const contextUsage = snap.estimated / realContextWindow
if (contextUsage > 0.7 && !this.summarizedOldRounds) {
  const summary = await summarizeOldRounds(messages, fastContextModel)
  messages.splice(1, midPoint, { role: 'system', content: `[Summary of earlier work]\n${summary}` })
  this.summarizedOldRounds = true
}
```
У Claude Code auto-compact at 95%. Промежуточный вариант (70% → proactive summary) будет лучше обоих.

---

### 🟡 P1-4. Tool Result Dedup / Caching
**Проблема:** AI может повторно читать тот же файл/вызывать тот же тул.
**Что есть:** `readFileCache` и `fileCache` (mtime-based) — только для read_file.
**Чего нет:** Dedup для других тулов (search_code, http_request).

**Решение (программно):** Кэш результатов тулов в Agent.ts:
```ts
const cacheKey = `${fn.name}:${JSON.stringify(args)}`
if (this.toolResultCache.has(cacheKey)) {
  resultMap.set(callId, { contentForAI: this.toolResultCache.get(cacheKey), callId, name: fn.name })
  return
}
// ... execute tool ...
this.toolResultCache.set(cacheKey, contentForAI)
```

---

### 🟡 P1-5. Confidence Scoring
**Проблема:** AI не оценивает уверенность. Low-confidence ответы в 3x чаще содержат ошибки.

**Решение (промптом):**
```
## Confidence indication
At the end of complex answers, add a confidence level:
- **[High]** — verified with tests/diagnostics, code runs
- **[Medium]** — logic is sound but not verified
- **[Low]** — uncertain, needs human review
```
**Решение (программно):** Парсить `[Confidence: Low]` и подсвечивать в UI.

---

### 🟡 P2-6. Multi-Plan Selection
**Проблема:** AI генерирует один план. Рекомендуется 2-3 альтернативы.
**Решение (промптом):** В planning injection добавить:
```
## Step 3.5. Alternative evaluation
Before finalizing the plan, consider:
- Alternative A: [different approach] — pros/cons
- Alternative B: [different approach] — pros/cons
Pick the best one and explain why.
```
(В `buildPlanningInjection` уже есть секция "Alternatives considered" — можно усилить.)

---

### 🟢 P2-7. Circuit Breaker для tool errors с recovery hints
**Что есть:** `maxRepeatedErrors` (2) останавливает повторы, но AI не получает стратегию восстановления.

**Решение (программно):**
```ts
function generateRecoveryHints(toolName: string, error: string): string {
  if (error.includes('ENOENT')) return 'File not found. Use find_files to locate the correct path.'
  if (error.includes('EACCES')) return 'Permission denied. Check if the file is locked or read-only.'
  if (error.includes('timeout')) return 'Timeout. Try a smaller scope or split the operation.'
  return 'Try: different arguments, different tool, or ask the user for help.'
}
```

---

### 🟢 P2-8. Few-shot examples для сложных тулов
**Проблема:** AI иногда неправильно использует edit_file (apply_patch), spawn_agent.

**Решение (промптом):** Добавить примеры в system prompt:
```
## Tool usage examples
edit_file (apply_patch mode):
GOOD: edit_file("src/auth.ts", "--- old ---\nfunction oldName() {\n+++ new ---\nfunction newName() {\n", "apply_patch")
BAD: edit_file("src/auth.ts", "replace oldName with newName", "replace")

spawn_agent:
GOOD: spawn_agent("Find all TODO comments in src/. Return: file:line - comment text. Do not change code.")
BAD: spawn_agent("Find TODOs")  # too vague
```

---

## 4. Приоритеты внедрения

| # | Улучшение | Тип | Сложность | Влияние | Приоритет |
|---|---|---|---|---|---|
| 1 | Self-Reflection Pass | Программно | Средняя | 🔴 Высокое | **P0** |
| 2 | Proactive Recall | Программно | Низкая | 🔴 Высокое | **P0** |
| 3 | Progressive Summarization | Программно | Высокая | 🟡 Среднее | **P1** |
| 4 | Tool Result Dedup | Программно | Низкая | 🟡 Среднее | **P1** |
| 5 | Confidence Scoring | Промпт | Низкая | 🟡 Среднее | **P1** |
| 6 | Multi-Plan Selection | Промпт | Низкая | 🟡 Среднее | **P2** |
| 7 | Error Recovery Hints | Программно | Низкая | 🟢 Низкое | **P2** |
| 8 | Few-shot examples | Промпт | Низкая | 🟢 Низкое | **P2** |

---

## 5. Сводная оценка агента SynteeHelper

| Категория | Оценка | vs лидеры |
|---|---|---|
| ReAct loop | 9/10 | На уровне Claude Code |
| Planning | 8/10 | На уровне Claude Code |
| Memory | 10/10 | **Лучше всех** (5-source, graph, outcomes) |
| Context management | 7/10 | Хорошо, но нет proactive summarization |
| Tool selection | 8/10 | Хорошее guidance, нет few-shot |
| Error handling | 8/10 | Loop guard, error fingerprinting — лучше большинства |
| Self-reflection | 4/10 | Только инструкция, нет механизма |
| Sub-agents | 9/10 | Worktree isolation — уникально |
| Fast Context | 9/10 | Уникальная комбинация |

**Общий балл: 8/10** — выше среднего по рынку (Claude Code ~8.5, Cline ~6, Cursor ~7.5).

**Главный зазор:** Self-reflection и proactive recall. Обе реализуемы за один день работы.

---

## Источники
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.anthropic.com/engineering/building-effective-agents
- https://arxiv.org/html/2504.15228v1 (A Self-Improving Coding Agent)
- arXiv:2502.06975 (Episodic Memory is the Missing Piece for Long-Term LLM Agents)
- Andrew Ng — 4 agentic design patterns (deeplearning.ai)
- SWE-bench / Terminal-bench 2.0 leaderboards (2026)