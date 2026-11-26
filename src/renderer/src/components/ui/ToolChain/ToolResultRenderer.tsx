import { useState, useMemo, memo } from 'react'
// Подсветка одна на всё приложение — refractor → HTML-строка
// (utils/codeHighlightHTML), как в код-блоках сообщений. react-syntax-highlighter
// снесён из карточек тулов: его построчный сплиттер (showLineNumbers/wrapLines)
// ломал вывод read_file — терялись куски строк, а служебный конверт
// («[File: … | Lines …]», префиксы «N|», строка «…[shown …]») рисовался как код.
import { highlightCodeToHtml } from '../../../utils/codeHighlightHTML'
import type { ToolStep } from './ToolChain'
import type { ToolOutputMode } from '../../../../../shared/types'
import { copyToClipboard } from '../../../utils/clipboard'
import { tabActions } from '../../../store/tabs.store'
import { useIsLightTheme } from '../../../utils/themeBase'
import FileChip from './FileChip'
import { useNavStore } from '../../../store/nav.store'
import './ToolResultRenderer.css'

// ── Утилиты ────────────────────────────────────────────────────────────────

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    css: 'css', scss: 'scss', html: 'html', xml: 'xml',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
    md: 'markdown', sql: 'sql', graphql: 'graphql',
    env: 'bash', dockerfile: 'docker',
  }
  return map[ext] || 'text'
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, truncated: false }
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true }
}

function tryParseJSON(text: string): unknown | null {
  try { return JSON.parse(text) } catch { return null }
}

// ── Прогрессивное раскрытие («Показать ещё») ────────────────────────────────
// Вместо «60 строк или всё целиком (9999)» — чанки: начальный кап + кнопка
// «Показать ещё N». Длинные выводы не монтируют тысячи DOM-узлов и не
// токенизируются Prism'ом целиком при раскрытии тулчейна/скролле.
// Паттерн `extra`-state: visible = initialLines + extra → при смене режима
// (normal↔detailed) видимое окно подстраивается без сброса state.

const CODE_CHUNK = 60

// ── Единая «поверхность» кода ──────────────────────────────────────────────
// Раньше каждый тул рисовал свой блок: read_file — Prism с одной рамкой,
// search_code — голые <pre> с другим фоном, diff — кастомная рамка,
// edit_file — плашка «Записан». Теперь у всех код-выводов один фрейм
// (шапка с путём + копирование), один шрифт и один стиль подсветки.

const CopyBtn = memo(function CopyBtn({ value, label, title }: {
  value: string
  label?: string
  title?: string
}) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    void copyToClipboard(value).then(ok => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button type="button" className="trr-copy-btn" onClick={onCopy} title={title ?? 'Копировать'}>
      {copied ? '✓' : (label ?? 'Копировать')}
    </button>
  )
}, (prev, next) => prev.value === next.value && prev.label === next.label)

interface CodeSurfaceProps {
  code: string
  lang: string
  /** Файл в шапке блока — рисуется плашкой [JS] file.mjs. */
  filePath?: string
  /** Доп. подпись рядом с плашкой файла (например «+3 файла»). */
  title?: string
  /** Бейдж диапазона в шапке: «568–607 / 631» (выдача read_file). */
  rangeLabel?: string
  initialLines: number
  maxHeight?: number
  /** Доп. элемент в шапке справа (бейджи +N/−M и т.п.). */
  meta?: React.ReactNode
  /** plain — без подсветки (вывод/совпадения поиска), lineClass на строках. */
  mode?: 'highlight' | 'plain'
  lineClass?: (line: string) => string
  /** Номер первой строки (read_file: реальные номера файла, не 1..N). */
  lineNumberStart?: number
  /** Что копировать; по умолчанию — весь код. */
  copyValue?: string
}

