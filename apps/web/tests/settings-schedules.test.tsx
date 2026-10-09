import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { mount, press, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const here = Intl.DateTimeFormat().resolvedOptions().timeZone
/** A zone that is not the test machine's, as a Myrmidon on another computer would report. */
const elsewhere = here === 'Pacific/Kiritimati' ? 'Pacific/Niue' : 'Pacific/Kiritimati'

/** Answers the page's requests with `schedules`, run in `timeZone`. */
function serve(schedules: unknown[], timeZone = here) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/schedules')) return Response.json({ schedules, timeZone })
    if (url.includes('/api/channels')) return Response.json({ channels: [] })
    return Response.json({ projects: [] })
  }) as unknown as typeof fetch
}

const schedule = (cron: string) => ({
  id: 's1',
  name: 'Digest',
  request: 'Summarize the week',
  cron,
  enabled: true,
  nextRun: new Date(Date.UTC(2026, 9, 12, 9)).toISOString(),
})

async function section() {
  const { SchedulesSection } = await import('../src/client/Settings.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const view = await mount(
    <ToastProvider>
      <SchedulesSection />
    </ToastProvider>,
  )
  await act(async () => Bun.sleep(10))
  return view
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement

async function click(button: HTMLElement) {
  await act(async () => button.click())
}

async function pick(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

test('a day chip is named by the day it shows, with the full name as its tooltip', async () => {
  serve([])
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.settings.schedules
  const { unmount } = await section()
  try {
    await pick(
      document.querySelector(`select[aria-label="${t.repeat.label}"]`) as HTMLSelectElement,
      'weekly',
    )
    const chips = [...document.querySelectorAll<HTMLButtonElement>('fieldset button[aria-pressed]')]
    expect(chips.map((c) => c.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    // An aria-label would replace the visible "Mon" as its name, which speech control cannot then match.
    for (const c of chips) expect(c.hasAttribute('aria-label')).toBe(false)
    expect(chips[0]?.title).toBe('Monday')
  } finally {
    await unmount()
  }
})

test('the time is picked in the same words the sentence under it uses', async () => {
  serve([])
  const { copy } = await import('../src/client/copy.ts')
  const { timeText, hourText } = await import('../src/client/schedule-rule.ts')
  const t = copy.settings.schedules
  const { host, unmount } = await section()
  try {
    // The browser's own time field writes the time the way the system does, which can differ from the sentence.
    expect(host.querySelector('input[type="time"]')).toBeNull()
    const hour = host.querySelector(`select[aria-label="${t.hour}"]`) as HTMLSelectElement
    const minute = host.querySelector(`select[aria-label="${t.minute}"]`) as HTMLSelectElement
    expect(hour.selectedOptions[0]?.textContent).toBe(hourText(9))
    await pick(hour, '14')
    await pick(minute, '30')
    expect(host.textContent).toContain(t.describe.weekdays(timeText(14, 30)))
  } finally {
    await unmount()
  }
})

test('Escape while changing a schedule cancels the change and leaves Settings open', async () => {
  serve([schedule('0 9 * * 1')])
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.settings.schedules
  const reachedWindow: string[] = []
  const listen = (e: KeyboardEvent) => reachedWindow.push(e.key)
  window.addEventListener('keydown', listen)
  const { unmount } = await section()
  try {
    await click(buttonNamed(t.change))
    const monday = [
      ...document.querySelectorAll<HTMLButtonElement>('fieldset button'),
    ][0] as HTMLButtonElement
    await act(async () => monday.focus())
    await press('Escape')
    // Settings closes on an Escape that reaches the window; this one only ended the change.
    expect(reachedWindow).toEqual([])
    expect(buttonNamed(t.save)).toBeUndefined()
    expect(document.activeElement).toBe(buttonNamed(t.change))
  } finally {
    window.removeEventListener('keydown', listen)
    await unmount()
  }
})

test('a monthly schedule past the 28th says the short months are skipped, in the list too', async () => {
  serve([schedule('0 8 31 * *')])
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.settings.schedules
  const { host, unmount } = await section()
  try {
    expect(host.textContent).toContain(t.shortMonths(t.ordinal(31)))
  } finally {
    await unmount()
  }
})

test('times are said in the zone Myrmidon runs schedules in when it is not this browser’s', async () => {
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.settings.schedules
  serve([schedule('0 9 * * 1')], elsewhere)
  const away = await section()
  try {
    const text = away.host.textContent ?? ''
    // In the picker for a new schedule, and on the saved one.
    expect(text.split(t.serverZone(elsewhere)).length - 1).toBe(2)
    expect(text).not.toContain(t.localTime)
  } finally {
    await away.unmount()
  }
  serve([schedule('0 9 * * 1')], here)
  const home = await section()
  try {
    expect(home.host.textContent).toContain(t.localTime)
    expect(home.host.textContent).not.toContain(t.serverZone(here))
  } finally {
    await home.unmount()
  }
})
