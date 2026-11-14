/**
 * Генерация сообщения коммита локальной моделью (llama.cpp).
 *
 * Почему локальная: сообщение коммита — это одна строка по диффу, гонять ради
 * неё облачную модель дорого и медленно. Мини-модель уже поднята для
 * мини-агентов (LocalModelManager), у неё та же очередь и авто-выбор размера.
 *
 * Ключевые ограничения, которые диктуют промпт:
 *  - контекст делится между слотами (см. LocalModelManager.getPromptTokenBudget),
 *    поэтому дифф режем по бюджету в символах, а не «как есть»;
 *  - модель 0.8–1.2B, поэтому кормим её ВЫЖИМКОЙ (сигналы + закрытый список
 *    scope + few-shot), а не сырым диффом — иначе получаем «обновить файлы»;
 *  - если модель не скачана — НЕ триггерим скачивание (~1 ГБ) из-за кнопки,
 *    отдаём шаблонный фолбэк и говорим об этом.
 *
 * Чистые хелперы (сигналы, scope, нормализация, фолбэк) — в commitMessageHelpers.ts.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { runGit } from './runGit'
import { localModels } from '../localModels/LocalModelManager'
import { log } from '../../core/logger'
import {
  extractSignals,
  extractStrings,
  fallbackMessage,
  isTooGeneric,
  normalizeCommitMessage,
  scopeCandidates,
  type CommitMessageStats,
  type FileStat,
} from './commitMessageHelpers'

export type { CommitMessageStats }

export interface CommitMessageResult {
  success: boolean
  message: string
  /** local — сгенерировала модель, fallback — шаблон из статистики. */
  source: 'local' | 'fallback'
  error?: string
  stats: CommitMessageStats
}

/**
 * Пути, которые не помогают написать сообщение, но съедают весь контекст:
 * lock-файлы, сборки, минифицированный код, карты. Отсекаем и в статистике,
 * и в диффе (в статистике — чтобы scope не был «package-lock»).
 */
const EXCLUDES = [
  ':(exclude,glob)**/package-lock.json',
  ':(exclude,glob)**/pnpm-lock.yaml',
  ':(exclude,glob)**/yarn.lock',
  ':(exclude,glob)**/*.lock',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)**/out/**',
  ':(exclude,glob)**/*.min.js',
  ':(exclude,glob)**/*.min.css',
  ':(exclude,glob)**/*.map',
]

const MAX_TOKENS = 140
const DIFF_CHARS_FLOOR = 6_000
const DIFF_CHARS_CEIL = 40_000
/** Грубая оценка: 1 токен ≈ 3.5 символа для кода/диффов. */
const CHARS_PER_TOKEN = 3.5
const MAX_UNTRACKED_PREVIEW_FILES = 8
const MAX_UNTRACKED_PREVIEW_LINES = 60

async function collectTrackedStats(workdir: string): Promise<FileStat[]> {
  const out = await runGit(workdir, ['diff', 'HEAD', '--numstat', '--', '.', ...EXCLUDES]).catch(() => '')
  const stats: FileStat[] = []
  for (const line of out.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0
    const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0
    stats.push({ path: parts[2], added, deleted })
  }
  return stats
}

async function collectUntracked(workdir: string): Promise<string[]> {
  const out = await runGit(workdir, ['ls-files', '--others', '--exclude-standard']).catch(() => '')
  return out.split('\n').map(l => l.trim()).filter(Boolean)
}

/**
 * Стиль проекта: последние заголовки коммитов. Мини-модель копирует тон и
 * структуру примеров куда лучше, чем следует абстрактным правилам — это самый
 * дешёвый способ получить «коммиты как в репозитории», а не «update files».
 */
async function readRecentSubjects(workdir: string, limit = 8): Promise<string[]> {
  const out = await runGit(workdir, ['log', `--max-count=${limit}`, '--no-merges', '--format=%s']).catch(() => '')
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && /^[a-z]+(\([^)]+\))?!?:\s+\S/.test(l))
}

function summarize(stats: FileStat[], untracked: string[]): CommitMessageStats {
  return {
    files: stats.length + untracked.length,
    added: stats.reduce((s, f) => s + f.added, 0),
    deleted: stats.reduce((s, f) => s + f.deleted, 0),
    untracked: untracked.length,
  }
}

