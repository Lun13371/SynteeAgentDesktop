import { lazy, Suspense, type ComponentProps } from 'react'
import type { DiffEditor } from '@monaco-editor/react'
import AppIcon from '../AppIcon/AppIcon'

// Listing changed files does not need Monaco. Load it when a diff is opened.
const MonacoDiffEditor = lazy(() => import('./MonacoDiffEditor'))

export default function SafeDiffEditor(props: ComponentProps<typeof DiffEditor>) {
  return (
    <Suspense fallback={props.loading ?? (
      <div style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%' }}>
        <AppIcon name="loader" size="sm" animation="spin" />
      </div>
    )}>
      <MonacoDiffEditor {...props} />
    </Suspense>
  )
}
