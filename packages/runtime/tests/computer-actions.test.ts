import { expect, test } from 'bun:test'
import {
  allows,
  anthropicToolsetPayload,
  appTier,
  appWarning,
  canRaise,
  computerCombo,
  computerProtocol,
  fromGeneric,
  fromOpenAi,
  imageLimits,
  isOwnApp,
  labelAt,
  parseCombo,
  pointerOf,
  screenPoint,
  screenshotEdge,
  sendsOrRuns,
  sensitiveLabel,
  sessionOf,
  UnsupportedAction,
} from '../src/index.ts'

test('the generic tool and Anthropic toolset members map to one action set', () => {
  expect(fromGeneric('left_click', { coordinate: [10.4, 20.6] })).toEqual({
    kind: 'click',
    at: [10, 21],
    button: 'left',
    count: 1,
    modifiers: [],
  })
  expect(fromGeneric('double_click', { coordinate: [1, 2], text: 'shift+super' })).toMatchObject({
    count: 2,
    modifiers: ['shift', 'cmd'],
  })
  expect(fromGeneric('triple_click', { coordinate: [1, 2] })).toMatchObject({ count: 3 })
  expect(fromGeneric('right_click', {})).toEqual({ kind: 'click', button: 'right', count: 1, modifiers: [] })
  expect(fromGeneric('left_click_drag', { start_coordinate: [1, 2], coordinate: [3, 4] })).toEqual({
    kind: 'drag',
    from: [1, 2],
    to: [3, 4],
  })
  expect(fromGeneric('scroll', { coordinate: [5, 6], scroll_direction: 'down', scroll_amount: 99 })).toEqual({
    kind: 'scroll',
    at: [5, 6],
    direction: 'down',
    amount: 50,
  })
  expect(fromGeneric('key', { text: 'ctrl+s', repeat: 3 })).toEqual({
    kind: 'key',
    keys: ['ctrl', 's'],
    repeat: 3,
  })
  expect(fromGeneric('key', { text: 'Return' })).toEqual({ kind: 'key', keys: ['return'], repeat: 1 })
  expect(fromGeneric('wait', { duration: 999 })).toEqual({ kind: 'wait', seconds: 30 })
  expect(fromGeneric('zoom', { region: [0, 0, 10, 10] })).toEqual({ kind: 'zoom', region: [0, 0, 10, 10] })
  expect(fromGeneric('click_element', { element: 4 })).toEqual({
    kind: 'click_element',
    element: 4,
    button: 'left',
    count: 1,
  })
  expect(fromGeneric('open_app', { app: ' Notes ', full_control: true })).toEqual({
    kind: 'open_app',
    app: 'Notes',
    fullControl: true,
  })
  expect(() => fromGeneric('left_mouse_down', {})).toThrow(UnsupportedAction)
  expect(() => fromGeneric('hold_key', { text: 'shift' })).toThrow(/not supported/)
  expect(() => fromGeneric('left_click', { coordinate: [1] })).toThrow(/\[x, y\]/)
  expect(() => fromGeneric('key', { text: 'cmd+shift' })).toThrow(/one key/)
})

test("OpenAI's native computer actions map to the same set, batch and all", () => {
  const actions = fromOpenAi([
    { type: 'click', button: 'wheel', x: 3, y: 4, keys: ['CTRL'] },
    { type: 'double_click', x: 5, y: 6, keys: null },
    {
      type: 'drag',
      path: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 9, y: 9 },
      ],
    },
    { type: 'keypress', keys: ['CMD', 'A'] },
    { type: 'scroll', x: 10, y: 10, scroll_x: 0, scroll_y: -350 },
    { type: 'scroll', x: 10, y: 10, scroll_x: 120, scroll_y: 0 },
    { type: 'type', text: 'hi' },
    { type: 'move', x: 7, y: 8 },
    { type: 'wait' },
    { type: 'screenshot' },
  ])
  expect(actions).toEqual([
    { kind: 'click', at: [3, 4], button: 'middle', count: 1, modifiers: ['ctrl'] },
    { kind: 'click', at: [5, 6], button: 'left', count: 2, modifiers: [] },
    { kind: 'drag', from: [1, 1], to: [9, 9] },
    { kind: 'key', keys: ['cmd', 'a'], repeat: 1 },
    { kind: 'scroll', at: [10, 10], direction: 'up', amount: 4 },
    { kind: 'scroll', at: [10, 10], direction: 'right', amount: 1 },
    { kind: 'type', text: 'hi' },
    { kind: 'move', at: [7, 8] },
    { kind: 'wait', seconds: 2 },
    { kind: 'screenshot' },
  ])
  expect(() => fromOpenAi([{ type: 'click', button: 'back', x: 1, y: 1 }])).toThrow(/back/)
})