/** Превью новых файлов: диффом их не увидеть (они вне индекса). */
async function previewUntracked(workdir: string, untracked: string[]): Promise<string> {
  const parts: string[] = []
  for (const rel of untracked.slice(0, MAX_UNTRACKED_PREVIEW_FILES)) {
    try {
      const content = await readFile(join(workdir, rel), 'utf-8')
      const lines = content.split('\n').slice(0, MAX_UNTRACKED_PREVIEW_LINES)
      parts.push(`+++ new file: ${rel}\n${lines.map(l => `+${l}`).join('\n')}`)
    } catch {
      parts.push(`+++ new file: ${rel} (binary or unreadable)`)
    }
  }
  if (untracked.length > MAX_UNTRACKED_PREVIEW_FILES) {
    parts.push(`… and ${untracked.length - MAX_UNTRACKED_PREVIEW_FILES} more new files`)
  }
  return parts.join('\n\n')
}

async function collectDiff(workdir: string, budgetChars: number, untracked: string[]): Promise<string> {
  const diff = await runGit(workdir, ['diff', 'HEAD', '--no-color', '--unified=2', '--', '.', ...EXCLUDES]).catch(() => '')
  const tracked = diff.trim()
  // Новые файлы не попадают в `git diff HEAD` — а именно в них обычно и лежит
  // суть изменения. Поэтому превью untracked добавляем ВСЕГДА, не только когда
  // треканых правок нет; иначе модель описывает второстепенное.
  const preview = untracked.length > 0 ? await previewUntracked(workdir, untracked) : ''
  const text = [tracked, preview].filter(Boolean).join('\n\n')
  if (text.length <= budgetChars) return text
  // Режем по бюджету, но по границе строки — обрубок хунка модели только мешает.
  const cut = text.slice(0, budgetChars)
  const lastNewline = cut.lastIndexOf('\n')
  return `${lastNewline > 1000 ? cut.slice(0, lastNewline) : cut}\n… (diff truncated)`
}

function buildPrompt(args: {
  lang: 'ru' | 'en'
  files: string[]
  stats: CommitMessageStats
  signals: string[]
  strings: string[]
  scopes: string[]
  history: string[]
  repair?: string
}): string {
  const { lang, files, stats, signals, strings, scopes, history, repair } = args
  const fileList = files
    .slice(0, 25)
    .map(f => `- ${f}`)
    .join('\n') + (files.length > 25 ? `\n- … ещё ${files.length - 25}` : '')
  const signalList = signals.length > 0 ? signals.map(s => `- ${s}`).join('\n') : '- (сигналов нет)'
  const stringList = strings.length > 0 ? strings.map(s => `- «${s}»`).join('\n') : ''
  const scopeList = scopes.length > 0 ? scopes.join(', ') : 'core'
  const repairBlock = repair
    ? `\nПредыдущий вариант был слишком общим: «${repair}». Назови КОНКРЕТНО, что появилось или изменилось.\n`
    : ''
  // Реальные коммиты этого репозитория — самый сильный few-shot: модель копирует
  // и структуру, и лексику проекта вместо абстрактных «update files».
  const historyBlock = history.length > 0
    ? `\nТак уже писали в этом репозитории (тот же стиль и язык):\n${history.map(h => `- ${h}`).join('\n')}\n`
    : ''

  if (lang === 'ru') {
    return `Ты пишешь заголовок git-коммита. Тебе дан список изменённых файлов и ключевые правки.
${repairBlock}${historyBlock}
Выбери тип по смыслу изменений:
- feat — добавлена новая возможность или файл
- fix — исправлена ошибка/падение
- refactor — код перестроен без изменения поведения
- perf — ускорение
- docs — документация
- test — тесты
- style — форматирование
- chore — сборка, зависимости, конфиги

Область (scope) — ровно одно слово из списка: ${scopeList}

Описание — 4–9 слов, по-русски, со строчной буквы, БЕЗ точки, конкретно: что появилось/исправлено.
Запрещено писать «обновить файлы», «изменения», «правки», «различные улучшения» — это мусор.

Ответ — ровно одна строка, ничего больше:
тип(область): описание

Примеры:
feat(assistants): локальные мини-модели для подсказок в чате
fix(git): не учитывать неотслеживаемые файлы в статистике
refactor(ui): вынести расчёт позиции поповера в хелпер

Изменённые файлы (${stats.files}, +${stats.added} −${stats.deleted}):
${fileList}

Ключевые правки:
${signalList}
${stringList ? `\nТексты в интерфейсе:\n${stringList}\n` : ''}
Ответ:`
  }

  return `You write git commit headlines. You are given changed files and key edits.
${repairBlock}${historyBlock}
Pick the type by meaning:
- feat — new capability or file
- fix — bug/crash fixed
- refactor — code restructured, behaviour unchanged
- perf — faster
- docs — documentation
- test — tests
- style — formatting
- chore — build, deps, configs

Scope — exactly one word from: ${scopeList}

Subject — 4–9 words, lowercase, no trailing period, specific: what appeared/fixed.
Never write "update files", "changes", "various improvements" — that is noise.

Answer with exactly one line, nothing else:
type(scope): subject

Examples:
feat(assistants): local mini-models for in-chat hints
fix(git): ignore untracked files in change stats
refactor(ui): extract popover position into helper

Changed files (${stats.files}, +${stats.added} −${stats.deleted}):
${fileList}

Key edits:
${signalList}
${stringList ? `\nUI strings:\n${stringList}\n` : ''}
Answer:`
}

