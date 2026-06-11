export default function OverlayPage() {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') window.syntee.overlay.hide()
  }

  return (
    <div
      style={{ width: '100vw', height: '100vh', cursor: 'crosshair' }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      autoFocus
    />
  )
}