test('keys are named as the driver names them', () => {
  expect(parseCombo('super+Tab')).toEqual(['cmd', 'tab'])
  expect(parseCombo('alt+shift+Page_Down')).toEqual(['option', 'shift', 'pagedown'])
  expect(parseCombo('BackSpace')).toEqual(['delete'])
  expect(parseCombo('F12')).toEqual(['f12'])
  expect(() => parseCombo('hyper+x')).toThrow(/unknown key/)
})

test('each model gets its provider protocol and screenshot limits', () => {
  const base = { api: 'anthropic-messages', provider: 'anthropic' }
  expect(computerProtocol({ ...base, id: 'claude-opus-5-5' })).toBe('anthropic')
  expect(computerProtocol({ ...base, id: 'claude-sonnet-5' })).toBe('anthropic')
  expect(computerProtocol({ ...base, id: 'claude-opus-4-8' })).toBe('anthropic')
  // Earlier Claude, and Claude on Bedrock (which has only the beta versions), get the generic tool.
  expect(computerProtocol({ ...base, id: 'claude-opus-4-6' })).toBe('generic')
  expect(computerProtocol({ ...base, id: 'claude-opus-5-5', provider: 'amazon-bedrock' })).toBe('generic')
  expect(computerProtocol({ ...base, id: 'claude-opus-5-5', compat: { bedrockMessagesApi: true } })).toBe(
    'generic',
  )
  expect(
    computerProtocol({
      id: 'gpt-5.5',
      api: 'openai-responses',
      provider: 'openai',
      supportsComputerUse: true,
    }),
  ).toBe('openai')
  expect(computerProtocol({ id: 'gpt-5.5', api: 'openai-codex-responses', provider: 'openai-codex' })).toBe(
    'generic',
  )
  expect(computerProtocol({ id: 'gemini-3-pro', api: 'google-generative-ai', provider: 'google' })).toBe(
    'generic',
  )

  expect(imageLimits({ id: 'claude-opus-5-5', api: 'anthropic-messages' })).toEqual({
    longEdge: 2576,
    megapixels: 3.75,
  })
  expect(imageLimits({ id: 'claude-opus-4-7', api: 'anthropic-messages' })).toEqual({
    longEdge: 2576,
    megapixels: 3.75,
  })
  expect(imageLimits({ id: 'claude-sonnet-4-5', api: 'anthropic-messages' })).toEqual({
    longEdge: 1568,
    megapixels: 1.15,
  })
  expect(imageLimits({ id: 'gpt-5.5', api: 'openai-responses' })).toEqual({
    longEdge: 1568,
    megapixels: 1.15,
  })
})

test('screenshots are sized for the model in one place, by edge and by area', () => {
  const claude = { longEdge: 1568, megapixels: 1.15 }
  // A full-screen window on a 16-inch MacBook Pro: 1728×1117 points, 3456×2234 pixels at Retina 2x. The driver
  // captures the pixels; asked for this long edge it sends ~1334×862 (1.15 MP), and maps clicks back itself.
  const edge = screenshotEdge({ width: 1728, height: 1117 }, claude)
  expect(edge).toBe(1333)
  const height = Math.round((edge * 1117) / 1728)
  expect(edge * height).toBeLessThanOrEqual(1_150_000)
  // A wide, short window is bound by its long edge instead.
  expect(screenshotEdge({ width: 3000, height: 200 }, claude)).toBe(1568)
  expect(screenshotEdge({ width: 1728, height: 1117 }, { longEdge: 2576, megapixels: 3.75 })).toBe(2408)
  // Portrait windows measure their long edge the same way.
  expect(screenshotEdge({ width: 1117, height: 1728 }, claude)).toBe(1333)
})

test('a pixel in a Retina screenshot finds the element under it', () => {
  // A 1600×1000 point window at (100, 50), screenshot downscaled to 1333×833 pixels.
  const desk = {
    shot: {
      width: 1333,
      height: 833,
      window: { x: 100, y: 50, width: 1600, height: 1000 },
      elements: [
        { index: 0, role: 'AXGroup', label: 'Toolbar', frame: { x: 100, y: 50, w: 1600, h: 100 } },
        { index: 1, role: 'AXButton', label: 'Send', frame: { x: 1500, y: 60, w: 100, h: 40 } },
      ],
    },
  }
  // (1200, 20) pixels → (1540, 74) points: inside both, and the smaller (the button) wins.
  expect(labelAt(desk, [1200, 20])).toBe('Send')
  expect(labelAt(desk, [10, 10])).toBe('Toolbar')
  expect(labelAt(desk, [10, 500])).toBeUndefined()
})