export async function generateCommitMessage(workdir: string, lang: 'ru' | 'en' = 'ru'): Promise<CommitMessageResult> {
  const empty: CommitMessageStats = { files: 0, added: 0, deleted: 0, untracked: 0 }
  if (!workdir) return { success: false, message: '', source: 'fallback', error: 'workdir is required', stats: empty }

  let stats = empty
  let files: string[] = []
  try {
    const [tracked, untracked] = await Promise.all([collectTrackedStats(workdir), collectUntracked(workdir)])
    stats = summarize(tracked, untracked)
    files = [...tracked.map(t => t.path), ...untracked]

    if (stats.files === 0) {
      return { success: false, message: '', source: 'fallback', error: 'no changes', stats }
    }

    // Модель не скачана — не тянем ~1 ГБ из-за кнопки, отдаём шаблон.
    const status = localModels.getStatus()
    if (!status.binaryReady || !status.modelDownloaded) {
      return {
        success: true,
        message: fallbackMessage(stats, files, lang),
        source: 'fallback',
        error: 'local-model-not-ready',
        stats,
      }
    }

    const budgetChars = Math.min(
      DIFF_CHARS_CEIL,
      Math.max(DIFF_CHARS_FLOOR, Math.round(localModels.getPromptTokenBudget(MAX_TOKENS) * CHARS_PER_TOKEN)),
    )
    const diff = await collectDiff(workdir, budgetChars, untracked)
    // Сырой дифф мини-модель не осиливает — кормим выжимку: заголовки хунков
    // (имена функций/классов), значимые добавленные строки и тексты интерфейса.
    const signals = extractSignals(diff)
    const strings = extractStrings(diff)
    const scopes = scopeCandidates(files)
    const history = await readRecentSubjects(workdir)

    const ask = async (repair?: string): Promise<string> => {
      const prompt = buildPrompt({ lang, files, stats, signals, strings, scopes, history, repair })
      const raw = await localModels.complete(prompt, {
        priority: 'default',
        maxTokens: MAX_TOKENS,
        temperature: repair ? 0.3 : 0.15,
        timeoutMs: 30_000,
      })
      return normalizeCommitMessage(raw, scopes)
    }

    let message = await ask()
    // Один добор: если ответ общий — просим конкретику, назвав, что не так.
    if (!message || isTooGeneric(message)) {
      const retry = await ask(message || (lang === 'ru' ? 'обновить файлы' : 'update files'))
      if (retry && !isTooGeneric(retry)) message = retry
    }

    if (!message || isTooGeneric(message)) {
      return { success: true, message: fallbackMessage(stats, files, lang), source: 'fallback', error: 'weak-answer', stats }
    }
    return { success: true, message, source: 'local', stats }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    log('[CommitMessage] generation failed: %s', msg)
    return {
      success: true,
      message: files.length > 0 ? fallbackMessage(stats, files, lang) : '',
      source: 'fallback',
      error: msg,
      stats,
    }
  }
}