export const CodeSurface = memo(function CodeSurface({
  code, lang, filePath, title, rangeLabel, initialLines, maxHeight = 400, meta, mode = 'highlight', lineClass,
  lineNumberStart = 1, copyValue,
}: CodeSurfaceProps) {
  const [extra, setExtra] = useState(0)
  // Палитра подсветки должна совпадать с темой: на светлой oneDark нечитаем.
  const isLight = useIsLightTheme()
  const visible = initialLines + extra
  const allLines = code.replace(/\n+$/, '').split('\n')
  const shown = allLines.slice(0, visible)
  const truncated = allLines.length > visible
  // Одна HTML-строка вместо React-дерева из тысяч <span>; кэш внутри утилиты
  // по (палитра+язык+стартовый номер+код) — повторные рендеры бесплатны.
  const html = useMemo(
    () => (mode === 'highlight' ? highlightCodeToHtml(shown.join('\n'), lang, isLight, lineNumberStart) : ''),
    [mode, shown, lang, isLight, lineNumberStart],
  )
  return (
    <div className={`trr-code${mode === 'plain' ? ' trr-code--plain' : ''}`}>
      {(title || meta || filePath || rangeLabel) && (
        <div className="trr-code-head">
          {filePath
            ? <FileChip path={filePath} showDir={false} />
            : title && <span className="trr-code-title" title={title}>{title}</span>}
          {filePath && title && <span className="trr-code-title" title={title}>{title}</span>}
          {rangeLabel && <span className="trr-code-range">{rangeLabel}</span>}
          {meta}
          <span className="trr-code-head-spacer" />
          <CopyBtn value={copyValue ?? code} title="Копировать содержимое" />
        </div>
      )}
      {mode === 'highlight' ? (
        <pre
          className="trr-code-pre"
          style={{ margin: 0, padding: '10px 12px', maxHeight, overflow: 'auto', display: 'flex' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="trr-code-lines" style={{ maxHeight }}>
          {shown.map((line, i) => (
            <div key={i} className={`trr-code-line${lineClass ? ` ${lineClass(line)}` : ''}`}>
              {line || '\u00a0'}
            </div>
          ))}
        </div>
      )}
      {truncated && (
        <button className="trr-expand-btn trr-code-more" onClick={() => setExtra(e => e + CODE_CHUNK)}>
          Показать ещё {Math.min(CODE_CHUNK, allLines.length - visible)} из {allLines.length} строк
        </button>
      )}
    </div>
  )
}, (prev, next) =>
  prev.code === next.code && prev.lang === next.lang && prev.title === next.title &&
  prev.filePath === next.filePath && prev.rangeLabel === next.rangeLabel &&
  prev.initialLines === next.initialLines && prev.mode === next.mode &&
  prev.lineNumberStart === next.lineNumberStart &&
  prev.copyValue === next.copyValue)

// ── Суб-рендеры ────────────────────────────────────────────────────────────

// ── read_file: разбор служебного конверта ──────────────────────────────────
// Тул отдаёт модели текст с обёрткой (см. src/core/tools/fileRead.ts):
//   [File: C:\...\contextManager.ts | Lines 568-607 of 631]
//   ...[shown 40 of 631 lines | 24 more lines | use offset=608 to continue]
//   568|const x = 1
// ...
// 631|}
// Карточка рисовала это как КОД: путь дублировал плашку файла, номера строк
// шли двойным рядом (префиксы «N|» + своя нумерация подсветки), строка
// «…[shown …]» попадала в тело блока. Теперь конверт разбирается: шапка →
// плашка файла + бейдж диапазона, тело → код без «N|» с РЕАЛЬНЫМИ номерами
// строк файла, примечание обрезки → подвал блока.
interface ReadBlock {
  path: string
  /** Номер первой строки тела в файле (1-based). */
  from: number
  /** Всего строк в файле (если конверт это сообщает). */
  total?: number
  /** Хвостовая строка «…[shown N of Z lines | … use offset=K …]». */
  note?: string
  body: string
}

const FILE_HEAD_RE = /^\[File:\s*(.+?)\s*\|\s*(.*?)\s*\]$/
const FILE_SECTION_RE = /^===\s*(.+?)\s*\|\s*(\d+)\s+lines?\s*===$/
const SHOWN_NOTE_RE = /^\.\.\.\[(?:shown|full mode)[^\]]*\]$/
const NUMBERED_LINE_RE = /^(\d+)\|([\s\S]*)$/

// Вывод read_file сохраняется в БД как есть: строки файла с CRLF дают
// «95|код\r» — regex `(.*)$` не доходит до конца строки (точка не матчит \r),
// поэтому префикс «N|» не снимался и попадал в тело кода ВТОРЫМ рядом
// номеров (плюс висящий \r → пустая строка внизу карточки).
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export function parseReadBlocks(content: string): ReadBlock[] {
  const blocks: ReadBlock[] = []
  let current: ReadBlock | null = null
  // Распознан ли ХОТЬ ОДИН заголовок конверта. Если нет — это не вывод
  // read_file (например, сжатый джанитором результат «[Контекст
  // оптимизирован…]»), и рисовать его код-карточкой нельзя: получалась
  // плашка файла с фальшивым диапазоном «1–1» и пустота под ней.
  let sawHeader = false
  const push = (): void => {
    if (current) {
      // Хвостовые пустые строки конверта не должны превращаться в «пустоту»
      // под кодом: у файла нет «лишних» строк, это артефакт \n в конце.
      current.body = current.body.replace(/(?:\r?\n)+$/, '')
      blocks.push(current)
      current = null
    }
  }
  for (const rawLine of content.split('\n')) {
    const raw = stripCr(rawLine)
    let header: { path: string; from: number; total?: number } | null = null
    const section = FILE_SECTION_RE.exec(raw)
    const head = FILE_HEAD_RE.exec(raw)
    if (section) {
      header = { path: section[1], from: 1, total: Number(section[2]) }
    } else if (head) {
      const meta = head[2]
      const range = /Lines?\s+(\d+)(?:\s*-\s*\d+)?\s+of\s+(\d+)/.exec(meta)
      if (range) header = { path: head[1], from: Number(range[1]), total: Number(range[2]) }
      else {
        const plain = /^(\d+)\s+lines?\b/.exec(meta)
        if (plain) header = { path: head[1], from: 1, total: Number(plain[1]) }
        // Неизвестный конверт — не выдаём его за код, оставляем как текст ниже.
      }
    }
    if (header) {
      push()
      sawHeader = true
      current = { path: header.path, from: header.from, total: header.total, body: '' }
      continue
    }
    // Строки ДО первого заголовка (сжатый/чужой результат) — не код.
    if (!sawHeader) continue
    if (!current) current = { path: '', from: 1, body: '' }
    if (!current.body && SHOWN_NOTE_RE.test(raw)) {
      // «...[shown 400 of 507 …]» → «shown 400 of 507 …»
      current.note = raw.slice(4).replace(/\]$/, '').trim()
      continue
    }
    const numbered = NUMBERED_LINE_RE.exec(raw)
    if (numbered) {
      if (!current.body) current.from = Number(numbered[1])
      current.body += (current.body ? '\n' : '') + numbered[2]
    } else {
      current.body += (current.body ? '\n' : '') + raw
    }
  }
  push()
  return blocks
}