test('the request carries the toolset in place of the generic tool, and the history marks member calls', () => {
  const body = {
    model: 'claude-opus-5-5',
    tools: [{ name: 'shell' }, { name: 'computer', input_schema: {}, cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'left_click', input: { coordinate: [1, 2] } },
          { type: 'tool_use', id: 't2', name: 'shell', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] },
          { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
        ],
      },
    ],
  }
  const out = anthropicToolsetPayload(body) as typeof body & { tools: Record<string, unknown>[] }
  expect(out.tools as unknown[]).toEqual([
    { name: 'shell' },
    { type: 'computer_toolset_20260801', cache_control: { type: 'ephemeral' } },
  ])
  const [, assistant, results] = out.messages as { content: Record<string, unknown>[] }[]
  expect(assistant?.content[0]?.toolset_name).toBe('computer')
  expect(assistant?.content[1]?.toolset_name).toBeUndefined()
  expect(results?.content[0]?.toolset_name).toBe('computer')
  expect(results?.content[1]?.toolset_name).toBeUndefined()
  expect(anthropicToolsetPayload({ tools: [{ name: 'shell' }], messages: [] })).toBeUndefined()
})

test('apps have tiers, warnings, and Myrmidon is never one of them', () => {
  expect(appTier('com.apple.Safari')).toBe('view')
  expect(appTier('com.google.Chrome.canary')).toBe('view')
  expect(appTier('com.apple.Terminal')).toBe('click')
  expect(appTier('com.microsoft.VSCode')).toBe('click')
  expect(appTier('com.apple.Notes')).toBe('full')
  expect(appWarning('com.googlecode.iterm2')).toBe('shell')
  expect(appWarning('com.apple.finder')).toBe('files')
  expect(appWarning('com.apple.systempreferences')).toBe('settings')
  expect(appWarning('com.apple.Notes')).toBeUndefined()
  expect(canRaise('com.apple.Terminal')).toBe(true)
  expect(canRaise('com.apple.Safari')).toBe(false)
  expect(isOwnApp('dev.myrmidon.app')).toBe(true)
  const click = fromGeneric('left_click', { coordinate: [1, 1] })
  const shiftClick = fromGeneric('left_click', { coordinate: [1, 1], text: 'shift' })
  const typing = fromGeneric('type', { text: 'hi' })
  expect(allows('view', { kind: 'screenshot' })).toBe(true)
  expect(allows('view', click)).toBe(false)
  expect(allows('click', click)).toBe(true)
  expect(allows('click', shiftClick)).toBe(false)
  expect(allows('click', typing)).toBe(false)
  expect(allows('full', typing)).toBe(true)
})

test('script apps are shell-like and Tor Browser view-only; their run and send keys ask first', () => {
  for (const app of ['com.apple.ScriptEditor2', 'com.apple.Automator', 'com.apple.shortcuts']) {
    expect(appTier(app)).toBe('click')
    expect(appWarning(app)).toBe('shell')
    expect(canRaise(app)).toBe(true)
  }
  expect(appTier('org.torproject.torbrowser')).toBe('view')
  const key = (text: string) => fromGeneric('key', { text })
  expect(sendsOrRuns(key('cmd+r'), 'com.apple.ScriptEditor2')).toBe(true)
  expect(sendsOrRuns(key('cmd+r'), 'com.apple.Notes')).toBe(false)
  expect(sensitiveLabel('Run', 'com.apple.Automator')).toBe(true)
  expect(sensitiveLabel('Run', 'com.apple.Notes')).toBe(false)
  // Mail sends with shift+cmd+D, however the modifiers are ordered; Finder's empty trash likewise.
  expect(sendsOrRuns(key('shift+cmd+d'), 'com.apple.mail')).toBe(true)
  expect(sendsOrRuns(key('cmd+shift+d'), 'com.apple.mail')).toBe(true)
  expect(sendsOrRuns(key('cmd+shift+delete'), 'com.apple.finder')).toBe(true)
  // Typed text with a newline presses Return.
  expect(sendsOrRuns(fromGeneric('type', { text: 'hi\n' }), 'com.apple.MobileSMS')).toBe(true)
  expect(sendsOrRuns(fromGeneric('type', { text: 'hi\r' }), 'com.apple.MobileSMS')).toBe(true)
  expect(sendsOrRuns(fromGeneric('type', { text: 'hi' }), 'com.apple.MobileSMS')).toBe(false)
  expect(sendsOrRuns(fromGeneric('type', { text: 'a\nb' }), 'com.apple.Notes')).toBe(false)
  expect(sendsOrRuns(key('Return'), 'com.apple.MobileSMS')).toBe(true)
})

