import { expect, test } from 'bun:test'
import { shouldFold } from '../src/client/chat/toolbar-fit.ts'
import { TOOLBAR_FOLD_SLACK_PX } from '../src/client/ui-config.ts'

test('the toolbar chips fold when they no longer fit, and unfold only with room to spare', () => {
  const natural = 700
  expect(shouldFold(false, 754, natural)).toBe(false)
  expect(shouldFold(false, 699, natural)).toBe(true)
  // Folded, a width just past the chips' own does not unfold them yet; it takes the slack on top.
  expect(shouldFold(true, 701, natural)).toBe(true)
  expect(shouldFold(true, natural + TOOLBAR_FOLD_SLACK_PX, natural)).toBe(false)
})
