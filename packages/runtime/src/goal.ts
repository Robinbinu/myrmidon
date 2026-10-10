import type { RoundGoal } from '@myrmidon/protocol'

/** A command in backticks names the condition exactly: it holds when the command exits 0. */
const COMMAND = /`([^`]+)`/
/** "the tests pass", "checks are green", "all tests succeed": the project's own checks decide it. */
const CHECKS = /\b(?:tests?|checks?)\b.*\b(?:pass(?:es|ing)?|green|succeed(?:s|ing)?)\b/i

/**
 * Reads a goal message, `<condition>: <request>` (`/goal until the tests pass: fix the parser`): the condition, and how
 * it is checked. A condition in backticks may hold a colon of its own, so the split comes after the closing backtick.
 * Without a colon, the whole message is the condition, and the reviewer judges when it holds.
 */
export function parseGoal(text: string): { condition: string; check: RoundGoal['check'] } {
  const trimmed = text.trim()
  const closing = trimmed.startsWith('`') ? trimmed.indexOf('`', 1) : -1
  const split = /:\s/.exec(trimmed.slice(closing + 1))
  const head = split ? trimmed.slice(0, closing + 1 + split.index) : trimmed
  const condition = head.replace(/^until\s+/i, '').trim() || trimmed
  const command = COMMAND.exec(condition)?.[1]?.trim()
  if (command) return { condition, check: { kind: 'command', run: command } }
  if (CHECKS.test(condition)) return { condition, check: { kind: 'checks' } }
  return { condition, check: { kind: 'judge' } }
}