test('key combos match whatever order their modifiers come in; Return runs in a launcher', () => {
  const key = (text: string) => fromGeneric('key', { text })
  expect(computerCombo(['shift', 'option', 'cmd', 'delete'])).toBe('cmd+option+shift+delete')
  expect(sendsOrRuns(key('option+shift+cmd+delete'), 'com.apple.finder')).toBe(true)
  expect(sendsOrRuns(key('shift+option+cmd+d'), 'com.apple.mail')).toBe(true)
  expect(sendsOrRuns(key('shift+ctrl+enter'), 'com.apple.Notes')).toBe(true)
  expect(sendsOrRuns(key('shift+cmd+r'), 'com.apple.ScriptEditor2')).toBe(true)
  expect(sendsOrRuns(key('option+cmd+r'), 'com.apple.ScriptEditor2')).toBe(true)
  expect(sendsOrRuns(key('Return'), 'com.raycast.macos')).toBe(true)
  expect(sendsOrRuns(fromGeneric('type', { text: 'rm -rf ~\n' }), 'com.raycast.macos')).toBe(true)
  // Ordinary keys stay free.
  expect(sendsOrRuns(key('shift+return'), 'com.apple.MobileSMS')).toBe(false)
  expect(sendsOrRuns(key('cmd+shift+r'), 'com.apple.Notes')).toBe(false)
  expect(sendsOrRuns(key('Return'), 'com.apple.Notes')).toBe(false)
  expect(sendsOrRuns(key('option+delete'), 'com.apple.finder')).toBe(false)
})

test('the toolset is never named in a tool addition or removal, which Anthropic refuses for a toolset', () => {
  // A real 400: find_tools loaded `computer` mid-chat, pi-ai marked it with tool_addition, and the swap left it.
  const body = {
    tools: [{ name: 'shell' }, { name: 'computer' }, { name: '_open_app' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'open notes' }] },
      {
        role: 'system',
        content: [
          { type: 'tool_addition', tool: { type: 'tool_reference', name: '_browser_open' } },
          { type: 'tool_addition', tool: { type: 'tool_reference', name: 'computer' } },
          { type: 'tool_addition', tool: { type: 'tool_reference', name: '_open_app' } },
        ],
      },
      {
        role: 'system',
        content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'computer' } }],
      },
    ],
  }
  const out = anthropicToolsetPayload(body) as typeof body
  const named = JSON.stringify(out.messages)
  expect(named).not.toContain('"name":"computer"')
  // Other tools' additions stay; a message left with nothing in it goes.
  expect(named).toContain('_browser_open')
  expect(named).toContain('_open_app')
  expect(out.messages).toHaveLength(2)
})

test('an action is placed on the screen from the screenshot it was aimed at, or from the element it used', () => {
  const desk = {
    shot: {
      width: 800,
      height: 500,
      window: { x: 100, y: 50, width: 1600, height: 1000 },
      elements: [{ index: 3, role: 'AXButton', frame: { x: 10, y: 20, w: 30, h: 40 } }],
    },
    cursor: [400, 250] as [number, number],
  }
  // Screenshot pixels are half the window's points here.
  expect(screenPoint(desk, [400, 250])).toEqual([900, 550])
  expect(pointerOf(desk, { kind: 'click', at: [0, 0], button: 'left', count: 1, modifiers: [] })).toEqual({
    x: 100,
    y: 50,
    action: 'click',
  })
  expect(pointerOf(desk, { kind: 'click_element', element: 3, button: 'left', count: 1 })).toEqual({
    x: 25,
    y: 40,
    action: 'click',
  })
  expect(pointerOf(desk, { kind: 'type', text: 'hi' })).toEqual({ x: 900, y: 550, action: 'type' })
  expect(pointerOf(desk, { kind: 'drag', from: [0, 0], to: [800, 500] })).toEqual({
    x: 1700,
    y: 1050,
    action: 'drag',
  })
  expect(pointerOf(desk, { kind: 'wait', seconds: 1 })).toBeUndefined()
  expect(pointerOf({ cursor: [1, 1] }, { kind: 'move', at: [1, 1] })).toBeUndefined()
})

test('a driver session is named for the agent and its round, short and the same every time', () => {
  expect(sessionOf('colony-mv1abc23-9f8e7d', 'Nova Lee')).toBe('myr-nova-lee-9f8e7d')
  expect(sessionOf('colony-mv1abc23-9f8e7d', 'Nova Lee')).toBe(
    sessionOf('colony-mv1abc23-9f8e7d', 'Nova Lee'),
  )
})
