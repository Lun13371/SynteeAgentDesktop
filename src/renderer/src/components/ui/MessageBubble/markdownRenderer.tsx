// ── Markdown-рендер сообщений ────────────────────────────────────────────
//
// Вынесено из MessageBubble.tsx: пайплайн (плагины remark/rehype, компоненты
// разметки, кэш отрендеренных узлов, парс сегментов плана) переиспользуется
// и лентой хода работы, чтобы текст туда шёл ровно с тем же форматированием,
// шрифтом и цветом, что в обычном сообщении.
//
// Компоненты разметки строятся фабрикой createMdComponents({ workdir,
// onOpenFile, onPreviewAttachment }) — без привязки к состоянию конкретного
// пузыря, поэтому вызывающий передаёт свои колбэки.

import * as React from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { PluginUiWidgetPayload } from '@shared/types/plugin'
import { normalizeMathDelimiters } from '@shared/mathNormalize'
import PluginIframe from '../PluginSlot/PluginIframe'
import AppIcon from '../AppIcon/AppIcon'
import FilePathLink from '../FilePathLink/FilePathLink'
import PlanCard from '../PlanCard/PlanCard'
import { collectMarkdownRenderers, collectMessageContextMenu, collectMessageTags, getPluginsExt } from '../../../utils/pluginExtApi'
import { useExtensionsStore } from '../../../store/extensions.store'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import { useChatStore } from '../../../store/chat.store'
import { highlightCodeToHtml } from '../../../utils/codeHighlightHTML'
import { useIsLightTheme } from '../../../utils/themeBase'
import { openFilePath } from '../../../utils/openFilePath'
import { copyToClipboard } from '../../../utils/clipboard'
import type { Attachment, Message } from '../../../../../shared/types'
import { extractPlanSegments } from '../../../../../shared/planParser'
import MermaidBlock from './MermaidBlock'
import ChartBlock from './ChartBlock'

import 'katex/dist/katex.min.css'

const PRE_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '14px 16px',
  background: '#0d0d0f',
  borderRadius: '0 0 8px 8px',
  fontSize: '13px',
  lineHeight: '20.8px',
  display: 'flex',
  alignItems: 'flex-start',
  overflow: 'auto',
}

const CodeHighlighter = memo(function CodeHighlighter({ raw, lang }: { raw: string; lang: string }) {
  // Палитра подсветки зависит от базы темы: на светлой oneDark нечитаем.
  const isLight = useIsLightTheme()
  const html = useMemo(() => highlightCodeToHtml(raw, lang, isLight), [raw, lang, isLight])
  return <pre style={PRE_STYLE} dangerouslySetInnerHTML={{ __html: html }} />
}, (prev, next) => prev.raw === next.raw && prev.lang === next.lang)

// Кнопка копирования код-блока — владеет своим copied-состоянием локально.
// Раньше copiedBlock жил в MessageContent и при каждом клике пересоздавал
// mdComponents → ре-парс ВСЕХ ReactMarkdown-сегментов в сообщении. Теперь
// mdComponents стабилен (useMemo []), копирование не триггерит ре-парс.
const CopyButton = memo(function CopyButton({ raw }: { raw: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={`code-copy-btn ${copied ? 'code-copy-btn--copied' : ''}`}
      onClick={async () => {
        const ok = await copyToClipboard(raw)
        if (!ok) return
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? '✓ Скопировано' : 'Копировать'}
    </button>
  )
})

// ── Редактор чата: textarea для inline-правки текста сообщения ───────────
// Авто-рост по контенту. Значение управляется снаружи (draft в chat.store) —
// пишется в БД только при «Применить и закрыть» (applyEditorDrafts в ChatPage).
export const EditorTextarea = memo(function EditorTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Авто-рост: сброс высоты → scrollHeight. На каждый change value.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 600)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      className="message-editor-textarea"
      value={value}
      onChange={e => onChange(e.target.value)}
      spellCheck={false}
      // Не даём Escape закрывать модалки/меню пока фокус в редакторе.
      onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}
    />
  )
})

// Diff рендерер
const DiffBlock = memo(function DiffBlock({ code }: { code: string }) {
  return (
    <div className="diff-block">
      {code.split('\n').map((line, i) => {
        const cls = line.startsWith('+') ? 'diff-add'
          : line.startsWith('-') ? 'diff-del'
          : line.startsWith('@@') ? 'diff-hunk'
          : 'diff-ctx'
        return <div key={i} className={`diff-line ${cls}`}><span className="diff-line-content">{line || '\u00A0'}</span></div>
      })}
    </div>
  )
})

// ── Кастомный рендерер кодоблока от плагина (registerMarkdownRenderer) ──
// ```language в сообщении, где language совпал с плагинным рендерером
// (регистронезависимо), рендерится iframe-панелью плагина — как mermaid.
// Код передаётся в iframe через widgetData при загрузке.
function PluginMarkdownBlock({ pluginId, entry, height, raw, lang }: {
  pluginId: string
  entry: string
  height: number
  raw: string
  lang: string
}) {
  return (
    <div className="plugin-md-renderer" style={{ height }}>
      <div className="plugin-md-renderer-header">
        <span className="code-lang">{lang.toUpperCase()}</span>
        <span className="plugin-md-renderer-badge" title={`Рендерер плагина ${pluginId}`}>plugin</span>
      </div>
      <PluginIframe
        pluginId={pluginId}
        entry={entry}
        widgetData={{ code: raw, language: lang }}
        className="plugin-md-renderer-frame"
      />
    </div>
  )
}

/** Поиск плагинного markdown-рендерера по language кодоблока. */
function findPluginMdRenderer(lang: string) {
  const l = lang.toLowerCase()
  return collectMarkdownRenderers().find(r => r.language.toLowerCase() === l) ?? null
}

