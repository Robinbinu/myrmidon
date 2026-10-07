# Native UI — Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web client the base layer of a native macOS-style app: new tokens and type, app-wide native
behavior (no selectable chrome, default cursor, no bounce, no browser context menu on chrome, no drag ghosts,
inactive-window state), platform and shortcut helpers, and restyled base controls.

**Architecture:** Two small pure modules (`ui/platform.ts`, `ui/shortcuts.ts`) hold the testable logic; a single
`installNativeBehavior()` call in `main.tsx` wires them to the document. `tokens.css` is rewritten around macOS-style
semantic tokens and keeps every old token name as an alias, so screens not yet migrated still render. Base controls
in `ui/primitives.tsx` change their look but keep their names and props, so no call site breaks.

**Tech Stack:** Bun 1.3.14, React 19, Tailwind v4 (`@theme inline` tokens), motion, Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-07-native-ui-design.md` (sections 2, 3, 5, 7, 8; phase 1 of section 9).

## Global Constraints

- One look on every OS: Myrmidon identity in macOS style. No per-OS themes.
- Type: `-apple-system, BlinkMacSystemFont`, then Geist (already bundled); 13px UI, 14px reading content.
- Accent: signal amber (`#ffb31a`) fills primary buttons, focus and active indicators, with near-black text on it;
  amber used as text must use the AA-safe `--accent-text` token.
- Glass only on the navigation layer (sidebar, toolbars, popovers, menus, sheets), never on content.
- No new dependencies.
- AA contrast (4.5:1 text) on every surface in both themes.
- Every old token name keeps working until phase 6 removes the aliases.
- Run `bun run check` from the repo root and check its exit code (not through a pipe that hides it) before every
  commit. Commit only the files the task lists.
- `$SCRATCH` below means `/private/tmp/claude-501/-Users-robin-Desktop-Myrmidon/14e23d6b-d916-4324-acd9-e5896e74cca2/scratchpad`.
- External links already open outside the app (every `<a>` in the client has `target="_blank"`); keep it so.
- The user's server on port 4318 is never restarted; visual checks use the test server on 4319
  (`--home /private/tmp/claude-501/-Users-robin-Desktop-Myrmidon/14e23d6b-d916-4324-acd9-e5896e74cca2/scratchpad/home-new`).

---

### Task 1: Platform detection and native document behavior

**Files:**
- Create: `apps/web/src/client/ui/platform.ts`
- Create: `apps/web/tests/platform.test.ts`
- Modify: `apps/web/src/client/main.tsx`

**Interfaces:**
- Produces:
  - `type Platform = 'mac' | 'windows' | 'linux' | 'other'`
  - `detectPlatform(userAgent: string): Platform`
  - `isMac: boolean` (for shortcut labels in later phases)
  - `keepsBrowserMenu(target: { closest(selector: string): unknown } | null, selection: string): boolean`
  - `installNativeBehavior(): void` — sets `data-platform`, `data-shell` (only if the shell has not set it),
    `data-window-active` on `<html>`; suppresses the browser context menu on chrome; stops drag ghosts.

- [ ] **Step 1: Write the failing test**

`apps/web/tests/platform.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { detectPlatform, keepsBrowserMenu } from '../src/client/ui/platform.ts'

test('the platform comes from the user agent', () => {
  expect(
    detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'),
  ).toBe('mac')
  expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('windows')
  expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('linux')
  expect(detectPlatform('curl/8.4.0')).toBe('other')
})

test('the browser menu stays for text fields and selected text, not for app chrome', () => {
  const inField = { closest: (s: string) => (s.includes('input') ? {} : null) }
  const onChrome = { closest: () => null }
  expect(keepsBrowserMenu(inField, '')).toBe(true)
  expect(keepsBrowserMenu(onChrome, 'some words')).toBe(true)
  expect(keepsBrowserMenu(onChrome, '  ')).toBe(false)
  expect(keepsBrowserMenu(null, '')).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/tests/platform.test.ts`
Expected: FAIL — `Cannot find module '../src/client/ui/platform.ts'`.

- [ ] **Step 3: Write the implementation**

`apps/web/src/client/ui/platform.ts`:

