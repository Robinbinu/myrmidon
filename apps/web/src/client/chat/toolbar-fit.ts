import { TOOLBAR_FOLD_SLACK_PX } from '../ui-config.ts'

/** The Send button (size-9): the only control beside the chips while nothing runs. */
const SEND_PX = 36

/**
 * The width the chips in `row` take when none is cut short. Measured by letting the row size to its content for a
 * moment, inside a layout effect, so nothing is painted in between.
 */
export function naturalWidth(row: HTMLElement): number {
  const { flex, width } = row.style
  row.style.flex = 'none'
  row.style.width = 'max-content'
  const full = row.offsetWidth
  row.style.flex = flex
  row.style.width = width
  return full
}

/**
 * The room the chips have with only Send beside them. Running adds the delivery toggle and Stop, which take room from
 * the chips for a while; measured this way, the start and end of every round don't fold and unfold them.
 */
export function idleRoom(row: HTMLElement, actions: HTMLElement): number {
  return row.clientWidth + actions.offsetWidth - SEND_PX
}

/**
 * Whether the chips should be folded: once they don't fit, and until they fit with some room to spare, so a width
 * right at the edge doesn't flip them back and forth.
 */
export function shouldFold(folded: boolean, room: number, natural: number): boolean {
  return folded ? room < natural + TOOLBAR_FOLD_SLACK_PX : room < natural
}