const ReadResult = memo(function ReadResult({ content, args, initialLines }: {
  content: string
  args: Record<string, unknown>
  initialLines: number
}) {
  const blocks = useMemo(() => parseReadBlocks(content), [content])
  const argPath = String(args.path ?? args.file_path ?? '')
  // Конверт не распознан (MCP-подобный ответ, ошибка) — обычный текст.
  if (!blocks.length) return <ChunkedPre content={content} initialLines={initialLines} />
  return (
    <div className="trr-read">
      {blocks.map((block, i) => {
        const path = block.path || argPath
        const lines = block.body ? block.body.split('\n') : []
        const lineCount = lines.length
        const lastLine = block.from + Math.max(0, lineCount - 1)
        const rangeLabel = block.total
          ? `${block.from}–${lastLine} / ${block.total}`
          : lineCount > 0 ? `${block.from}–${lastLine}` : ''
        // Пустой блок (например, только заголовок без строк) не рисуем —
        // иначе получалась карточка-пустышка с пустотой внизу.
        if (!lineCount) return null
        return (
          <div key={`${path}:${i}`}>
            <CodeSurface
              code={block.body}
              lang={getLanguage(path)}
              filePath={path || undefined}
              rangeLabel={rangeLabel || undefined}
              // Реальные номера строк файла (как в diff-карточке edit_file),
              // а не 1..N от начала вырезки.
              lineNumberStart={block.from}
              initialLines={initialLines}
              copyValue={block.body}
            />
            {block.note && (
              <div className="trr-read-note" title={block.note}>{block.note}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}, (prev, next) =>
  prev.content === next.content && prev.args === next.args && prev.initialLines === next.initialLines)

const TerminalResult = memo(function TerminalResult({ content, initialLines }: { content: string; initialLines: number }) {
  const [extra, setExtra] = useState(0)
  const visible = initialLines + extra
  const trimmed = content.trim()
  const total = trimmed.split('\n').length
  const { text, truncated } = truncateLines(trimmed, visible)
  return (
    <div className="trr-terminal">
      <pre className="trr-terminal-pre">{text}</pre>
      {truncated && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + CODE_CHUNK)}>
          Показать ещё {Math.min(CODE_CHUNK, total - visible)} из {total} строк
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.content === next.content && prev.initialLines === next.initialLines)

// ── Терминал одной карточкой: команда сверху, вывод ниже ───────────────────
// Раньше это был ДВА блока: «Аргументы → command» и «Результат → вывод».
// Теперь одна рамка: полная команда (видна и во время выполнения — сюда же
// стримится live-вывод) и её вывод под ней, без разделителей и подписей.
const TerminalCall = memo(function TerminalCall({ command, content, success, initialLines }: {
  command: string
  content: string
  success?: boolean
  initialLines: number
}) {
  const [extra, setExtra] = useState(0)
  const visible = initialLines + extra
  const trimmed = (content ?? '').trim()
  const lines = trimmed ? trimmed.split('\n') : []
  const shown = lines.slice(0, visible)
  return (
    <div className={`trr-term${success === false ? ' trr-term--fail' : ''}`}>
      <div className="trr-term-cmd">
        <span className="trr-term-prompt">$</span>
        <code className="trr-term-cmd-text">{command || '(команда не записана)'}</code>
        {command && <CopyBtn value={command} label="Копировать" title="Копировать команду" />}
      </div>
      <pre className="trr-term-out">{shown.length ? shown.join('\n') : '(пустой вывод)'}</pre>
      {lines.length > visible && (
        <button className="trr-expand-btn trr-term-more" onClick={() => setExtra(e => e + CODE_CHUNK)}>
          Показать ещё {Math.min(CODE_CHUNK, lines.length - visible)} из {lines.length} строк
        </button>
      )}
    </div>
  )
}, (prev, next) =>
  prev.command === next.command && prev.content === next.content &&
  prev.success === next.success && prev.initialLines === next.initialLines)

const FILELIST_CHUNK = 200
const FileListResult = memo(function FileListResult({ content }: { content: string }) {
  const [extra, setExtra] = useState(0)
  const visible = FILELIST_CHUNK + extra
  const lines = content.split('\n').filter(l => l.trim())
  const shown = lines.slice(0, visible)
  return (
    <div className="trr-filelist">
      {shown.map((line, i) => {
        const isDir = line.endsWith('/') || line.endsWith('\\') || !line.includes('.')
        return (
          <div key={i} className="trr-filelist-item">
            <span className="trr-filelist-icon">{isDir ? '📁' : '📄'}</span>
            <span className="trr-filelist-name">{line.trim()}</span>
          </div>
        )
      })}
      {lines.length > visible && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + FILELIST_CHUNK)}>
          Показать ещё {Math.min(FILELIST_CHUNK, lines.length - visible)} из {lines.length}
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.content === next.content)

const SEARCH_CHUNK = 5

const WebSearchResult = memo(function WebSearchResult({ content }: { content: string }) {
  const [extra, setExtra] = useState(0)
  const visible = SEARCH_CHUNK + extra
  const parsed = tryParseJSON(content)
  if (Array.isArray(parsed)) {
    const arr = parsed as Array<{ title?: string; url?: string; snippet?: string; content?: string }>
    return (
      <div className="trr-search-results">
        {arr.slice(0, visible).map((r, i) => (
          <div key={i} className="trr-search-card">
            {r.title && <div className="trr-search-title">{r.title}</div>}
            {r.url && <div className="trr-search-url">{r.url}</div>}
            {(r.snippet || r.content) && (
              <div className="trr-search-snippet">{String(r.snippet || r.content || '').slice(0, 200)}</div>
            )}
          </div>
        ))}
        {arr.length > visible && (
          <button className="trr-expand-btn" onClick={() => setExtra(e => e + SEARCH_CHUNK)}>
            Показать ещё {Math.min(SEARCH_CHUNK, arr.length - visible)} из {arr.length}
          </button>
        )}
      </div>
    )
  }
  // Plain text fallback
  return <pre className="trr-pre">{content.slice(0, 600)}</pre>
}, (prev, next) => prev.content === next.content)

const KV_CHUNK = 50
const KV_VALUE_MAX = 500

const KeyValueResult = memo(function KeyValueResult({ content }: { content: string }) {
  const [extra, setExtra] = useState(0)
  const visible = KV_CHUNK + extra
  const parsed = tryParseJSON(content)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>)
    return (
      <div className="trr-kv">
        {entries.slice(0, visible).map(([k, v]) => (
          <div key={k} className="trr-kv-row">
            <span className="trr-kv-key">{k}</span>
            <span className="trr-kv-val">{String(v).slice(0, KV_VALUE_MAX)}</span>
          </div>
        ))}
        {entries.length > visible && (
          <button className="trr-expand-btn" onClick={() => setExtra(e => e + KV_CHUNK)}>
            Показать ещё {Math.min(KV_CHUNK, entries.length - visible)} из {entries.length}
          </button>
        )}
      </div>
    )
  }
  return <pre className="trr-pre">{content.slice(0, 400)}</pre>
}, (prev, next) => prev.content === next.content)

function FileWrittenResult({ content, args, success }: {
  content: string
  args?: Record<string, unknown>
  success?: boolean
}) {
  const path = String(args?.path ?? args?.file_path ?? '')
  const note = (content ?? '').trim().split('\n')[0] ?? ''
  const isFail = success === false
  // Сырой ответ тула («File updated: C:\... (2 lines changed)») в карточке не
  // показываем: путь уже в плашке, статус — галочкой. Из текста вытаскиваем
  // только число строк, если оно там есть.
  const changed = Number((/(\d+)\s*(?:lines?|строк)/i.exec(note) ?? [])[1] ?? NaN)
  const linesNote = Number.isFinite(changed) ? `${changed} стр.` : ''
  return (
    <div className={`trr-file-op${isFail ? ' trr-file-op--fail' : ''}`}>
      <span className="trr-file-op-icon">{isFail ? '✕' : '✓'}</span>
      <div className="trr-file-op-info">
        {path ? <FileChip path={path} /> : <span className="trr-file-op-note">{note || 'файл'}</span>}
        {linesNote && <span className="trr-file-op-note">{linesNote}</span>}
      </div>
      {path && <CopyBtn value={path} title="Копировать путь" />}
    </div>
  )
}

const MATCHES_CHUNK = 20

// Совпадения поиска по коду — та же «поверхность», что у чтения файла:
// шапка со статистикой, моношрифт, подсветка строк-совпадений (>) и контекста (-).
const SearchCodeResult = memo(function SearchCodeResult({ content }: { content: string }) {
  const allLines = content.split('\n')
  // Парсим шапку статистики: "[search_code: N совпадений в M файлах...]"
  const header = allLines[0] ?? ''
  const statsMatch = header.match(/\[search_code:\s*(.+?)\]/)
  const stats = statsMatch?.[1]
  const body = (stats ? allLines.slice(1) : allLines).filter(l => l.trim())
  return (
    <CodeSurface
      mode="plain"
      code={body.join('\n')}
      lang="text"
      title={stats ? `search_code · ${stats}` : 'Совпадения'}
      initialLines={MATCHES_CHUNK}
      maxHeight={320}
      lineClass={line =>
        line.startsWith('>') ? 'is-match'
          : line.startsWith('-') ? 'is-context'
            : line.trim() === '...' ? 'is-gap'
              : ''
      }
    />
  )
}, (prev, next) => prev.content === next.content)

/** Дефолтный pre-рендер с чанкованием (используется в default-ветке). */
const ChunkedPre = memo(function ChunkedPre({ content, initialLines }: { content: string; initialLines: number }) {
  const [extra, setExtra] = useState(0)
  const visible = initialLines + extra
  const total = content.split('\n').length
  const { text, truncated } = truncateLines(content, visible)
  return (
    <>
      <pre className="trr-pre">{text}</pre>
      {truncated && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + CODE_CHUNK)}>
          Показать ещё {Math.min(CODE_CHUNK, total - visible)} из {total} строк
        </button>
      )}
    </>
  )
}, (prev, next) => prev.content === next.content && prev.initialLines === next.initialLines)

// ── Image search result (item 12) — карточки с кнопками, БЕЗ рендера картинок ─

interface ImageResult {
  title: string
  image: string
  thumbnail: string
  url: string
  width: number
  height: number
  source: string
  localPath?: string
}

const IMAGE_CHUNK = 6

const ImageSearchResult = memo(function ImageSearchResult({ content }: { content: string }) {
  const [extra, setExtra] = useState(0)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const parsed = tryParseJSON(content)
  if (!Array.isArray(parsed)) {
    // Fallback: plain text (например "No images found")
    return <pre className="trr-pre">{content.slice(0, 400)}</pre>
  }

  const results = parsed as ImageResult[]
  if (!results.length) {
    return <div className="trr-image-empty">Картинки не найдены. Попробуйте изменить запрос.</div>
  }
  const visible = IMAGE_CHUNK + extra

  const handleCopy = (idx: number, url: string) => {
    void copyToClipboard(url).then((ok) => {
      if (ok) {
        setCopiedIdx(idx)
        setTimeout(() => setCopiedIdx(null), 1500)
      }
    })
  }

  return (
    <div className="trr-image-search">
      <div className="trr-image-list">
        {results.slice(0, visible).map((r, i) => (
          <div key={i} className="trr-image-item">
            <div className="trr-image-item-info">
              <div className="trr-image-item-title">{r.title || `Изображение ${i + 1}`}</div>
              <div className="trr-image-item-meta">
                {r.width}×{r.height} · {r.source}
              </div>
            </div>
            <div className="trr-image-item-actions">
              <button
                className="trr-image-btn trr-image-btn-copy"
                onClick={() => handleCopy(i, r.image)}
                title="Копировать URL картинки в буфер обмена"
              >
                {copiedIdx === i ? '✓' : 'Копировать'}
              </button>
              <button
                className="trr-image-btn trr-image-btn-open"
                onClick={() => window.open(r.image, '_blank')}
                title="Открыть в браузере"
              >
                Открыть
              </button>
              {r.localPath && (
                <span className="trr-image-saved" title={r.localPath}>✓ Сохранено</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {results.length > visible && (
        <button className="trr-expand-btn" onClick={() => setExtra(e => e + IMAGE_CHUNK)}>
          Показать ещё {Math.min(IMAGE_CHUNK, results.length - visible)} из {results.length}
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.content === next.content)

// ── Fetch page result (item 13) — header + ChunkedPre ──

const FetchPageResult = memo(function FetchPageResult({ content, initialLines }: {
  content: string; initialLines: number
}) {
  // Парсим мета-блок
  const metaMatch = content.match(/^---FETCH_META---\n([\s\S]*?)---END_META---\n\n([\s\S]*)$/)
  if (!metaMatch) {
    // Нет мета — fallback на TerminalResult
    return <TerminalResult content={content} initialLines={initialLines} />
  }

  const metaStr = metaMatch[1]
  const body = metaMatch[2]
  const meta: Record<string, string> = {}
  for (const line of metaStr.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) meta[m[1]] = m[2]
  }

  return (
    <div className="trr-fetch-page">
      <div className="trr-fetch-header">
        {meta.favicon && (
          <img
            src={meta.favicon}
            className="trr-fetch-favicon"
            loading="lazy"
            alt=""
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        )}
        <div className="trr-fetch-info">
          {meta.title && <div className="trr-fetch-title">{meta.title}</div>}
          {meta.url && <div className="trr-fetch-url">{meta.url}</div>}
          {meta.description && <div className="trr-fetch-desc">{meta.description}</div>}
        </div>
      </div>
      <ChunkedPre content={body} initialLines={initialLines} />
    </div>
  )
}, (prev, next) => prev.content === next.content && prev.initialLines === next.initialLines)

// ── Главный компонент ──────────────────────────────────────────────────────

// Рендеру нужны только имя/аргументы вызова и содержимое/статус результата —
// этот же компонент переиспользуется для вложенных вызовов execute_code
// (там нет полных ToolStep-объектов, только записи трейса).
interface Props {
  call: Pick<ToolStep, 'toolName'> & Partial<Pick<ToolStep, 'toolArgs'>>
  result: Pick<ToolStep, 'content'> & Partial<Pick<ToolStep, 'success' | 'diff'>>
  mode: ToolOutputMode
}

// Начальный кап строк: normal — 60 (как раньше), detailed — 500 (раньше было
// 9999 = фактически без капа; на файлах в тысячи строк Prism токенизировал
// всё целиком и монтировал тысячи DOM-узлов). Дальше — чанки «Показать ещё».
const NORMAL_LINES = 60
const DETAILED_LINES = 500

// Аргументы showArgs — в detailed-режиме для любого тула. Для run_command
// аргументы отдельно не печатаем: команда живёт в шапке единой терминальной
// карточки (см. TerminalCall), иначе команда дублировалась в двух местах.

const ToolResultRenderer = memo(function ToolResultRenderer({ call, result, mode }: Props) {
  const toolName = call.toolName ?? ''
  const content = result.content ?? ''
  const args = call.toolArgs ?? {}
  const initialLines = mode === 'detailed' ? DETAILED_LINES : NORMAL_LINES

  // ── run_command: ОДНА карточка — команда сверху, вывод снизу ──
  // Никакого деления на «Аргументы» и «Результат»: это был один и тот же
  // вызов, разорванный на два блока с дублирующимся текстом.
  if (toolName === 'run_command') {
    const extraArgs = Object.entries(args).filter(([k]) => k !== 'command')
    return (
      <div className="trr-wrap">
        <TerminalCall
          command={String(args.command ?? '')}
          content={content}
          success={result.success}
          initialLines={initialLines}
        />
        {mode === 'detailed' && extraArgs.length > 0 && (
          <div className="trr-args-section">
            <div className="trr-section-label">Параметры</div>
            <div className="trr-args">
              {extraArgs.map(([k, v]) => (
                <div key={k} className="trr-arg-row">
                  <span className="trr-arg-key">{k}</span>
                  <pre className="trr-arg-val">{String(v).slice(0, 500)}</pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── detailed: показываем аргументы ──
  const showArgs = mode === 'detailed'

  return (
    <div className="trr-wrap">
      {showArgs && Object.keys(args).length > 0 && (
        <div className="trr-args-section">
          <div className="trr-section-label">Аргументы</div>
          <div className="trr-args">
            {Object.entries(args).map(([k, v]) => (
              <div key={k} className="trr-arg-row">
                <span className="trr-arg-key">{k}</span>
                <pre className="trr-arg-val">{String(v).slice(0, 500)}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Никаких подписей «Результат/Ошибка»: вывод карточки — это и есть
          результат, а статус уже виден в шапке (✓ / «ошибка»). Подпись только
          дублировала смысл и добавляла лишнюю строку в каждую карточку. */}
      <div className="trr-result-section">
        {result.success === false
          ? (
            <div className="trr-error-block">
              <pre className="trr-error-pre">{content || '(нет деталей ошибки)'}</pre>
            </div>
          )
          : renderResult(toolName, content, args, initialLines, result.success)}
      </div>
    </div>
  )
}, (prev, next) => prev.call === next.call && prev.result === next.result && prev.mode === next.mode)

export default ToolResultRenderer

function renderResult(
  toolName: string,
  content: string,
  args: Record<string, unknown>,
  initialLines: number,
  success?: boolean,
) {
  if (toolName === 'manage_chats') {
    const data = tryParseJSON(content) as { chat_id?: string; title?: string; status?: string; content?: string; chats?: Array<{ chat_id: string; title: string; status?: string }> } | null
    const chats = data?.chats ?? (data?.chat_id ? [{ chat_id: data.chat_id, title: data.title ?? 'Открыть чат', status: data.status }] : [])
    return (
      <div>
        {chats.map(chat => (
          <button key={chat.chat_id} className="trr-expand-btn" onClick={() => {
            useNavStore.getState().setMainPage('chat')
            tabActions.selectChat?.(chat.chat_id)
          }}>
            {chat.title}{chat.status ? ` · ${chat.status}` : ''} ↗
          </button>
        ))}
        <ChunkedPre content={data?.content ?? content} initialLines={initialLines} />
      </div>
    )
  }
  // read_file → код с подсветкой (единая «поверхность» кода)
  if (toolName === 'read_file' || toolName === 'read_files') {
    return <ReadResult content={content} args={args} initialLines={initialLines} />
  }

  // write_file / edit_file → плашка файловой операции
  if (toolName === 'write_file' || toolName === 'edit_file') {
    return <FileWrittenResult content={content} args={args} success={success} />
  }

  // run_command обрабатывается выше (единая терминальная карточка)

  // find_files / list_directory → файловое дерево
  if (toolName === 'find_files' || toolName === 'list_directory') {
    return <FileListResult content={content} />
  }

  // search_web → карточки
  if (toolName === 'search_web') {
    return <WebSearchResult content={content} />
  }

  // search_code → строки с совпадениями
  if (toolName === 'search_code') {
    return <SearchCodeResult content={content} />
  }

  // get_file_outline → key-value
  if (toolName === 'get_file_outline') {
    return <KeyValueResult content={content} />
  }

  // fetch_page → header + ChunkedPre (мета-блок + контент)
  if (toolName === 'fetch_page') {
    return <FetchPageResult content={content} initialLines={initialLines} />
  }

  // search_images → карточки с кнопками (БЕЗ рендера картинок)
  if (toolName === 'search_images') {
    return <ImageSearchResult content={content} />
  }

  // list_extensions → key-value (статичный отчёт)
  if (toolName === 'list_extensions') {
    return <KeyValueResult content={content} />
  }

  // MCP-тулы (mcp__server__tool) — пробуем JSON-парсинг, fallback → terminal-стиль
  if (toolName.startsWith('mcp__')) {
    // Пытаемся распарсить JSON-ответ (многие MCP-серверы возвращают JSON)
    try {
      const parsed = JSON.parse(content)
      if (typeof parsed === 'object' && parsed !== null) {
        const formatted = JSON.stringify(parsed, null, 2)
        return <TerminalResult content={formatted} initialLines={initialLines} />
      }
    } catch { /* не JSON — рендерим как текст */ }
    return <TerminalResult content={content} initialLines={initialLines} />
  }

  // default → pre с чанкованием
  return <ChunkedPre content={content} initialLines={initialLines} />
}