```ts
/**
 * Where the app runs and the document-level behavior that makes it feel like a desktop app rather than a page.
 * The desktop shell sets `data-shell` itself before the page loads; in a browser it is `browser`.
 */

export type Platform = 'mac' | 'windows' | 'linux' | 'other'

export function detectPlatform(userAgent: string): Platform {
  if (/Mac|iPhone|iPad/.test(userAgent)) return 'mac'
  if (/Windows/.test(userAgent)) return 'windows'
  if (/Linux|X11|CrOS/.test(userAgent)) return 'linux'
  return 'other'
}

export const isMac = typeof navigator !== 'undefined' && detectPlatform(navigator.userAgent) === 'mac'

const EDITABLE = 'input, textarea, [contenteditable="true"], [contenteditable=""]'

/** Whether the browser's own menu should open: in text fields and over selected text (spell check, Copy). */
export function keepsBrowserMenu(
  target: { closest(selector: string): unknown } | null,
  selection: string,
): boolean {
  if (selection.trim()) return true
  return !!target?.closest(EDITABLE)
}

export function installNativeBehavior() {
  const root = document.documentElement
  root.dataset.platform = detectPlatform(navigator.userAgent)
  root.dataset.shell ??= 'browser'
  const active = (on: boolean) => {
    root.dataset.windowActive = String(on)
  }
  active(document.hasFocus())
  window.addEventListener('focus', () => active(true))
  window.addEventListener('blur', () => active(false))
  // App menus call preventDefault themselves; anything left over on chrome gets no browser menu.
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return
    const target = e.target instanceof Element ? e.target : null
    if (!keepsBrowserMenu(target, window.getSelection()?.toString() ?? '')) e.preventDefault()
  })
  // Native apps do not drag ghost copies of their images and links; elements meant to be dragged opt in.
  document.addEventListener('dragstart', (e) => {
    const target = e.target instanceof Element ? e.target : null
    if (!target?.closest('[draggable="true"]')) e.preventDefault()
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/tests/platform.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it in `main.tsx`**

Replace the body of `apps/web/src/client/main.tsx` after the font imports with:

```tsx
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { installNativeBehavior } from './ui/platform.ts'
import { ToastProvider } from './ui/Toast.tsx'