// Admonition блок
const ADMONITION_META: Record<string, { icon: string; label: string; cls: string }> = {
  note:    { icon: '📝', label: 'Заметка',    cls: 'adm--note' },
  info:    { icon: 'ℹ️',  label: 'Инфо',       cls: 'adm--info' },
  tip:     { icon: '💡', label: 'Совет',      cls: 'adm--tip' },
  warning: { icon: '⚠️', label: 'Внимание',   cls: 'adm--warning' },
  danger:  { icon: '🚨', label: 'Опасность',  cls: 'adm--danger' },
}

const AdmonitionBlock = memo(function AdmonitionBlock({ kind, title, children }: { kind: string; title?: string; children: React.ReactNode }) {
  const meta = ADMONITION_META[kind] || ADMONITION_META.note
  return (
    <div className={`adm ${meta.cls}`}>
      <div className="adm-header">
        <span className="adm-icon">{meta.icon}</span>
        <span className="adm-title">{title || meta.label}</span>
      </div>
      <div className="adm-body">{children}</div>
    </div>
  )
})

// Парсим admonitions + <plan>-блоки — вынесено и мемоизировано снаружи
// Возвращает сегменты: md (обычный markdown), admonition (:::note…:::),
// plan (<plan title="…" summary="…" — рендерится в PlanCard).
// allowPlanCard: если false — <plan>-теги НЕ парсятся, остаются как текст.
// Это защищает от рендеринга <plan> вне режима планирования (модель может
// ошибочно написать тег, но он не должен стать PlanCard).
// Module-level кэш segments из parseContent. parseContent делает строковое
// разбиение (admonitions/plan) — не тяжёлое, но при scroll-mount большого
// сообщения каждый раз пересоздаёт массивы. Кэш переиспользуется跨 mounts
// виртуализатора. Ключ — text+allowPlanCard (строки, иммутабельные).
// Мягкий эвикшн кэшей: при переполнении удаляем старейшие записи до `keep`
// (Map упорядочен по вставке). Раньше делали .clear() — это вызывало
// одномоментный ре-парс всех видимых сообщений посреди скролла (фриз).
export function evictOldest<T>(map: Map<string, T>, keep: number) {
  let toDelete = map.size - keep
  for (const key of map.keys()) {
    if (toDelete <= 0) break
    map.delete(key)
    toDelete--
  }
}

const parseContentCache = new Map<string, ReturnType<typeof parseContent>>()
function parseContentCached(raw: string, allowPlanCard = false): ReturnType<typeof parseContent> {
  const key = allowPlanCard ? '1' + raw : '0' + raw
  let segs = parseContentCache.get(key)
  if (!segs) {
    segs = parseContent(raw, allowPlanCard)
    // Ограничиваем размер кэша, чтобы не текло по памяти на длинных чатах.
    if (parseContentCache.size > 200) evictOldest(parseContentCache, 150)
    parseContentCache.set(key, segs)
  }
  return segs
}

export function parseContent(raw: string, allowPlanCard = false): Array<{ type: 'md' | 'admonition' | 'plan'; content: string; kind?: string; title?: string; summary?: string; partial?: boolean }> {
  // 0. Нормализация LaTeX-разделителей математики: \(...\), \[...\] и голые
  //    \begin{env} → $ / $$ (remark-math понимает только доллары). Кэш
  //    parseContentCache ключуется по сырому тексту — нормализованный вывод
  //    консистентен. Код-блоки и инлайн-код не затрагиваются.
  raw = normalizeMathDelimiters(raw)
  // 1. Если PlanCard не разрешён — пропускаем <plan>-парсинг, весь текст как md.
  if (!allowPlanCard) {
    // Просто разбиваем на md + admonition, без plan-сегментов.
    const result: Array<{ type: 'md' | 'admonition' | 'plan'; content: string; kind?: string; title?: string; summary?: string; partial?: boolean }> = []
    const lines = raw.split('\n')
    let i = 0
    let mdBuf: string[] = []
    const ADM_RE = /^:::(note|tip|warning|danger|info)(?:\s+(.+))?$/i
    const flushMd = () => {
      if (mdBuf.length) {
        result.push({ type: 'md', content: mdBuf.join('\n') })
        mdBuf = []
      }
    }
    while (i < lines.length) {
      const m = ADM_RE.exec(lines[i].trim())
      if (m) {
        flushMd()
        const kind = m[1].toLowerCase()
        const title = m[2]
        const body: string[] = []
        i++
        while (i < lines.length && lines[i].trim() !== ':::') { body.push(lines[i]); i++ }
        result.push({ type: 'admonition', content: body.join('\n'), kind, title })
      } else {
        mdBuf.push(lines[i])
      }
      i++
    }
    flushMd()
    return result
  }

  // 2. PlanCard разрешён — парсим <plan>-теги через shared-парсер.
  // PlanCard монтируется сразу когда открылся <plan ...> (partial=true),
  // и растёт вместе со стримом. Когда </plan> пришёл — partial=false,
  // появляются кнопки действий (копировать/открыть файл). Раньше partial
  // даунгрейдился в обычный markdown, но карточка уже умеет стримиться
  // (CSS pulse-рамка, индикатор «пишу план…»), так что даунгрейд не нужен.
  const { segments: planSegs } = extractPlanSegments(raw)

  // 2. Каждый text-сегмент дополнительно разбиваем на md + admonition.
  const result: Array<{ type: 'md' | 'admonition' | 'plan'; content: string; kind?: string; title?: string; summary?: string; partial?: boolean }> = []
  for (const seg of planSegs) {
    if (seg.type === 'plan') {
      result.push({
        type: 'plan',
        content: seg.content,
        title: seg.title,
        summary: seg.summary,
        partial: seg.partial,
      })
      continue
    }
    // text → разбиваем на admonitions
    const lines = seg.content.split('\n')
    let i = 0
    let mdBuf: string[] = []
    const ADM_RE = /^:::(note|tip|warning|danger|info)(?:\s+(.+))?$/i
    const flushMd = () => {
      if (mdBuf.length) {
        result.push({ type: 'md', content: mdBuf.join('\n') })
        mdBuf = []
      }
    }
    while (i < lines.length) {
      const m = ADM_RE.exec(lines[i].trim())
      if (m) {
        flushMd()
        const kind = m[1].toLowerCase()
        const title = m[2]
        const body: string[] = []
        i++
        while (i < lines.length && lines[i].trim() !== ':::') { body.push(lines[i]); i++ }
        result.push({ type: 'admonition', content: body.join('\n'), kind, title })
      } else {
        mdBuf.push(lines[i])
      }
      i++
    }
    flushMd()
  }
  return result
}

