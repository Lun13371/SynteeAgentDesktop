import { useEffect, useRef } from 'react'
import { DiffEditor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

// Офлайн Monaco (повторный вызов loader.config безопасен)
loader.config({ monaco })

// ── SafeDiffEditor — обёртка над Monaco DiffEditor ───────────────────────
// @monaco-editor/react DiffEditor имеет race condition: при unmount React
// диспозит TextModels раньше, чем DiffEditorWidget успевает их сбросить
// → "TextModel got disposed before DiffEditorWidget model got reset".
// Фикс: через onMount перехватываем editor, в cleanup effect вручную
// снимаем модели и диспозит виджет ДО того, как React начнёт разбирать
// компонент. Тяжёлый teardown (dispose виджета: две view, декорации, DOM)
// отложен на requestAnimationFrame — закрытие git-вкладки/диффа больше
// не блокирует кадр синхронно; setModel(null) синхронно сохраняет фикс
// race (виджет больше не ссылается на модели).
export default function MonacoDiffEditor(props: React.ComponentProps<typeof DiffEditor>) {
  const editorRef = useRef<Parameters<NonNullable<React.ComponentProps<typeof DiffEditor>['onMount']>>[0] | null>(null)
  const keepModelsRef = useRef({ original: false, modified: false })

  useEffect(() => {
    keepModelsRef.current.original = props.keepCurrentOriginalModel ?? false
    keepModelsRef.current.modified = props.keepCurrentModifiedModel ?? false
  }, [props.keepCurrentOriginalModel, props.keepCurrentModifiedModel])

  useEffect(() => {
    const keepModels = keepModelsRef.current
    return () => {
      const ed = editorRef.current
      editorRef.current = null
      if (ed) {
        const models = ed.getModel()
        try { ed.setModel(null) } catch { /* already disposed */ }
        // Detaching the models prevents @monaco-editor/react from finding them
        // during cleanup, so release them here according to its retention flags.
        if (!keepModels.original) models?.original.dispose()
        if (!keepModels.modified) models?.modified.dispose()
        requestAnimationFrame(() => {
          try { ed.dispose() } catch { /* already disposed */ }
        })
      }
    }
  }, [])

  return (
    <DiffEditor
      {...props}
      onMount={(editor, monaco) => {
        editorRef.current = editor
        props.onMount?.(editor, monaco)
      }}
    />
  )
}
