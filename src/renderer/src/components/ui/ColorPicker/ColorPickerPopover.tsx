import { type RefObject } from 'react'
import Popover from '../Popover/Popover'
import ColorPicker from './ColorPicker'

export interface ColorPickerPopoverProps {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement>
  value: string
  onChange: (hex: string) => void
  onCommit?: (hex: string) => void
  recent?: string[]
}

export default function ColorPickerPopover({
  open, onClose, anchorRef, value, onChange, onCommit, recent,
}: ColorPickerPopoverProps) {
  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} side="auto" align="start">
      <ColorPicker
        value={value}
        onChange={onChange}
        onCommit={onCommit}
        recent={recent}
      />
    </Popover>
  )
}