// ── safeUrlTransform: пропускаем внутренние схемы через санитайзер ──────
// Дефолтный defaultUrlTransform react-markdown вырезает неизвестные протоколы
// (file-path://, file://) → href=''. Клик по ссылке с пустым href вёл на
// текущую страницу приложения → setWindowOpenHandler → shell.openExternal(URL
// самого приложения) → открывалась ВТОРАЯ копия приложения («перезапуск»).
// Отсюда же «кривая подсветка»: путь получал класс md-link вместо
// file-path-link. Наши схемы пропускаем как есть, остальное — штатный санитайзер.
const safeUrlTransform = (url: string): string =>
  url.startsWith('file-path://') || url.startsWith('file://')
    ? url
    : defaultUrlTransform(url)

// ── Инлайн-виджет плагина ────────────────────────────────────────────────
// Тул плагина может вернуть JSON-маркер вместо текста:
// {"__plugin_ui__":true,"pluginId":"...","entry":"ui/chart.html","data":...,"height":260}
// → рендерим iframe-карточку (PluginIframe) вместо markdown.
function tryParsePluginWidget(content: string): PluginUiWidgetPayload | null {
  const t = content.trim()
  if (!t.startsWith('{"__plugin_ui__"')) return null
  try {
    const obj = JSON.parse(t) as PluginUiWidgetPayload
    if (!obj || obj.__plugin_ui__ !== true) return null
    if (typeof obj.pluginId !== 'string') return null
    // kind='diff' — нативный diff-виджет без iframe: entry не обязателен.
    // kind='badge' — инлайн-бейдж (пилюля): нужен text, entry не нужен.
    const kind = obj.kind ?? 'iframe'
    if (kind === 'iframe' && typeof obj.entry !== 'string') return null
    if (kind === 'diff' && typeof obj.diff !== 'string') return null
    if (kind === 'badge' && typeof obj.text !== 'string') return null
    return obj
  } catch {
    return null
  }
}

/** Инлайн-бейдж плагина (kind='badge'): компактная пилюля в сообщении —
 *  статус/результат без отдельного iframe-виджета. */
function PluginBadgeWidget({ widget }: { widget: PluginUiWidgetPayload }) {
  return (
    <span
      className="plugin-inline-badge"
      style={widget.color ? { borderColor: widget.color, color: widget.color } : undefined}
      title={widget.pluginId}
    >
      {widget.text}
    </span>
  )
}