installNativeBehavior()

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
)
```

- [ ] **Step 6: Check and commit**

Run: `bun run check > "$SCRATCH/check.log" 2>&1; echo "exit $?"` (where `$SCRATCH` is the session scratchpad).
Expected: `exit 0`.

```bash
git add apps/web/src/client/ui/platform.ts apps/web/tests/platform.test.ts apps/web/src/client/main.tsx
git commit -m "Native behavior: platform, window focus, no browser menu on chrome"
```

---

### Task 2: Shortcut matching and platform labels

**Files:**
- Create: `apps/web/src/client/ui/shortcuts.ts`
- Create: `apps/web/tests/shortcuts.test.ts`
- Modify: `apps/web/src/client/ui/hooks.ts:70-93` (`useHotkeys` uses `matchCombo`)

**Interfaces:**
- Produces:
  - `parseCombo(combo: string): { key: string; mod: boolean; shift: boolean; alt: boolean }`
  - `matchCombo(combo: string, e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean`
  - `comboLabel(combo: string, mac: boolean): string` — `'⇧⌘['` on Mac, `'Ctrl+Shift+['` elsewhere.
- Combo syntax (unchanged from today's `useHotkeys`): lowercase, `+`-joined, `mod` = ⌘ on Mac and Ctrl elsewhere
  (either key counts, as today), plus `shift` and `alt`; the last part is the key (`k`, `/`, `[`, `escape`).

- [ ] **Step 1: Write the failing test**

`apps/web/tests/shortcuts.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { comboLabel, matchCombo } from '../src/client/ui/shortcuts.ts'

const key = (k: string, code: string, mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {}) => ({
  key: k,
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
})

test('mod means Command or Control, and Shift makes a different shortcut for letters', () => {
  expect(matchCombo('mod+k', key('k', 'KeyK', { meta: true }))).toBe(true)
  expect(matchCombo('mod+k', key('k', 'KeyK', { ctrl: true }))).toBe(true)
  expect(matchCombo('mod+k', key('k', 'KeyK'))).toBe(false)
  expect(matchCombo('mod+n', key('N', 'KeyN', { meta: true, shift: true }))).toBe(false)
  expect(matchCombo('escape', key('Escape', 'Escape'))).toBe(true)
})

test('shifted and optioned shortcuts match the physical key', () => {
  // ⇧⌘[ types "{" on a US layout; ⌥⌘N types "˜" on a Mac.
  expect(matchCombo('mod+shift+[', key('{', 'BracketLeft', { meta: true, shift: true }))).toBe(true)
  expect(matchCombo('mod+shift+[', key('[', 'BracketLeft', { meta: true }))).toBe(false)
  expect(matchCombo('mod+alt+n', key('˜', 'KeyN', { meta: true, alt: true }))).toBe(true)
  expect(matchCombo('mod+n', key('˜', 'KeyN', { meta: true, alt: true }))).toBe(false)
})

test('a symbol that needs Shift on some layouts still matches', () => {
  // German layout: "/" is Shift+7.
  expect(matchCombo('/', key('/', 'Digit7', { shift: true }))).toBe(true)
  expect(matchCombo('/', key('/', 'Slash'))).toBe(true)
  expect(matchCombo('/', key('?', 'Slash', { shift: true }))).toBe(false)
})

test('labels follow the platform', () => {
  expect(comboLabel('mod+n', true)).toBe('⌘N')
  expect(comboLabel('mod+shift+[', true)).toBe('⇧⌘[')
  expect(comboLabel('mod+alt+n', true)).toBe('⌥⌘N')
  expect(comboLabel('mod+shift+[', false)).toBe('Ctrl+Shift+[')
  expect(comboLabel('escape', true)).toBe('Esc')
  expect(comboLabel('mod+,', false)).toBe('Ctrl+,')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/tests/shortcuts.test.ts`
Expected: FAIL — `Cannot find module '../src/client/ui/shortcuts.ts'`.

- [ ] **Step 3: Write the implementation**

`apps/web/src/client/ui/shortcuts.ts`:

```ts
/** Keyboard shortcuts written as `mod+shift+[`: `mod` is ⌘ on a Mac and Ctrl elsewhere (either key works). */

export interface Combo {
  readonly key: string
  readonly mod: boolean
  readonly shift: boolean
  readonly alt: boolean
}

export function parseCombo(combo: string): Combo {
  const parts = combo.toLowerCase().split('+')
  const mods = parts.slice(0, -1)
  return { key: parts.at(-1) ?? '', mod: mods.includes('mod'), shift: mods.includes('shift'), alt: mods.includes('alt') }
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Minus: '-',
  Equal: '=',
}

/** The key a physical key types without modifiers: KeyN → n, Digit1 → 1, BracketLeft → [. */
function plainKey(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  return CODE_KEYS[code]
}

type KeyInput = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

export function matchCombo(combo: string, e: KeyInput): boolean {
  const c = parseCombo(combo)
  if (c.mod !== (e.metaKey || e.ctrlKey) || c.alt !== e.altKey) return false
  const key = e.key.toLowerCase()
  // Shift and Option change the character typed ("{", "˜"), so those shortcuts match the physical key too.
  if (c.shift || c.alt) return (!c.shift || e.shiftKey) && (key === c.key || plainKey(e.code) === c.key)
  // Shift makes a letter or digit a different shortcut; for symbols it is how some layouts type them ("/").
  if (e.shiftKey && /^[a-z0-9]$/.test(c.key)) return false
  return key === c.key
}

const NAMES: Record<string, string> = { escape: 'Esc' }

/** How a shortcut is written on this platform: ⇧⌘[ on a Mac (Apple's modifier order), Ctrl+Shift+[ elsewhere. */
export function comboLabel(combo: string, mac: boolean): string {
  const c = parseCombo(combo)
  const key = NAMES[c.key] ?? c.key.toUpperCase()
  if (mac) return `${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${key}`
  return [c.mod && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/tests/shortcuts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Make `useHotkeys` use it**

In `apps/web/src/client/ui/hooks.ts`, add `import { matchCombo } from './shortcuts.ts'` and replace the loop
inside `onKey` with:

```ts
      for (const k of ref.current) {
        if (!matchCombo(k.combo, e)) continue
        if (typing && !k.inInputs) continue
        e.preventDefault()
        k.run(e)
        return
      }
```

Update the `Hotkey.combo` doc comment to: `/** e.g. 'mod+k', '/', 'escape', 'mod+shift+[' (see shortcuts.ts) */`.

- [ ] **Step 6: Check and commit**

Run: `bun run check > "$SCRATCH/check.log" 2>&1; echo "exit $?"` — expected `exit 0`.

```bash
git add apps/web/src/client/ui/shortcuts.ts apps/web/tests/shortcuts.test.ts apps/web/src/client/ui/hooks.ts
git commit -m "Shortcuts: match by physical key, label per platform"
```

---

### Task 3: Tokens, type and app-wide native CSS

**Files:**
- Modify: `apps/web/src/client/tokens.css` (rewrite)
- Modify: `apps/web/src/client/styles.css` (`@theme inline`, `@layer base`, utilities)
- Modify: every client file using `text-accent` (33 uses; swept to `text-accent-fg`)
- Modify: client files using `cursor-pointer` (list in step 5)
- Modify: `apps/web/src/client/chat/Markdown.tsx:242`, `apps/web/src/client/chat/RoundView.tsx:314` (selectable content)

**Interfaces:**
- Produces CSS tokens later phases use:
  - Surfaces: `--window`, `--content`, `--raised`, `--control`, `--control-hover`, `--control-active`, `--fill`,
    `--fill-strong`, `--separator`, `--separator-strong`
  - Materials: `--material-sidebar`, `--material-toolbar`, `--material-menu`
  - Labels: `--label`, `--label-2`, `--label-3`, `--label-4`
  - Accent: `--accent`, `--accent-hover`, `--accent-soft`, `--accent-text`, `--on-accent`, `--focus`
  - Selection rows: `--row-selected`, `--row-selected-inactive`
  - `--titlebar-inset` (0 in the browser), `--chevrons` (popup-button arrows)
- Produces Tailwind colors: `control`, `control-hover`, `control-active`, `fill`, `fill-strong`, `accent-fg`,
  `focus`, `row-selected`; utilities `material-sidebar`, `material-toolbar`, `material-menu`, `drag-region`,
  `no-drag`. `glass` stays as an alias of `material-toolbar`.
- Old names (`--bg`, `--surface`, `--surface-2`, `--surface-3`, `--border`, `--border-strong`, `--text`, `--text-2`,
  `--muted`) become aliases of the new ones.

- [ ] **Step 1: Rewrite `tokens.css`**

Replace the whole file with:

```css
/* ============ tokens ============
   Myrmidon in a macOS manner. Ink and paper with signal amber as the accent: amber fills primary buttons, focus and
   the active indicator, and is never used as text except through --accent-text, which keeps AA contrast. Glass
   materials are for the navigation layer only (sidebar, toolbars, menus, popovers, sheets); content stays opaque.
   Text colours meet WCAG AA, 4.5:1, on every surface in both themes. */
:root {
  /* Surfaces */
  --window: #f1f0ec;
  --content: #ffffff;
  --raised: #ffffff;
  --control: #ffffff;
  --control-hover: #f6f5f2;
  --control-active: #ebeae5;
  --fill: #f0efea;
  --fill-strong: #e5e3dc;
  --separator: rgb(0 0 0 / 0.09);
  --separator-strong: rgb(0 0 0 / 0.2);
  --material-sidebar: rgb(236 235 231 / 0.78);
  --material-toolbar: rgb(250 250 248 / 0.8);
  --material-menu: rgb(252 252 250 / 0.86);
  /* Labels */
  --label: #111113;
  --label-2: #3b3b42;
  --label-3: #62626b;
  --label-4: #9a9aa2;
  /* Accent */
  --accent: #ffb31a;
  --accent-hover: #ffbe3d;
  --accent-soft: rgb(255 179 26 / 0.16);
  --accent-text: #8a5a00;
  --on-accent: #1a1204;
  --focus: #b86e00;
  --row-selected: rgb(0 0 0 / 0.08);
  --row-selected-inactive: rgb(0 0 0 / 0.05);
  /* Identity and status */
  --ink: #0b0b0d;
  --on-ink: #f6f6f8;
  --bubble: #0b0b0d;
  --on-bubble: #f6f6f8;
  --signal: #ffb31a;
  --lime: #d4ff3a;
  --ok: #0a7a3a;
  --ok-soft: rgb(10 122 58 / 0.09);
  --warn: #b53d0a;
  --warn-soft: rgb(181 61 10 / 0.09);
  --bad: #c0272d;
  --bad-soft: rgb(192 39 45 / 0.08);
  --work: #8a5a00;
  --idle: #a1a1aa;
  --edge: #b9b6ac;
  --code-bg: #f5f4f0;
  --add: #e6f6ec;
  --del: #fdecec;
  --screen: #0b0b0d;
  --screen-cell: rgb(255 255 255 / 0.055);
  --shadow-sm: 0 1px 2px rgb(11 11 13 / 0.05);
  --shadow-md: 0 1px 2px rgb(11 11 13 / 0.04), 0 8px 24px -6px rgb(11 11 13 / 0.1);
  --shadow-lg: 0 2px 6px rgb(11 11 13 / 0.05), 0 28px 64px -12px rgb(11 11 13 / 0.26);
  --scrim: rgb(11 11 13 / 0.35);
  /* Shape, type, motion */
  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 14px;
  --titlebar-inset: 0px;
  --chevrons: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 14' fill='none' stroke='%238e8e93' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 5l3-3 3 3M2 9l3 3 3-3'/%3E%3C/svg%3E");
  --font: -apple-system, BlinkMacSystemFont, "Geist Variable", "Geist", "Segoe UI Variable Text", "Segoe UI",
    system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", "Geist Mono Variable", "Geist Mono", Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --fast: 120ms;
  --med: 200ms;
  /* Older names, kept until every screen uses the ones above. */
  --bg: var(--window);
  --surface: var(--content);
  --surface-2: var(--fill);
  --surface-3: var(--fill-strong);
  --border: var(--separator);
  --border-strong: var(--separator-strong);
  --text: var(--label);
  --text-2: var(--label-2);
  --muted: var(--label-3);
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --window: #0b0b0e;
    --content: #111114;
    --raised: #18181c;
    --control: #232328;
    --control-hover: #2a2a30;
    --control-active: #313138;
    --fill: #17171b;
    --fill-strong: #222228;
    --separator: rgb(255 255 255 / 0.08);
    --separator-strong: rgb(255 255 255 / 0.16);
    --material-sidebar: rgb(22 22 26 / 0.72);
    --material-toolbar: rgb(17 17 20 / 0.78);
    --material-menu: rgb(30 30 35 / 0.82);
    --label: #f4f4f6;
    --label-2: #c8c8d0;
    --label-3: #8f8f9a;
    --label-4: #5c5c66;
    --accent-hover: #ffc247;
    --accent-soft: rgb(255 179 26 / 0.14);
    --accent-text: #ffb31a;
    --focus: #ffb31a;
    --row-selected: rgb(255 255 255 / 0.09);
    --row-selected-inactive: rgb(255 255 255 / 0.05);
    --ink: #f4f4f6;
    --on-ink: #0b0b0d;
    --bubble: #2a2a31;
    --on-bubble: #f4f4f6;
    --ok: #3ddc84;
    --ok-soft: rgb(61 220 132 / 0.11);
    --warn: #ff8a4c;
    --warn-soft: rgb(255 138 76 / 0.12);
    --bad: #ff6369;
    --bad-soft: rgb(255 99 105 / 0.11);
    --work: #ffb31a;
    --idle: #5c5c66;
    --edge: #3a3a42;
    --code-bg: #0c0c0f;
    --add: #0f2a1d;
    --del: #351719;
    --screen: #050506;
    --screen-cell: rgb(255 255 255 / 0.05);
    --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.5);
    --shadow-md: 0 1px 0 rgb(255 255 255 / 0.03) inset, 0 10px 30px -8px rgb(0 0 0 / 0.6);
    --shadow-lg: 0 1px 0 rgb(255 255 255 / 0.04) inset, 0 30px 70px -10px rgb(0 0 0 / 0.75);
    --scrim: rgb(0 0 0 / 0.5);
    color-scheme: dark;
  }
}

:root[data-theme="dark"] {
  --window: #0b0b0e;
  --content: #111114;
  --raised: #18181c;
  --control: #232328;
  --control-hover: #2a2a30;
  --control-active: #313138;
  --fill: #17171b;
  --fill-strong: #222228;
  --separator: rgb(255 255 255 / 0.08);
  --separator-strong: rgb(255 255 255 / 0.16);
  --material-sidebar: rgb(22 22 26 / 0.72);
  --material-toolbar: rgb(17 17 20 / 0.78);
  --material-menu: rgb(30 30 35 / 0.82);
  --label: #f4f4f6;
  --label-2: #c8c8d0;
  --label-3: #8f8f9a;
  --label-4: #5c5c66;
  --accent-hover: #ffc247;
  --accent-soft: rgb(255 179 26 / 0.14);
  --accent-text: #ffb31a;
  --focus: #ffb31a;
  --row-selected: rgb(255 255 255 / 0.09);
  --row-selected-inactive: rgb(255 255 255 / 0.05);
  --ink: #f4f4f6;
  --on-ink: #0b0b0d;
  --bubble: #2a2a31;
  --on-bubble: #f4f4f6;
  --ok: #3ddc84;
  --ok-soft: rgb(61 220 132 / 0.11);
  --warn: #ff8a4c;
  --warn-soft: rgb(255 138 76 / 0.12);
  --bad: #ff6369;
  --bad-soft: rgb(255 99 105 / 0.11);
  --work: #ffb31a;
  --idle: #5c5c66;
  --edge: #3a3a42;
  --code-bg: #0c0c0f;
  --add: #0f2a1d;
  --del: #351719;
  --screen: #050506;
  --screen-cell: rgb(255 255 255 / 0.05);
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.5);
  --shadow-md: 0 1px 0 rgb(255 255 255 / 0.03) inset, 0 10px 30px -8px rgb(0 0 0 / 0.6);
  --shadow-lg: 0 1px 0 rgb(255 255 255 / 0.04) inset, 0 30px 70px -10px rgb(0 0 0 / 0.75);
  --scrim: rgb(0 0 0 / 0.5);
  color-scheme: dark;
}
```

Note: the old aliases sit on `:root` and refer to the new names, which the theme blocks redefine on the same
element, so they follow the theme without being repeated.

- [ ] **Step 2: Add the new colors and utilities in `styles.css`**

In `@theme inline`, add after `--color-accent-soft: var(--accent-soft);`:

```css
  --color-accent-fg: var(--accent-text);
  --color-focus: var(--focus);
  --color-control: var(--control);
  --color-control-hover: var(--control-hover);
  --color-control-active: var(--control-active);
  --color-fill: var(--fill);
  --color-fill-strong: var(--fill-strong);
  --color-row-selected: var(--row-selected);
```

Replace the `@utility glass { … }` block with:

```css
/* Materials: translucent layers for navigation chrome only. */
@utility material-sidebar {
  background: var(--material-sidebar);
  backdrop-filter: blur(30px) saturate(180%);
}
@utility material-toolbar {
  background: var(--material-toolbar);
  backdrop-filter: blur(30px) saturate(180%);
}
@utility material-menu {
  background: var(--material-menu);
  backdrop-filter: blur(30px) saturate(180%);
  box-shadow: inset 0 0.5px 0 rgb(255 255 255 / 0.12), var(--shadow-lg);
}
@utility glass {
  background: var(--material-toolbar);
  backdrop-filter: blur(30px) saturate(180%);
}

/* Window chrome the desktop shell can drag by; controls inside opt out. */
@utility drag-region {
  app-region: drag;
  -webkit-app-region: drag;
}
@utility no-drag {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}
```

- [ ] **Step 3: Replace the `@layer base` block in `styles.css`**

```css
@layer base {
  html,
  body,
  #root {
    height: 100%;
  }
  /* The window never scrolls or bounces as a whole; panes scroll on their own. */
  html,
  body {
    overscroll-behavior: none;
    overflow: hidden;
  }
  body {
    background: var(--window);
    color: var(--label);
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    letter-spacing: -0.006em;
    /* App chrome is not text to select, and only links get the hand cursor. */
    -webkit-user-select: none;
    user-select: none;
    cursor: default;
  }
  input,
  textarea,
  [contenteditable="true"],
  [contenteditable=""],
  pre,
  code,
  samp {
    -webkit-user-select: text;
    user-select: text;
  }
  button {
    -webkit-user-select: none;
    user-select: none;
  }
  a[href] {
    cursor: pointer;
  }
  img,
  a {
    -webkit-user-drag: none;
  }
  :focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  /* Motion that loops or pulses stops for people who asked for less motion; spinners still turn slowly. */
  @media (prefers-reduced-motion: reduce) {
    .animate-ping,
    .animate-pulse,
    .animate-bounce {
      animation: none;
    }
    .animate-spin {
      animation-duration: 2.4s;
    }
  }
  ::selection {
    background: color-mix(in srgb, var(--signal) 32%, transparent);
  }
  /* Scrollbars stay out of the way until a pane is hovered, as macOS overlay scrollbars do. */
  * {
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
  }
  *:hover {
    scrollbar-color: var(--fill-strong) transparent;
  }
  [data-window-active="false"] ::selection {
    background: color-mix(in srgb, var(--label-3) 25%, transparent);
  }
}
```

- [ ] **Step 4: Sweep `text-accent` to the AA-safe text color**

Run from the repo root:

```bash
grep -rl 'text-accent' apps/web/src/client --include='*.tsx' | grep -v /vendor/ \
  | xargs perl -pi -e 's/\btext-accent\b(?!-)/text-accent-fg/g'
grep -rn '\btext-accent\b' apps/web/src/client | grep -v vendor | grep -v 'text-accent-fg'
```

Expected: the second command prints nothing.

- [ ] **Step 5: Remove `cursor-pointer` from non-links**

These are `<summary>`, `<select>`, labels and buttons, which get the default cursor in a native app:

```bash
perl -pi -e 's/ cursor-pointer\b//g; s/\bcursor-pointer //g' \
  apps/web/src/client/ColonyScreen.tsx apps/web/src/client/Compare.tsx apps/web/src/client/ui/primitives.tsx \
  apps/web/src/client/chat/Hero.tsx apps/web/src/client/chat/ProjectPermissions.tsx \
  apps/web/src/client/chat/AgentSheet.tsx apps/web/src/client/chat/FolderPicker.tsx \
  apps/web/src/client/chat/StepRow.tsx apps/web/src/client/chat/Workspace.tsx apps/web/src/client/chat/RoundView.tsx
grep -rn 'cursor-pointer' apps/web/src/client --include='*.tsx' | grep -v vendor
```

Expected: the grep prints nothing.

- [ ] **Step 6: Mark reading content selectable**

`apps/web/src/client/chat/Markdown.tsx:242` — change the root to:

```tsx
  return (
    <div className="select-text break-words text-[14px] leading-[1.65] text-fg [&>*:first-child]:mt-0">{blocks}</div>
  )
```

`apps/web/src/client/chat/RoundView.tsx:314` — add `select-text` and the reading size to the person's bubble:

```tsx
      <div className="max-w-[min(85%,640px)] select-text whitespace-pre-wrap break-words rounded-[22px] rounded-br-md bg-bubble px-4 py-2.5 text-[14px] leading-[1.6] text-on-bubble shadow-soft">
```

- [ ] **Step 7: Check**

Run: `bun run check > "$SCRATCH/check.log" 2>&1; echo "exit $?"`. If Biome reports formatting only, run
`bunx biome format --write <the files it names>` and re-run. Expected: `exit 0`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/client/tokens.css apps/web/src/client/styles.css apps/web/src/client/chat/Markdown.tsx
git add $(git diff --name-only -- apps/web/src/client | grep '\.tsx$')
git diff --cached --stat
git commit -m "Native tokens and behavior: macOS type, amber accent, no page tells"
```

Before committing, read `git diff --cached --stat`: it must list only `tokens.css`, `styles.css` and `.tsx` files
from the sweeps in steps 4–6.

---

### Task 4: Base controls in macOS style

**Files:**
- Modify: `apps/web/src/client/ui/primitives.tsx` (Button, IconButton, Pill/Badge, Kbd, Switch, fields, Select,
  Segmented, Tabs, Empty)

**Interfaces:**
- Consumes: Tailwind colors from Task 3 (`control*`, `fill*`, `accent-fg`, `focus`).
- Produces (names and props unchanged, so no call site changes):
  - `Button` variants: `'primary' | 'push' | 'borderless' | 'toolbar' | 'destructive' | 'danger'`, plus the older
    `'secondary'` (= push), `'ghost'` (= borderless), `'soft'` kept until phase 6. Sizes `sm` 22px, `md` 28px.
  - `IconButton` sizes `sm` 24px, `md` 28px; `active` shows a pressed neutral fill.
  - `Badge` (new name) with `Pill` exported as an alias; same `tone` prop.
  - `Select` styled as a macOS popup button (keeps the native `<select>`).

- [ ] **Step 1: Replace the Button block (lines 18–76)**

```tsx
type Variant =
  | 'primary'
  | 'push'
  | 'borderless'
  | 'toolbar'
  | 'destructive'
  | 'danger'
  // Older names, kept until every screen uses the ones above.
  | 'secondary'
  | 'ghost'
  | 'soft'
type Size = 'sm' | 'md'

const PUSH =
  'border border-line-strong/70 bg-control text-fg shadow-[0_0.5px_1px_rgb(0_0_0/0.08)] hover:bg-control-hover active:bg-control-active'
const BORDERLESS = 'text-fg-2 hover:bg-fill hover:text-fg active:bg-fill-strong'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-on-accent shadow-[inset_0_0.5px_0_rgb(255_255_255/0.4),0_0.5px_1px_rgb(0_0_0/0.2)] hover:bg-accent-hover active:brightness-95',
  push: PUSH,
  borderless: BORDERLESS,
  toolbar: BORDERLESS,
  destructive: 'bg-bad text-white shadow-[0_0.5px_1px_rgb(0_0_0/0.2)] hover:brightness-110',
  danger: 'border border-bad/35 text-bad hover:bg-bad-soft',
  secondary: PUSH,
  ghost: BORDERLESS,
  soft: 'bg-accent-soft text-accent-fg hover:brightness-105',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode }
>(function Button(
  { variant = 'push', size = 'md', icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-100 disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-[22px] rounded-[5px] px-2 text-[12px]' : 'h-7 rounded-md px-3 text-[13px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: Size }
>(function IconButton({ label, active, size = 'md', className, children, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-md transition-colors duration-100 disabled:opacity-40',
        size === 'sm' ? 'size-6' : 'size-7',
        active ? 'bg-fill-strong text-fg' : 'text-fg-2 hover:bg-fill hover:text-fg active:bg-fill-strong',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})
```

Note: the default variant changes from `'secondary'` to `'push'`, which renders identically (`secondary` = push).

- [ ] **Step 2: Replace the tones, Pill and Kbd (lines 78–145)**

```tsx
const TONES = {
  neutral: 'bg-fill-strong text-fg-2',
  ok: 'bg-ok-soft text-ok',
  bad: 'bg-bad-soft text-bad',
  warn: 'bg-warn-soft text-warn',
  work: 'bg-work/10 text-work',
  accent: 'bg-accent-soft text-accent-fg',
} as const
export type Tone = keyof typeof TONES

export function toneFor(status: string): Tone {
  if (['completed', 'verified', 'ready'].includes(status)) return 'ok'
  if (['failed', 'rejected', 'stopped'].includes(status)) return 'bad'
  if (['submitted'].includes(status)) return 'warn'
  if (['running', 'created', 'working', 'in_progress'].includes(status)) return 'work'
  if (['waiting'].includes(status)) return 'accent'
  return 'neutral'
}

/** A small status capsule. */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[11px] font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** The older name for Badge, kept until every screen uses Badge. */
export const Pill = Badge
```

Keep `Dot` (lines 119–137) unchanged, then:

```tsx
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line bg-fill px-1 font-sans text-[11px] text-muted">
      {children}
    </kbd>
  )
}
```

- [ ] **Step 3: Replace Switch, the field style, TextInput, TextArea and Select (lines 147–202)**

```tsx
export function Switch(props: {
  checked: boolean
  onChange(v: boolean): void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-200 disabled:opacity-40',
        props.checked ? 'bg-accent' : 'bg-fill-strong shadow-[inset_0_0_0_0.5px_var(--separator-strong)]',
      )}
    >
      <motion.span
        layout
        transition={spring}
        className={cn(
          'size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25),0_0_0_0.5px_rgb(0_0_0/0.06)]',
          props.checked ? 'ml-auto' : 'ml-0',
        )}
      />
    </button>
  )
}

const FIELD =
  'w-full rounded-md border border-line-strong/70 bg-control px-2.5 py-1.5 text-[13px] text-fg shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.06)] outline-none transition-[border,box-shadow] duration-100 placeholder:text-muted focus:border-focus focus:ring-3 focus:ring-focus/30 disabled:opacity-50'

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(FIELD, className)} {...rest} />
  },
)

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...rest }, ref) {
    return (
      <textarea ref={ref} className={cn(FIELD, 'min-h-24 resize-y leading-relaxed', className)} {...rest} />
    )
  },
)

