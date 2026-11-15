// ── MessageFileChanges: чипы «файлы, которые изменил агент» ───────────────
//
// Показываются в КОНЦЕ assistant-сообщения — после текста ответа, перед
// футером. Визуально это те же чипы, что и inline-вложения [[attach:...]]
// (.inline-attach--file из InlineAttachmentRenderer.css), плюс счётчик
// +N/−M строк и пометка «создан».
//
// Клик по чипу открывает файл через общий open-флоу (workdir → правая
// панель с редактором, вне workdir → системный вьюер, нет файла → тост).
//
// Данные приходят из collectFileChanges() — чистая функция в shared,
// тестируется отдельно (tests/message-file-changes.test.mjs).

import { memo, useEffect, useMemo, useState } from 'react'
import {
  collectFileChanges,
  displayFilePath,
  fileBaseName,
  sumFileChanges,
} from '../../../../../shared/fileChanges'
import type { ToolStep } from '../../../../../shared/types/chat'
import { openFilePath } from '../../../utils/openFilePath'
import './MessageFileChanges.css'

const VISIBLE_LIMIT = 6

function FileGlyph({ created }: { created: boolean }): React.ReactElement {
  if (created) {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="12" x2="12" y2="18" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </svg>
    )
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  )
}

export interface MessageFileChangesProps {
  /** Шаги сообщения (iterations[].steps или toolSteps). */
  steps?: readonly ToolStep[]
  /** Рабочая директория чата — для относительного пути и открытия файла. */
  workdir?: string
}

/** Пометка состояния файла: «создан и удалён» / «удалён» / «создан».
 *  «Создан и удалён» — временный скрипт запроса (напр. смоук, удалённый
 *  после прогона): чип иначе выглядел бы обычной правкой. */
function fileStateLabel(f: { path: string; created: boolean }, removedOnDisk: Set<string>): string | null {
  const gone = removedOnDisk.has(f.path)
  if (f.created && gone) return 'создан и удалён'
  if (gone) return 'удалён'
  if (f.created) return 'создан'
  return null
}

function MessageFileChanges({ steps, workdir }: MessageFileChangesProps): React.ReactElement | null {
  const files = useMemo(() => collectFileChanges(steps), [steps])
  const [expanded, setExpanded] = useState(false)
  // Пути, которых нет на диске в момент рендера: файл удалён (в том же
  // запросе или позже). Проверяется батч-IPC после расчёта чипов — до ответа
  // пометок нет, чипы не «прыгают».
  const [removedOnDisk, setRemovedOnDisk] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (files.length === 0) return
    let cancelled = false
    const rel: string[] = []
    const abs: string[] = []
    for (const f of files) {
      if (/^[a-zA-Z]:[\\/]/.test(f.path) || f.path.startsWith('\\\\')) abs.push(f.path)
      else rel.push(f.path)
    }
    const run = async (): Promise<void> => {
      const gone = new Set<string>()
      try {
        // Относительные — одним батчем от workdir; абсолютные — по одному
        // через statPath (checkFilesExist отсекает пути вне root).
        if (rel.length > 0 && workdir) {
          const res = await window.syntee.fs.checkFilesExist({ root: workdir, relPaths: rel })
          const existing = new Set(res?.existing ?? [])
          for (const p of rel) if (!existing.has(p)) gone.add(p)
        }
        for (const p of abs) {
          const st = await window.syntee.fs.statPath(p).catch(() => null)
          if (!st?.exists) gone.add(p)
        }
      } catch { /* IPC недоступен — чипы без пометок, это норм */ }
      if (!cancelled && gone.size > 0) setRemovedOnDisk(gone)
    }
    void run()
    return () => { cancelled = true }
  }, [files, workdir])

  if (files.length === 0) return null

  const stats = sumFileChanges(files)
  const visible = expanded ? files : files.slice(0, VISIBLE_LIMIT)
  const hidden = files.length - visible.length

  return (
    <div className="message-file-changes" role="group" aria-label="Изменённые файлы">
      <span className="message-file-changes__caption">
        {stats.created > 0 && files.length === stats.created
          ? `Создано ${files.length}`
          : stats.created > 0
            ? `Изменено ${files.length} (создано ${stats.created})`
            : `Изменено ${files.length}`}
        <span className="message-file-changes__total">
          <span className="is-add">+{stats.adds}</span>
          <span className="is-del">−{stats.dels}</span>
        </span>
      </span>

      <div className="message-file-changes__row">
        {visible.map(f => {
          const shown = displayFilePath(f.path, workdir)
          const name = fileBaseName(shown)
          const dir = shown.slice(0, Math.max(0, shown.length - name.length)).replace(/\/$/, '')
          return (
            <button
              type="button"
              key={f.path}
              className={`inline-attach inline-attach--file inline-attach--clickable message-file-change${f.created ? ' message-file-change--created' : ''}`}
              title={shown + (f.created ? '\nСоздан' : '') + `\n+${f.adds} −${f.dels}`}
              onClick={e => {
                e.stopPropagation()
                const diff = f.patches.join('\n\n')
                void openFilePath(f.path, workdir, diff
                  ? { changeDiff: diff }
                  : undefined)
              }}
            >
              <span className="inline-attach-icon">
                <FileGlyph created={f.created} />
              </span>
              <span className="message-file-change__names">
                <span className="inline-attach-name">{name}</span>
                {dir && <span className="message-file-change__dir">{dir}</span>}
              </span>
              <span className="message-file-change__stat">
                <span className="is-add">+{f.adds}</span>
                {f.dels > 0 && <span className="is-del">−{f.dels}</span>}
              </span>
              {fileStateLabel(f, removedOnDisk) && (
                <span className="message-file-change__state">{fileStateLabel(f, removedOnDisk)}</span>
              )}
            </button>
          )
        })}

        {hidden > 0 && (
          <button
            type="button"
            className="inline-attach inline-attach--clickable message-file-changes__more"
            onClick={e => {
              e.stopPropagation()
              setExpanded(true)
            }}
          >
            <span className="inline-attach-name">ещё {hidden}</span>
          </button>
        )}
        {expanded && files.length > VISIBLE_LIMIT && (
          <button
            type="button"
            className="inline-attach inline-attach--clickable message-file-changes__more"
            onClick={e => {
              e.stopPropagation()
              setExpanded(false)
            }}
          >
            <span className="inline-attach-name">свернуть</span>
          </button>
        )}
      </div>
    </div>
  )
}

export default memo(MessageFileChanges)