function PluginDiffWidget({ widget }: { widget: PluginUiWidgetPayload }) {
  // Нативный diff-виджет: title/language сверху, unified diff построчно
  // (те же классы, что у DiffBlock кодоблока в markdown).
  const diffText = widget.diff ?? ''
  return (
    <div className="plugin-inline-widget plugin-diff-widget">
      {(widget.title || widget.language) && (
        <div className="plugin-diff-widget-header">
          {widget.title && <span className="plugin-diff-widget-title">{widget.title}</span>}
          {widget.language && <span className="plugin-diff-widget-lang">{widget.language}</span>}
        </div>
      )}
      <div className="plugin-diff-widget-body diff-block">
        {diffText.split('\n').map((line, i) => {
          const cls = line.startsWith('+') ? 'diff-add'
            : line.startsWith('-') ? 'diff-del'
            : line.startsWith('@@') ? 'diff-hunk'
            : 'diff-ctx'
          return (
            <div key={i} className={`diff-line ${cls}`}>
              <span className="diff-line-content">{line || '\u00A0'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PluginInlineWidget({ widget }: { widget: PluginUiWidgetPayload }) {
  const openPluginPanel = usePluginPanelStore(s => s.openPanel)
  const kind = widget.kind ?? 'iframe'
  // kind='diff' — нативный diff-виджет хоста (iframe не грузим).
  if (kind === 'diff') return <PluginDiffWidget widget={widget} />
  // kind='badge' — инлайн-пилюля (декорация сообщения без iframe).
  if (kind === 'badge') return <PluginBadgeWidget widget={widget} />
  const height = typeof widget.height === 'number' ? widget.height : 260
  // Action-кнопки виджета: command → слэш-команда плагина,
  // panel → открыть панель плагина (registerPanel).
  const widgetActions = widget.actions ?? []
  const runAction = (a: { label: string; command?: string; panel?: string }) => {
    if (a.command) {
      const ext = getPluginsExt()
      if (ext.notificationAction) {
        void ext.notificationAction({ pluginId: widget.pluginId, command: a.command }).catch(() => {})
      }
      return
    }
    if (a.panel) openPluginPanel(widget.pluginId, a.label)
  }
  return (
    <div className="plugin-inline-widget">
      <div className="plugin-inline-widget-frame-wrap" style={{ height }}>
        <PluginIframe
          pluginId={widget.pluginId}
          entry={widget.entry}
          widgetData={widget.data}
          className="plugin-inline-widget-frame"
        />
      </div>
      {widgetActions.length > 0 && (
        <div className="plugin-widget-actions">
          {widgetActions.map((a, i) => (
            <button
              key={`${a.label}-${i}`}
              type="button"
              className="plugin-widget-action-btn"
              onClick={() => runAction(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Контекстные пункты плагинов для сообщения (registerContextMenu) ─────
// Кнопка «⋯» появляется в message-actions рядом с copy/pin/reply, если хоть
// один запущенный плагин зарегистрировал пункты scope:'message'. При открытии
// подмешиваются пункты scope:'selection' (если в документе есть выделение).
// Пункты с button:true рендерятся ОТДЕЛЬНЫМИ кнопками в ряду действий
// (PluginMessageButtons ниже), а в меню «⋯» не попадают.
export function PluginMessageCtxMenu({ message }: { message: Message }) {
  const pluginsList = useExtensionsStore(s => s.plugins)
  const chatId = message.chatId || useChatStore.getState().currentChatId || ''
  const items = useMemo(() => collectMessageContextMenu(), [pluginsList])
  // button-пункты рендерятся отдельными кнопками (PluginMessageButtons) —
  // в меню «⋯» попадают только обычные пункты.
  const messageItems = useMemo(() => items.filter(i => i.scope === 'message' && !i.button), [items])
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null)
  const [visibleItems, setVisibleItems] = useState<typeof items>([])

  // Закрытие: клик вне меню/кнопки или Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      if (btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (messageItems.length === 0) return null

  const toggleMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const selection = (window.getSelection()?.toString() ?? '').trim()
    const selItems = selection ? items.filter(i => i.scope === 'selection') : []
    const shown = [...messageItems, ...selItems]
    setVisibleItems(shown)
    // Оценка высоты — чтобы открывать вверх у нижнего края окна.
    const estH = shown.length * 34 + 16
    const up = rect.bottom + 8 + estH > window.innerHeight
    setPos({ x: Math.max(8, Math.min(rect.right, window.innerWidth - 220)), y: up ? rect.top - 8 : rect.bottom + 8, up })
    setOpen(v => !v)
  }

  const runItem = (pluginId: string, item: { id: string; label: string; sub?: string; icon?: string }, selection: string) => {
    setOpen(false)
    const ext = getPluginsExt()
    if (!ext.contextMenuClick) return
    void ext.contextMenuClick({
      pluginId,
      itemId: item.id,
      payload: { messageId: message.id, chatId, content: message.content ?? '', selection: selection || undefined },
    }).catch(() => {})
  }

  return (
    <>
      <motion.button
        type="button"
        className={`icon-button msg-action-btn plugin-msg-menu-btn${open ? ' plugin-msg-menu-btn--open' : ''}`}
        ref={btnRef}
        onClick={toggleMenu}
        title="Действия плагинов"
        aria-label="Действия плагинов"
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.92 }}
      >
        <AppIcon name="moreHorizontal" size="sm" />
      </motion.button>
      {open && pos && visibleItems.length > 0 && createPortal(
        <motion.div
          ref={menuRef}
          className="plugin-msg-menu"
          style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 9990 }}
          initial={{ opacity: 0, scale: 0.96, y: pos.up ? 4 : -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          {visibleItems.map((it) => {
            const sel = (window.getSelection()?.toString() ?? '').trim()
            const isSelection = it.scope === 'selection'
            return (
              <button
                key={`${it.pluginId}-${it.id}`}
                type="button"
                className="plugin-msg-menu-item"
                onMouseDown={(e) => { e.preventDefault(); runItem(it.pluginId, { id: it.id, label: it.label, icon: it.icon }, isSelection ? sel : '') }}
              >
                <AppIcon name={(it.icon as Parameters<typeof AppIcon>[0]['name']) || 'moreHorizontal'} size="sm" tone="muted" />
                <span>{it.label}</span>
              </button>
            )
          })}
        </motion.div>,
        document.body,
      )}
    </>
  )
}

// ── Кнопки-декорации сообщений от плагинов (registerContextMenu button) ──
// Пункты с button:true — отдельные кнопки в ряду действий сообщения
// (copy/pin/reply), не в меню «⋯». Клик — тот же callHandler 'menu'.
export function PluginMessageButtons({ message }: { message: Message }) {
  const pluginsList = useExtensionsStore(s => s.plugins)
  const chatId = message.chatId || useChatStore.getState().currentChatId || ''
  const buttons = useMemo(
    () => collectMessageContextMenu().filter(i => i.button && i.scope === 'message'),
    [pluginsList],
  )

  if (buttons.length === 0) return null

  const runItem = (pluginId: string, itemId: string) => {
    const ext = getPluginsExt()
    if (!ext.contextMenuClick) return
    void ext.contextMenuClick({
      pluginId,
      itemId,
      payload: { messageId: message.id, chatId, content: message.content ?? '' },
    }).catch(() => {})
  }

  return (
    <>
      {buttons.map(it => (
        <motion.button
          key={`${it.pluginId}-${it.id}`}
          type="button"
          className="icon-button msg-action-btn plugin-msg-action-btn"
          title={it.label}
          aria-label={it.label}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.92 }}
          onClick={() => runItem(it.pluginId, it.id)}
        >
          <AppIcon name={(it.icon as Parameters<typeof AppIcon>[0]['name']) || 'puzzle'} size="sm" />
        </motion.button>
      ))}
    </>
  )
}

// ── Кастомные теги сообщений плагинов (registerMessageTag) ───────────────
// Парный тег <tag attr="...">inner</tag> или самозакрытый <tag attr="..."/>
// рендерится iframe-виджетом плагина вместо markdown. Незарегистрированный
// тег остаётся обычным текстом (в markdown это выглядит как raw HTML —
// react-markdown выводит его как есть, т.к. rehype-raw не подключён, значит
// текст просто не пропадает).
function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr))) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return out
}

function PluginTagWidget({ pluginId, entry, height, attrs, inner }: {
  pluginId: string
  entry: string
  height: number
  attrs: Record<string, string>
  inner: string
}) {
  return (
    <div className="plugin-message-tag" style={{ height }}>
      <PluginIframe
        pluginId={pluginId}
        entry={entry}
        widgetData={{ attrs, inner }}
        className="plugin-message-tag-frame"
      />
    </div>
  )
}

interface PluginTagMatch {
  pluginId: string
  entry: string
  height?: number
  attrs: Record<string, string>
  inner: string
  start: number
  end: number
}

/** Просканировать текст на зарегистрированные теги плагинов. Пусто — нет. */
function scanPluginTags(content: string): PluginTagMatch[] {
  const tags = collectMessageTags()
  if (tags.length === 0) return []
  const byTag = new Map<string, { pluginId: string; entry: string; height?: number }>()
  for (const t of tags) {
    if (t.tag && !byTag.has(t.tag)) byTag.set(t.tag, { pluginId: t.pluginId, entry: t.entry, height: t.height })
  }
  if (byTag.size === 0) return []
  const names = [...byTag.keys()].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(
    `<(${names})((?:\\s+[a-zA-Z_][\\w-]*(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+))?)*)\\s*(?:/>|>([\\s\\S]*?)<\\/\\1\\s*>)`,
    'g',
  )
  const out: PluginTagMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    const meta = byTag.get(m[1])
    if (!meta) continue
    out.push({
      pluginId: meta.pluginId,
      entry: meta.entry,
      height: meta.height,
      attrs: parseAttrs(m[2] || ''),
      inner: m[3] ?? '',
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

// ── renderParsedSegments: рендер массива сегментов из parseContent ─────────
// Переиспользуется в 4 местах (основной рендер, iterations, liveTextAfter).
// Принимает per-instance mdComponents (с доступом к workdir для кликабельных путей).
// plan-сегменты рендерятся в PlanCard (live во время стрима — partial=true, после — с filePath).
export function renderParsedSegments(
  segs: ReturnType<typeof parseContent>,
  remarkPlugins: readonly unknown[],
  rehypePlugins: readonly unknown[],
  planFilePath?: string,
  mdComponents?: Record<string, unknown>,
): React.ReactNode {
  return segs.map((s, i) => {
    if (s.type === 'plan') {
      return (
        <PlanCard
          key={`plan-${i}`}
          title={s.title || 'План'}
          summary={s.summary || ''}
          content={s.content}
          filePath={s.partial ? undefined : planFilePath}
          partial={s.partial}
        />
      )
    }
    if (s.type === 'admonition') {
      return (
        <AdmonitionBlock key={`adm-${i}`} kind={s.kind!} title={s.title}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins as never}
            rehypePlugins={rehypePlugins as never}
            components={mdComponents as never}
            urlTransform={safeUrlTransform}
          >
            {s.content}
          </ReactMarkdown>
        </AdmonitionBlock>
      )
    }
    // Инлайн-виджет плагина: если md-сегмент целиком — JSON-маркер виджета,
    // рендерим PluginIframe вместо markdown.
    const widget = tryParsePluginWidget(s.content)
    if (widget) {
      return <PluginInlineWidget key={`widget-${i}`} widget={widget} />
    }
    // Кастомные теги плагинов (registerMessageTag): разбиваем md-сегмент на
    // под-части — markdown-текст через обычный ReactMarkdown, теги — виджеты.
    const tagMatches = scanPluginTags(s.content)
    if (tagMatches.length > 0) {
      const parts: React.ReactNode[] = []
      let cursor = 0
      tagMatches.forEach((m, ti) => {
        const before = s.content.slice(cursor, m.start)
        if (before.trim()) {
          parts.push(
            <ReactMarkdown
              key={`md-${i}-${ti}`}
              remarkPlugins={remarkPlugins as never}
              rehypePlugins={rehypePlugins as never}
              components={mdComponents as never}
              urlTransform={safeUrlTransform}
            >
              {before}
            </ReactMarkdown>,
          )
        }
        parts.push(
          <PluginTagWidget
            key={`tag-${i}-${ti}`}
            pluginId={m.pluginId}
            entry={m.entry}
            height={typeof m.height === 'number' ? m.height : 260}
            attrs={m.attrs}
            inner={m.inner}
          />,
        )
        cursor = m.end
      })
      const tail = s.content.slice(cursor)
      if (tail.trim()) {
        parts.push(
          <ReactMarkdown
            key={`md-${i}-tail`}
            remarkPlugins={remarkPlugins as never}
            rehypePlugins={rehypePlugins as never}
            components={mdComponents as never}
            urlTransform={safeUrlTransform}
          >
            {tail}
          </ReactMarkdown>,
        )
      }
      return <React.Fragment key={`md-tags-${i}`}>{parts}</React.Fragment>
    }
    return (
      <ReactMarkdown
        key={`md-${i}`}
        remarkPlugins={remarkPlugins as never}
        rehypePlugins={rehypePlugins as never}
        components={mdComponents as never}
        urlTransform={safeUrlTransform}
      >
        {s.content}
      </ReactMarkdown>
    )
  })
}

// ── createMdComponents: per-instance mdComponents с доступом к workdir ───
// Раньше был module-level (стабилен, кэшируемый). Теперь — функция, т.к.
// нужен workdir для кликабельных путей и onOpenFile для code-блоков.
// Кэш parsedRenderCache ключуется по text+workdir — при смене workdir
// кэш-промах, но evictOldest ограничивает рост.
export function showMessageContextMenu(x: number, y: number, items: Array<{ label: string; run: () => void }>): void {
  document.querySelector('.message-link-ctx-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'message-link-ctx-menu'
  for (const item of items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = item.label
    button.addEventListener('click', () => { menu.remove(); item.run() })
    menu.appendChild(button)
  }
  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
  const close = (e: Event) => { if (!menu.contains(e.target as Node)) menu.remove() }
  const closeOnKey = (e: KeyboardEvent) => { if (e.key === 'Escape') menu.remove() }
  setTimeout(() => {
    document.addEventListener('pointerdown', close, { once: true })
    document.addEventListener('keydown', closeOnKey, { once: true })
  }, 0)
}

export function createMdComponents(opts: { workdir?: string; onOpenFile?: (path: string) => void; onPreviewAttachment?: (a: Attachment | null) => void }): Record<string, unknown> {
  const { workdir, onOpenFile, onPreviewAttachment } = opts

  // Обработчик клика на путь файла (code-блоки, заголовки с путём).
  // openFilePath сам резолвит от workdir, парсит суффикс :42-58 и решает
  // по stat: файл в проекте → правая панель, папка/вне проекта → Проводник.
  const handlePathClick = (e: React.MouseEvent, rawPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    void openFilePath(rawPath, workdir)
  }

  // Обработчик клика на ссылку — если это file:// путь, открываем в панели
  const handleLinkClick = (e: React.MouseEvent, href: string) => {
    // file:// путь → открываем через общий флоу (панель/Проводник).
    // preventDefault ДО проверки onOpenFile: иначе при отсутствии колбэка
    // происходила бы дефолтная навигация (открытие второй копии приложения).
    if (href.startsWith('file://')) {
      e.preventDefault()
      // file:///C:/path → C:/path ; file://C:\path → C:\path
      const fp = decodeURIComponent(href.replace(/^file:\/\/\/?/, ''))
      void openFilePath(fp, workdir)
      return
    }
    // Относительный путь без протокола (редко, но возможно)
    if (workdir && !href.startsWith('http') && !href.startsWith('mailto') && /\.\w{1,10}$/.test(href)) {
      e.preventDefault()
      void openFilePath(href, workdir)
      return
    }
    // Иначе — обычная ссылка, браузер откроет
  }

  return {
    code({ className, children }: { className?: string; children?: React.ReactNode }) {
      const match = /language-(\w+)/.exec(className || '')
      const raw = String(children).replace(/\n$/, '')
      const isInline = !match && !raw.includes('\n')
      if (isInline) return <code className="inline-code">{children}</code>
      const lang = match?.[1] || 'text'
      if (lang === 'mermaid') return <MermaidBlock code={raw} />
      if (lang === 'chart') return <ChartBlock code={raw} />
      if (lang === 'diff') return <DiffBlock code={raw} />
      // Кастомный рендерер кодоблока от плагина (registerMarkdownRenderer):
      // если плагин зарегистрировал рендерер для этого языка — грузим его
      // iframe с кодом в widgetData; иначе — обычный код-блок.
      const pluginMd = findPluginMdRenderer(lang)
      if (pluginMd) {
        return (
          <PluginMarkdownBlock
            pluginId={pluginMd.pluginId}
            entry={pluginMd.entry}
            height={pluginMd.height ?? 300}
            raw={raw}
            lang={lang}
          />
        )
      }

      // Парсим info-string на наличие пути: ```ts src/foo.ts
      // info-string — это className после language-, может содержать путь
      const fullInfo = className || ''
      const pathMatch = /\blanguage-(\w+)\s+(.+)/.exec(fullInfo)
      const codePath = pathMatch?.[2]?.trim()

      return (
        <div className="code-block">
          <div
            className={`code-block-header${codePath && onOpenFile ? ' code-block-header--clickable' : ''}`}
            onClick={codePath && onOpenFile ? (e) => handlePathClick(e, codePath) : undefined}
          >
            <span className="code-lang">{lang.toUpperCase()}{codePath ? ` · ${codePath}` : ''}</span>
            <div className="code-block-header-actions">
              {codePath && onOpenFile && (
                <button
                  className="code-block-open-file-btn"
                  onClick={(e) => handlePathClick(e, codePath)}
                  title="Открыть в редакторе"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
              )}
              <CopyButton raw={raw} />
            </div>
          </div>
          <CodeHighlighter raw={raw} lang={lang} />
        </div>
      )
    },
    table({ children }: { children?: React.ReactNode }) { return <div className="md-table-wrap"><table className="md-table">{children}</table></div> },
    thead({ children }: { children?: React.ReactNode }) { return <thead className="md-thead">{children}</thead> },
    tr({ children }: { children?: React.ReactNode }) { return <tr className="md-tr">{children}</tr> },
    th({ children }: { children?: React.ReactNode }) { return <th className="md-th">{children}</th> },
    td({ children }: { children?: React.ReactNode }) { return <td className="md-td">{children}</td> },
    blockquote({ children }: { children?: React.ReactNode }) { return <blockquote className="md-blockquote">{children}</blockquote> },
    a({ href, children }: { href?: string; children?: React.ReactNode }) {
      const onContextMenu = (e: React.MouseEvent<HTMLAnchorElement>) => {
        if (!href || href.startsWith('file-path://')) return
        e.preventDefault()
        e.stopPropagation()
        const isLocal = href.startsWith('file://') || (workdir && !/^(https?:|mailto:)/i.test(href))
        showMessageContextMenu(e.clientX, e.clientY, [
          { label: isLocal ? 'Открыть путь' : 'Открыть ссылку в браузере', run: () => isLocal ? void handleLinkClick({ preventDefault() {}, stopPropagation() {} } as React.MouseEvent, href) : window.open(href, '_blank', 'noopener,noreferrer') },
          { label: 'Копировать адрес', run: () => { void copyToClipboard(href) } },
        ])
      }
      // file-path:// — кликабельный путь файла из remarkFilePaths плагина.
      // FilePathLink: чип с иконкой, статусом существования, peek-превью,
      // контекстным меню; клик → панель/Проводник (openFilePath).
      if (href?.startsWith('file-path://')) {
        const rawPath = decodeURIComponent(href.replace(/^file-path:\/\//, ''))
        return <FilePathLink raw={rawPath} workdir={workdir} onPreviewAttachment={onPreviewAttachment ?? undefined} />
      }
      // file:// — путь к файлу на диске, открываем в правой панели
      if (href?.startsWith('file://')) {
        return (
          <a
            href={href}
            className="md-link"
            onClick={(e) => handleLinkClick(e, href)}
            onContextMenu={onContextMenu}
          >
            {children}
          </a>
        )
      }
      // Пустой href (санитайзер вырезал протокол) — НЕ кликабельная ссылка:
      // href='' означал бы переход на текущую страницу приложения.
      if (!href) {
        return <span className="md-link">{children}</span>
      }
      // Обычная ссылка — открываем в браузере. title показывает полный URL
      // (полезно для [текст](url) — куда реально ведёт).
      return (
        <a
          href={href}
          className="md-link"
          target="_blank"
          rel="noreferrer"
          title={href}
          onClick={(e) => handleLinkClick(e, href)}
          onContextMenu={onContextMenu}
        >
          {children}
        </a>
      )
    },
    hr() { return <hr className="md-hr" /> },
    p({ children }: { children?: React.ReactNode }) {
      return <p>{children}</p>
    },
    img({ src, alt }: { src?: string; alt?: string }) {
      if (!src) return null
      return <ChatImage src={src} alt={alt || ''} onPreviewAttachment={onPreviewAttachment} />
    },
  }
}

// ── ChatImage: красивый рендер картинок в чате ──
// Скелетон пока грузится → клик открывает AttachmentPreviewModal (zoom/pan) →
// hover показывает кнопки: копировать URL, копировать markdown, открыть в браузере.
let chatImgCounter = 0
const ChatImage = memo(function ChatImage({ src, alt, onPreviewAttachment }: {
  src: string
  alt: string
  onPreviewAttachment?: (a: Attachment | null) => void
}) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState<'url' | 'md' | null>(null)

  // Синтетический Attachment для AttachmentPreviewModal
  const handleOpenPreview = useCallback(() => {
    if (!onPreviewAttachment) {
      // Fallback — открыть в браузере
      window.open(src, '_blank')
      return
    }
    // Извлекаем имя файла из URL
    let name = alt || 'image'
    try {
      const u = new URL(src)
      const basename = u.pathname.split('/').pop()
      if (basename && /\.\w{1,5}$/.test(basename)) name = basename
    } catch { /* not a URL, use alt */ }
    onPreviewAttachment({
      id: `chat-img-${++chatImgCounter}`,
      kind: 'image',
      name,
      dataUrl: src,
      source: 'paste' as const,
      attachedAt: Date.now(),
    })
  }, [src, alt, onPreviewAttachment])

  const handleCopyUrl = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    void copyToClipboard(src).then((ok) => {
      if (ok) {
        setCopied('url')
        setTimeout(() => setCopied(null), 1500)
      }
    })
  }, [src])

  const handleCopyMd = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const md = `![${alt || 'image'}](${src})`
    void copyToClipboard(md).then((ok) => {
      if (ok) {
        setCopied('md')
        setTimeout(() => setCopied(null), 1500)
      }
    })
  }, [src, alt])

  const handleOpenExternal = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    window.open(src, '_blank')
  }, [src])

  if (error) {
    return (
      <div className="chat-img-error" title={`URL: ${src}`}>
        <svg className="chat-img-error-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
          <line x1="3" y1="14" x2="8" y2="14" />
        </svg>
        <span className="chat-img-error-text">
          {alt || 'Изображение не загрузилось'}
        </span>
        <button
          className="chat-img-error-btn"
          onClick={(e) => { e.stopPropagation(); window.open(src, '_blank') }}
          title="Открыть в браузере"
        >
          Открыть
        </button>
      </div>
    )
  }

  return (
    <figure className="chat-img-figure">
      <div className="chat-img-container" onClick={handleOpenPreview}>
        {/* Skeleton пока не загружено */}
        {!loaded && <div className="chat-img-skeleton" />}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className={`chat-img${loaded ? ' chat-img--loaded' : ''}`}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          draggable={false}
        />
        {/* Hover actions — top-right */}
        {loaded && (
          <div className="chat-img-actions" onClick={(e) => e.stopPropagation()}>
            <button className="chat-img-action-btn" onClick={handleOpenPreview} title="Открыть в просмотре">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6"/><path d="M10 14L21 3"/>
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              </svg>
            </button>
            <button className="chat-img-action-btn" onClick={handleCopyUrl} title="Копировать URL">
              {copied === 'url' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              )}
            </button>
            <button className="chat-img-action-btn" onClick={handleCopyMd} title="Копировать markdown">
              {copied === 'md' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>
                </svg>
              )}
            </button>
            <button className="chat-img-action-btn" onClick={handleOpenExternal} title="Открыть в браузере">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
            </button>
          </div>
        )}
      </div>
      {alt && <figcaption className="chat-img-caption">{alt}</figcaption>}
    </figure>
  )
}, (prev, next) => prev.src === next.src && prev.alt === next.alt && prev.onPreviewAttachment === next.onPreviewAttachment)

// ── Module-level кэш отрендеренного ReactNode-дерева по text.
// Виртуализатор монтирует/демонтирует MessageBubble при скролле; ParsedContent
// memo per-instance теряется при unmount → ReactMarkdown заново парсит весь
// markdown (remark→mdast→hast→JSX). Для большого сообщения это 0.3–0.5с фриз
// на КАЖДОМ scroll-remount. Кэш хранит готовое React-дерево; при remount
// берём из кэша — ре-парс пропускается. Безопасно: mdComponents module-level
// стабилен, компоненты (CodeHighlighter/MermaidBlock/CopyButton) те же.
// Ключ: text + allowPlanCard + набор плагинов (стрим/не-стрим/math/нет-math).
const parsedRenderCache = new Map<string, React.ReactNode>()

// ── ParsedContent: мемоизированный рендер parseContent ──────────────────
// Раньше parseContent(...) звался инлайн при каждом флеше стрима (20×/сек),
// ре-парся markdown AST + KaTeX каждый раз. Теперь каждый экземпляр
// мемоизирует парс на [text, allowPlanCard] — ре-парс только если текст
// реально изменился. Невидимо: вывод идентичный.
export const ParsedContent = memo(function ParsedContent({
  text, allowPlanCard, remarkPlugins, rehypePlugins, planFilePath, isStreaming, mdComponents, workdir,
}: {
  text: string
  allowPlanCard: boolean
  remarkPlugins: readonly unknown[]
  rehypePlugins: readonly unknown[]
  planFilePath?: string
  isStreaming?: boolean
  mdComponents?: Record<string, unknown>
  workdir?: string
}) {
  const segs = useMemo(() => parseContentCached(text, allowPlanCard), [text, allowPlanCard])
  const wdKey = workdir ?? ''

  // ── Инкрементальный рендер во время стриминга ──
  // Во время стрима text растёт каждые 50мс. Кэш parsedRenderCache ключуется
  // по всему тексту → MISS на каждом флеше → O(n) ре-парс.
  //
  // Оптимизация: разбиваем text на стабильный префикс + активный хвост.
  // Стабильный префикс = всё до последней границы блока (\n\n, ```, :::).
  // Префикс кэшируется в parsedRenderCache → hit на каждом флеше.
  // Хвост парсится ReactMarkdown → O(|хвост|) вместо O(n).
  // Полный markdown (таблицы, списки, bold, код) сохраняется во время стрима.
  if (isStreaming && text) {
    // Ищем последнюю границу блока — после неё текст может быть неполным
    const lastFence = text.lastIndexOf('```')
    const lastPara = text.lastIndexOf('\n\n')
    const lastAdm = text.lastIndexOf('\n:::')
    // Если код-блок ОТКРЫТ (нечётное количество ```), последний ``` —
    // открывающий fence. Границы \n\n/::: ВНУТРИ блока (после lastFence)
    // разрывают блок на prefix/tail → ReactMarkdown рендерит половину
    // кода как текст. Не используем их — splitAt = lastFence.
    const fenceCount = (text.match(/```/g) || []).length
    const splitAt = (fenceCount % 2 === 1 && lastFence >= 0)
      ? lastFence
      : Math.max(lastFence, lastPara, lastAdm)
    if (splitAt > 100 && splitAt < text.length - 1) {
      // Есть стабильный префикс — кэшируем его, хвост парсим отдельно
      const prefix = text.slice(0, splitAt)
      const tail = text.slice(splitAt)
      const prefixKey = prefix + '|stream|' + (allowPlanCard ? '1' : '0')
        + '|' + (remarkPlugins === undefined ? '' : remarkPlugins.length)
        + '|' + (rehypePlugins === undefined ? '' : rehypePlugins.length)
        + '|' + wdKey
      let prefixNode = parsedRenderCache.get(prefixKey)
      if (!prefixNode) {
        const prefixSegs = parseContentCached(prefix, allowPlanCard)
        prefixNode = renderParsedSegments(prefixSegs, remarkPlugins, rehypePlugins, planFilePath, mdComponents)
        if (parsedRenderCache.size > 150) evictOldest(parsedRenderCache, 100)
        parsedRenderCache.set(prefixKey, prefixNode)
      }
      // Хвост — короткий, парсим ReactMarkdown каждый флеш (дёшево)
      const tailSegs = parseContentCached(tail, allowPlanCard)
      const tailNode = renderParsedSegments(tailSegs, remarkPlugins, rehypePlugins, planFilePath, mdComponents)
      return <>{prefixNode}{tailNode}</>
    }
    // Нет стабильного префикса (начало ответа) — парсим весь text через ReactMarkdown.
    // remarkGfm (без KaTeX) — дёшево, полный markdown сохраняется.
    const cacheKey = text + '|stream|' + (allowPlanCard ? '1' : '0')
      + '|' + (remarkPlugins === undefined ? '' : remarkPlugins.length)
      + '|' + (rehypePlugins === undefined ? '' : rehypePlugins.length)
      + '|' + wdKey
    let node = parsedRenderCache.get(cacheKey)
    if (!node) {
      node = renderParsedSegments(segs, remarkPlugins, rehypePlugins, planFilePath, mdComponents)
      if (parsedRenderCache.size > 150) evictOldest(parsedRenderCache, 100)
      parsedRenderCache.set(cacheKey, node)
    }
    return <>{node}</>
  }

  // Финальный рендер (isStreaming=false) — полный парс с кэшированием
  const cacheKey = text + '|' + (allowPlanCard ? '1' : '0')
    + '|' + (remarkPlugins === undefined ? '' : remarkPlugins.length)
    + '|' + (rehypePlugins === undefined ? '' : rehypePlugins.length)
    + '|' + (planFilePath ?? '')
    + '|' + wdKey
  let node = parsedRenderCache.get(cacheKey)
  if (!node) {
    node = renderParsedSegments(segs, remarkPlugins, rehypePlugins, planFilePath, mdComponents)
    if (parsedRenderCache.size > 150) evictOldest(parsedRenderCache, 100)
    parsedRenderCache.set(cacheKey, node)
  }
  return <>{node}</>
}, (prev, next) =>
  prev.text === next.text &&
  prev.allowPlanCard === next.allowPlanCard &&
  prev.remarkPlugins === next.remarkPlugins &&
  prev.rehypePlugins === next.rehypePlugins &&
  prev.planFilePath === next.planFilePath &&
  prev.isStreaming === next.isStreaming &&
  prev.workdir === next.workdir
)
