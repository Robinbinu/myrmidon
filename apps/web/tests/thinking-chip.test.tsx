import { afterEach, beforeEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

// The thinking picker reads what the server says each level is sent as on the lead's model (ModelOption.thinking,
// runtime thinking.ts): it offers the levels the model has and names the one it gets when that differs.

const FULL = { low: 'low', medium: 'medium', high: 'high' }
const MODELS = {
  claude: { ref: 'anthropic/claude', provider: 'anthropic', id: 'claude', name: 'Claude', reasoning: true },
  deepseek: {
    ref: 'deepseek/deepseek-v4-flash',
    provider: 'deepseek',
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    reasoning: true,
    thinking: { levels: { low: 'low', medium: 'low', high: 'high' } },
  },
  r1: {
    ref: 'openrouter/deepseek/deepseek-r1',
    provider: 'openrouter',
    id: 'deepseek/deepseek-r1',
    name: 'DeepSeek R1',
    reasoning: true,
    thinking: { levels: { low: 'high', medium: 'high', high: 'high' } },
  },
  llama: { ref: 'groq/llama', provider: 'groq', id: 'llama', name: 'Llama', reasoning: false },
  grok: { ref: 'xai/grok-4', provider: 'xai', id: 'grok-4', name: 'Grok 4', reasoning: true },
  guessed: {
    ref: 'meta/new',
    provider: 'meta',
    id: 'new',
    name: 'Muse New',
    reasoning: true,
    thinking: { levels: FULL, unverified: true },
  },
}
;(MODELS.claude as Record<string, unknown>).thinking = { levels: FULL }

const config = (leadModel: string, thinking?: 'low' | 'medium' | 'high') => ({
  mode: 'orchestrated' as const,
  leadModel,
  roster: [],
  extraWorkers: 0,
  judgeModel: leadModel,
  ...(thinking ? { thinking } : {}),
})

beforeEach(() => {
  // happy-dom's Web Animations reject when cut short, which motion leaves unhandled.
  Reflect.deleteProperty(Element.prototype, 'animate')
})
afterEach(() => {
  document.body.replaceChildren()
})

const chip = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].find(
    (b) => b.title === 'Thinking',
  )
const options = () => [...document.querySelectorAll('[role="menuitemradio"]')].map((o) => o.textContent ?? '')

async function openChip(model: keyof typeof MODELS | undefined, thinking?: 'low' | 'medium' | 'high') {
  const { ThinkingChip } = await import('../src/client/chat/TeamControls.tsx')
  const changes: unknown[] = []
  const lead = model ? MODELS[model] : undefined
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ThinkingChip
        config={config(lead?.ref ?? 'x/y', thinking) as never}
        {...(lead ? { model: lead as never } : {})}
        onConfig={(c) => changes.push(c)}
      />
    </MotionConfig>,
  )
  const value = chip()?.textContent ?? ''
  await act(async () => chip()?.click())
  return { view, value, changes }
}

test('a model with every level offers them all, and the chip reads as the pick', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const { view, value } = await openChip('claude', 'medium')
  try {
    expect(value).toBe(copy.teamControls.effort.medium.title)
    const shown = options()
    for (const level of ['auto', 'low', 'medium', 'high'] as const)
      expect(shown.some((o) => o.includes(copy.teamControls.effort[level].title))).toBe(true)
    expect(document.body.textContent).not.toContain('has no')
  } finally {
    await view.unmount()
  }
})

test('a level the model lacks is not offered, and a pick it lacks shows the level it gets and why', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const { view, value } = await openChip('deepseek', 'medium')
  try {
    // DeepSeek V4 has low, high and max: Balanced (medium) goes out as Fast (low).
    expect(value).toBe(copy.teamControls.effortName.low)
    const shown = options()
    expect(shown).toHaveLength(3)
    expect(shown.some((o) => o.includes(copy.teamControls.effort.medium.title))).toBe(false)
    expect(document.body.textContent).toContain(
      copy.teamControls.thinking.clamped(
        'DeepSeek V4 Flash',
        copy.teamControls.effort.medium.title,
        copy.teamControls.effortName.low,
      ),
    )
  } finally {
    await view.unmount()
  }
})

test('a model with one level offers Auto and that level only', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const { view, value, changes } = await openChip('r1', 'low')
  try {
    expect(value).toBe(copy.teamControls.effortName.high)
    expect(options()).toHaveLength(2)
    const deep = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((o) =>
      o.textContent?.includes(copy.teamControls.effort.high.title),
    )
    await act(async () => deep?.click())
    expect(changes.at(-1)).toMatchObject({ thinking: 'high' })
  } finally {
    await view.unmount()
  }
})

test("a model that takes no level reads Off and says why, keeping the levels for crewmates' models", async () => {
  const { copy } = await import('../src/client/copy.ts')
  const { view, value } = await openChip('llama', 'high')
  try {
    expect(value).toBe(copy.teamControls.thinking.off)
    expect(document.body.textContent).toContain(copy.teamControls.thinking.none('Llama'))
    expect(options()).toHaveLength(4)
  } finally {
    await view.unmount()
  }
})

test('a model that reasons with no level to set still thinks: the chip keeps the pick and says the model decides', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const { view, value } = await openChip('grok', 'high')
  try {
    expect(value).toBe(copy.teamControls.effort.high.title)
    expect(document.body.textContent).toContain(copy.teamControls.thinking.own('Grok 4'))
    expect(options()).toHaveLength(4)
  } finally {
    await view.unmount()
  }
})

test('Auto on a model omp only guesses reasons is off, and says a pick turns it on', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const auto = await openChip('guessed')
  try {
    expect(auto.value).toBe(copy.teamControls.thinking.off)
    expect(document.body.textContent).toContain(copy.teamControls.thinking.unverified('Muse New'))
  } finally {
    await auto.view.unmount()
  }
  const picked = await openChip('guessed', 'high')
  try {
    expect(picked.value).toBe(copy.teamControls.effort.high.title)
  } finally {
    await picked.view.unmount()
  }
})

test('without the lead model known, every level is offered as is', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const { view, value } = await openChip(undefined, 'medium')
  try {
    expect(value).toBe(copy.teamControls.effort.medium.title)
    expect(options()).toHaveLength(4)
  } finally {
    await view.unmount()
  }
})

test("the crew panel's thinking row offers the lead's levels and says what a missing one becomes", async () => {
  const { TeamSettings } = await import('../src/client/chat/Composer.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <TeamSettings
        models={[MODELS.deepseek] as never}
        config={config(MODELS.deepseek.ref, 'medium') as never}
        onConfig={() => {}}
      />
    </MotionConfig>,
  )
  try {
    const row = document.querySelector('[data-setting-id="team.thinking"]')
    expect(row).not.toBeNull()
    const labels = [...(row?.querySelectorAll('button, [role="radio"]') ?? [])].map((b) => b.textContent)
    expect(labels).toContain(copy.composer.thinking.low)
    expect(labels).toContain(copy.composer.thinking.high)
    expect(labels).not.toContain(copy.composer.thinking.medium)
    expect(row?.textContent).toContain(
      copy.teamControls.thinking.clamped(
        'DeepSeek V4 Flash',
        copy.teamControls.effort.medium.title,
        copy.teamControls.effortName.low,
      ),
    )
  } finally {
    await view.unmount()
  }
})
