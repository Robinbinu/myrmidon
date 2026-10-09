import { Trash2 } from 'lucide-react'
import { type KeyboardEvent, type ReactElement, type ReactNode, useRef, useState } from 'react'
import { CONFIRM_ARM_DELAY_MS } from '../ui-config.ts'
import { Button, IconButton } from './primitives.tsx'

/**
 * What a second, confirming step needs against the press that armed it: a held key's repeats would press it, and so
 * would the second click of a double-click. Call `arm` as it appears; `repeat` swallows a repeated key (true when it
 * did), and `tooSoon` says a click came within CONFIRM_ARM_DELAY_MS of arming.
 */
export function useArmGuard() {
  const armedAt = useRef(0)
  return {
    arm: () => {
      armedAt.current = performance.now()
    },
    repeat: (e: KeyboardEvent) => {
      if (e.repeat) e.preventDefault()
      return e.repeat
    },
    tooSoon: () => performance.now() - armedAt.current < CONFIRM_ARM_DELAY_MS,
  }
}

/**
 * A removal that takes two clicks: the first arms it and says what happens, the second does it. Moving focus away or
 * pressing Escape disarms it, so one stray click never removes anything.
 */
export function ConfirmButton(props: {
  /** The button's text, or with `icon` the trash button's accessible name. */
  label: string
  /** An accessible name for the text button when its label alone is ambiguous in a list. */
  name?: string
  /** The icon button's tooltip, when it has more to say than its name. */
  title?: string
  /** What the armed button says, such as "Yes, remove channel". */
  confirm: string
  onConfirm(): void
  /** An icon button instead of text: the trash can, or the glyph given for a removal that deletes nothing. */
  icon?: boolean | ReactElement
  /** A consequence worth spelling out, shown beside the armed button. */
  warning?: ReactNode
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  // Disarming with Escape puts focus back on the first button rather than losing it to the page.
  const [refocus, setRefocus] = useState(false)
  const guard = useArmGuard()
  const arm = () => {
    guard.arm()
    setArmed(true)
  }
  if (armed)
    return (
      <span data-armed className="inline-flex items-center gap-2">
        {props.warning && (
          <span role="alert" className="max-w-64 text-right text-small leading-snug text-bad-ink">
            {props.warning}
          </span>
        )}
        <Button
          size="sm"
          variant="danger"
          // The armed button replaces the one just clicked, so focus has to move onto it for blur to disarm it.
          autoFocus
          // Safari does not focus a clicked button, so pressing this one would otherwise blur it and disarm it
          // before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onBlur={() => {
            setArmed(false)
            setRefocus(false)
          }}
          onKeyDown={(e) => {
            if (guard.repeat(e)) return
            // Escape here only disarms; it must not also close the page around it.
            if (e.key !== 'Escape') return
            e.stopPropagation()
            setArmed(false)
            setRefocus(true)
          }}
          onClick={() => {
            if (guard.tooSoon()) return
            setArmed(false)
            setRefocus(false)
            props.onConfirm()
          }}
        >
          {props.confirm}
        </Button>
      </span>
    )
  return props.icon ? (
    <IconButton
      size="sm"
      label={props.label}
      title={props.title}
      disabled={props.disabled}
      autoFocus={refocus}
      onClick={arm}
    >
      {props.icon === true ? <Trash2 className="size-4" /> : props.icon}
    </IconButton>
  ) : (
    <Button
      size="sm"
      variant="borderless"
      aria-label={props.name}
      disabled={props.disabled}
      autoFocus={refocus}
      onClick={arm}
    >
      {props.label}
    </Button>
  )
}
