/** The chats in the order the sidebar shows them: its rows on screen, else `fallback` (the sidebar is hidden). */
export function sidebarOrder(fallback: readonly string[]): string[] {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-chat]')]
  const ids = rows.map((r) => r.dataset.chat).filter((id): id is string => !!id)
  return ids.length ? ids : [...fallback]
}

/** The chat `step` places from `current` in `order`, wrapping at the ends; with none open, the first or the last. */
export function stepChat(
  order: readonly string[],
  current: string | undefined,
  step: 1 | -1,
): string | undefined {
  if (!order.length) return undefined
  const at = current ? order.indexOf(current) : -1
  if (at === -1) return step === 1 ? order[0] : order.at(-1)
  return order[(at + step + order.length) % order.length]
}
