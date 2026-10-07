import type { JSX, ReactNode } from 'react'

/** Types for the vendored React Bits SpringCheck component (SpringCheck.jsx). */
export interface SpringCheckProps {
  label?: ReactNode
  checked?: boolean
  defaultChecked?: boolean
  onChange?: (checked: boolean) => void
  disabled?: boolean
  color?: string
  fillColor?: string
  checkColor?: string
  boxSize?: number
  boxRadius?: number
  fontSize?: number
  bounce?: number
  strikeLag?: number
  doneOpacity?: number
  strike?: 'left' | 'center' | 'right' | 'none'
  ariaLabel?: string
  className?: string
}

declare function SpringCheck(props: SpringCheckProps): JSX.Element
export default SpringCheck