/** A native select drawn as a macOS popup button: keyboard and screen readers keep the real control. */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-7 appearance-none rounded-md border border-line-strong/70 bg-control bg-[image:var(--chevrons)] bg-[length:10px_14px] bg-[position:right_8px_center] bg-no-repeat pl-2.5 pr-7 text-[13px] text-fg shadow-[0_0.5px_1px_rgb(0_0_0/0.08)] outline-none transition-colors duration-100 hover:bg-control-hover focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/30 disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  )
}
```

- [ ] **Step 4: Replace Segmented, Tabs and Empty (lines 224–318, keeping Field and Skeleton as they are)**

```tsx
/** macOS segmented control with a sliding thumb. */
export function Segmented<T extends string>(props: {
  value: T
  options: { value: NoInfer<T>; label: ReactNode }[]
  onChange(v: NoInfer<T>): void
  id: string
}) {
  return (
    <div className="inline-flex rounded-md bg-fill-strong p-[2px]">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
          className={cn(
            'relative inline-flex h-[22px] items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors',
            props.value === o.value ? 'text-fg' : 'text-fg-2 hover:text-fg',
          )}
        >
          {props.value === o.value && (
            <motion.span
              layoutId={`seg-${props.id}`}
              transition={spring}
              className="absolute inset-0 rounded-[5px] bg-control shadow-[0_0.5px_2px_rgb(0_0_0/0.18),0_0_0_0.5px_rgb(0_0_0/0.05)]"
            />
          )}
          <span className="relative inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/** Underline tabs whose amber indicator glides between items. */
export function Tabs<T extends string>(props: {
  value: T
  tabs: { value: NoInfer<T>; label: ReactNode; count?: number }[]
  onChange(v: NoInfer<T>): void
  id: string
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn('flex gap-1 overflow-x-auto border-b border-line px-3', props.className)}
    >
      {props.tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={props.value === t.value}
          onClick={() => props.onChange(t.value)}
          className={cn(
            'relative inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-2 text-[12.5px] font-medium transition-colors',
            props.value === t.value ? 'text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {t.label}
          {!!t.count && (
            <span className="rounded-full bg-fill-strong px-1.5 text-[11px] tabular-nums text-fg-2">{t.count}</span>
          )}
          {props.value === t.value && (
            <motion.span
              layoutId={`tab-${props.id}`}
              transition={spring}
              className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent"
            />
          )}
        </button>
      ))}
    </div>
  )
}
```

Keep `Skeleton` unchanged, then:

```tsx
export function Empty(props: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {props.icon && (
        <div className="grid size-10 place-items-center rounded-xl bg-fill text-muted">{props.icon}</div>
      )}
      <p className="text-[13px] font-semibold text-fg">{props.title}</p>
      {props.children && <div className="max-w-sm text-[12.5px] text-muted">{props.children}</div>}
    </div>
  )
}
```

- [ ] **Step 5: Check**

Run: `bun run check > "$SCRATCH/check.log" 2>&1; echo "exit $?"`. Format with Biome if it asks. Expected: `exit 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/client/ui/primitives.tsx
git commit -m "Base controls in macOS style: push and primary buttons, popup, switch"
```

---

### Task 5: Visual pass and fixes

**Files:**
- Modify: only what the pass shows is broken (expected: a few hard-coded sizes or colors in screens that relied on
  the old 15px body or the ink accent).

- [ ] **Step 1: Restart the test server on 4319 (never 4318)**

```bash
pkill -f "serve --port 4319"; cd /Users/robin/Desktop/Myrmidon && nohup bun apps/cli/src/main.ts serve --port 4319 --dev \
  --home /private/tmp/claude-501/-Users-robin-Desktop-Myrmidon/14e23d6b-d916-4324-acd9-e5896e74cca2/scratchpad/home-new \
  > "$SCRATCH/serve4319.log" 2>&1 &
```

- [ ] **Step 2: Check behavior in the in-app browser**

Open `http://localhost:4319/?chat=chat-muwy3bji-t2td` and run in the page:

```js
const cs = (sel) => getComputedStyle(document.querySelector(sel))
;({
  platform: document.documentElement.dataset.platform,
  shell: document.documentElement.dataset.shell,
  active: document.documentElement.dataset.windowActive,
  chromeSelect: cs('nav button').userSelect,
  bodyCursor: cs('body').cursor,
  markdownSelect: getComputedStyle(document.querySelector('.select-text')).userSelect,
  overscroll: cs('html').overscrollBehaviorY,
})
```

Expected: `platform: 'mac'`, `shell: 'browser'`, `active: 'true'` or `'false'`, `chromeSelect: 'none'`,
`bodyCursor: 'default'`, `markdownSelect: 'text'`, `overscroll: 'none'`.

- [ ] **Step 3: Screens at three widths, both themes**

Screenshot home, a chat, Settings and the workspace at 1440×900, 1100×800 and 800×600, in dark and light (switch the
theme in Settings → General). Look for: text overflowing the new 28px controls, unreadable amber text, buttons that
lost their border, icons misaligned in 28px icon buttons. Fix each at its source, smallest change, then re-check.

- [ ] **Step 4: Phone check**

375×812: the composer, sidebar slide-over and workspace still work.

- [ ] **Step 5: Check and commit fixes (if any)**

Run `bun run check` (exit code checked), then commit only the files changed in this task:

```bash
git add <files changed in this task>
git commit -m "Phase 1 visual fixes"
```

- [ ] **Step 6: Reset the browser viewport** to `desktop`.

---

## Later phases

Each gets its own plan, written when the previous phase is done, from spec section 9:

2. Window: Toolbar, SplitView, sidebar as source list, inspector chrome, inactive-window state.
3. Overlays: Menu, ContextMenu, Popover, Sheet (all modals), command menu, shortcuts sheet.
4. Content: new-task view, transcript, composer, Markdown, context menus.
5. Settings as System Settings.
6. The rest, alias removal, final browser-tells audit.
