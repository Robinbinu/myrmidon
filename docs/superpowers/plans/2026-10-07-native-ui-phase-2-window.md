# Native UI — Phase 2: Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the window read as a desktop app: a unified 52px title-bar row across every column (draggable in the
shell), a translucent source-list sidebar, resizable sidebar and inspector, and a dimmed look when the window is
inactive.

**Architecture:** Two new UI pieces: `ui/split.ts` (pure width math, unit-tested) with `ui/SplitDivider.tsx`
(`useSplitWidth` hook plus a draggable, keyboard-adjustable `separator`), and `ui/Toolbar.tsx` (the title-bar
row). App, Sidebar, Workspace and the Settings header adopt them. Inactive-window styling is pure CSS keyed off
`data-window-active`, which phase 1 already sets.

**Tech Stack:** React 19, Tailwind v4, motion, Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-07-native-ui-design.md` (sections 4, 5; phase 2 of section 9).

## Global Constraints

- Desktop only; the smallest supported window is 960×600. Existing phone code may stay; nothing is designed or
  tested for phones.
- Toolbars are 52px high and carry `drag-region`; controls inside them must stay clickable (`no-drag`, applied by a
  CSS rule in Task 2).
- Sidebar width 220–360px (default 260); inspector width 320–640px (default 440). Widths persist in
  `localStorage`; double-clicking a divider resets it.
- Below 1100px the inspector overlays the content; at 1100px and up it docks.
- Glass only on navigation chrome (sidebar, toolbars). No new dependencies.
- `$SCRATCH` = `/private/tmp/claude-501/-Users-robin-Desktop-Myrmidon/14e23d6b-d916-4324-acd9-e5896e74cca2/scratchpad`.
- Before every commit: `bun run check > "$SCRATCH/check.log" 2>&1; rc=$?` and commit only if `rc` is 0. Stage only
  the files the task lists.
- Visual checks use the test server on 4319 (restart it after client changes); never restart 4318.

---

### Task 1: Split widths and the divider

**Files:**
- Create: `apps/web/src/client/ui/split.ts`
- Create: `apps/web/src/client/ui/SplitDivider.tsx`
- Create: `apps/web/tests/split.test.ts`
- Modify: `apps/web/src/client/ui/hooks.ts` (export `readStored` and `store`)

**Interfaces:**
- Produces:
  - `clampWidth(w: number, min: number, max: number): number`
  - `dragWidth(start: number, dx: number, side: 'left' | 'right', min: number, max: number): number` — `side` is
    where the pane sits relative to its divider: a `left` pane (sidebar) grows as the divider moves right, a
    `right` pane (inspector) grows as it moves left.
  - `readWidth(raw: string | null, initial: number, min: number, max: number): number`
  - `interface Split { width: number; min: number; max: number; initial: number; dragging: boolean; set(w: number): void; reset(): void; setDragging(d: boolean): void }`
  - `useSplitWidth(key: string, opts: { min: number; max: number; initial: number }): Split`
  - `SplitDivider(props: { split: Split; side: 'left' | 'right'; label: string; className?: string })` — a
    zero-width flex item whose 8px hit area straddles the pane edge.

- [ ] **Step 1: Write the failing test**

`apps/web/tests/split.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { clampWidth, dragWidth, readWidth } from '../src/client/ui/split.ts'

test('widths stay within their limits and are whole pixels', () => {
  expect(clampWidth(100, 220, 360)).toBe(220)
  expect(clampWidth(500, 220, 360)).toBe(360)
  expect(clampWidth(250.6, 220, 360)).toBe(251)
})

test('a left pane grows as its divider moves right, a right pane as it moves left', () => {
  expect(dragWidth(260, 40, 'left', 220, 360)).toBe(300)
  expect(dragWidth(440, 40, 'right', 320, 640)).toBe(400)
  expect(dragWidth(440, -400, 'right', 320, 640)).toBe(640)
})

test('a stored width is used only when it is a number', () => {
  expect(readWidth('300', 260, 220, 360)).toBe(300)
  expect(readWidth('9000', 260, 220, 360)).toBe(360)
  expect(readWidth(null, 260, 220, 360)).toBe(260)
  expect(readWidth('wide', 260, 220, 360)).toBe(260)
  expect(readWidth('', 260, 220, 360)).toBe(260)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test apps/web/tests/split.test.ts` — expected FAIL, module not found.

- [ ] **Step 3: Implement `ui/split.ts`**

```ts
/** Width math for resizable panes; the divider component and hook live in SplitDivider.tsx. */

export function clampWidth(w: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, w)))
}

/** A pane left of its divider grows as the divider moves right; a pane right of it grows as it moves left. */
export function dragWidth(start: number, dx: number, side: 'left' | 'right', min: number, max: number): number {
  return clampWidth(side === 'left' ? start + dx : start - dx, min, max)
}

export function readWidth(raw: string | null, initial: number, min: number, max: number): number {
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) ? clampWidth(n, min, max) : initial
}
```

- [ ] **Step 4: Run the test** — `bun test apps/web/tests/split.test.ts`, expected PASS (3 tests).

- [ ] **Step 5: Export the storage helpers**

In `apps/web/src/client/ui/hooks.ts` change `function readStored<T extends string>(` to
`export function readStored<T extends string>(` and `function store(` to `export function store(`.

- [ ] **Step 6: Implement `ui/SplitDivider.tsx`**

```tsx
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import { readStored, store } from './hooks.ts'
import { cn } from './primitives.tsx'
import { clampWidth, dragWidth, readWidth } from './split.ts'

export interface Split {
  width: number
  min: number
  max: number
  initial: number
  dragging: boolean
  set(w: number): void
  reset(): void
  setDragging(d: boolean): void
}

/** A pane width the person can drag, remembered on this machine. */
export function useSplitWidth(key: string, opts: { min: number; max: number; initial: number }): Split {
  const [width, setWidth] = useState(() => readWidth(readStored(key, ''), opts.initial, opts.min, opts.max))
  const [dragging, setDragging] = useState(false)
  const set = (w: number) => {
    const next = clampWidth(w, opts.min, opts.max)
    setWidth(next)
    store(key, String(next))
  }
  return { width, ...opts, dragging, set, reset: () => set(opts.initial), setDragging }
}

/**
 * The edge between two panes: drag it, or focus it and use the arrow keys (Shift for bigger steps, Home and End for
 * the limits); double-click puts the width back. It takes no room; its hit area straddles the edge.
 */
export function SplitDivider(props: { split: Split; side: 'left' | 'right'; label: string; className?: string }) {
  const { split, side } = props
  const start = useRef<{ x: number; width: number }>(undefined)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, width: split.width }
    split.setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    split.set(dragWidth(start.current.width, e.clientX - start.current.x, side, split.min, split.max))
  }
  const end = () => {
    start.current = undefined
    split.setDragging(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16
    // Arrow keys move the divider, so for a right-hand pane "left" means wider.
    const grow = side === 'left' ? 1 : -1
    const moves: Record<string, () => number> = {
      ArrowLeft: () => split.width - step * grow,
      ArrowRight: () => split.width + step * grow,
      Home: () => split.min,
      End: () => split.max,
    }
    const next = moves[e.key]
    if (!next) return
    e.preventDefault()
    split.set(next())
  }
  return (
    <div className={cn('relative z-30 w-0 shrink-0', props.className)}>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable, adjustable separator has no native element */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={props.label}
        aria-valuenow={split.width}
        aria-valuemin={split.min}
        aria-valuemax={split.max}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={split.reset}
        onKeyDown={onKeyDown}
        className={cn(
          'absolute inset-y-0 -left-1 w-2 cursor-col-resize outline-none transition-colors',
          'hover:bg-focus/25 focus-visible:bg-focus/40',
          split.dragging && 'bg-focus/40',
        )}
      />
    </div>
  )
}
```

If Biome reports the `biome-ignore` comment as unused (the rule did not fire), delete the comment line.

- [ ] **Step 7: Check and commit**

```bash
bun run check > "$SCRATCH/check.log" 2>&1; rc=$?; echo "exit $rc"
[ $rc -eq 0 ] && git add apps/web/src/client/ui/split.ts apps/web/src/client/ui/SplitDivider.tsx \
  apps/web/tests/split.test.ts apps/web/src/client/ui/hooks.ts && git commit -m "Split panes: drag, keyboard and double-click to reset"
```

---

### Task 2: The title-bar row and inactive-window styling

**Files:**
- Create: `apps/web/src/client/ui/Toolbar.tsx`
- Modify: `apps/web/src/client/styles.css` (append rules and a `browser` variant)

**Interfaces:**
- Produces:
  - `Toolbar(props: { children: ReactNode; inset?: boolean; material?: boolean; className?: string })` — 52px row,
    `drag-region`, `data-toolbar`, bottom hairline. `inset` adds the shell's traffic-light inset on the left.
    `material` (default `true`) gives it the toolbar glass; the sidebar passes `false` because it sits on the
    sidebar material already.
  - `ToolbarTitle(props: { children: ReactNode })` — the 13px semibold title that fills the row.
  - Tailwind variant `browser:` — applies only when `data-shell="browser"` (no desktop shell, so no traffic
    lights).

- [ ] **Step 1: Create `ui/Toolbar.tsx`**

```tsx
import type { ReactNode } from 'react'
import { cn } from './primitives.tsx'

/**
 * A column's title-bar row. Rows in neighbouring columns line up into one unified title bar; the desktop shell drags
 * the window by them, and leaves room for its window buttons through --titlebar-inset.
 */
export function Toolbar(props: { children: ReactNode; inset?: boolean; material?: boolean; className?: string }) {
  return (
    <div
      data-toolbar
      className={cn(
        'drag-region relative z-10 flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-2',
        props.material !== false && 'material-toolbar',
        props.inset && 'pl-[calc(var(--titlebar-inset)+0.5rem)]',
        props.className,
      )}
    >
      {props.children}
    </div>
  )
}

export function ToolbarTitle(props: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-[13px] font-semibold">{props.children}</div>
}
```

- [ ] **Step 2: Add the CSS**

In `apps/web/src/client/styles.css`, after the existing `@custom-variant dark (...)` line, add:

```css
/* In a plain browser there are no window buttons in the title bar, so the app shows its own mark there. */
@custom-variant browser (&:where([data-shell="browser"], [data-shell="browser"] *));
```

At the end of the file (outside any layer, so it overrides the theme tokens), append:

```css
/* Controls inside a draggable title bar stay clickable in the desktop shell. */
.drag-region :is(button, a, input, select, textarea, [role="button"], [role="separator"]) {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

/* An inactive window greys its selection and dims its title bars, as macOS does. */
:root[data-window-active="false"] {
  --row-selected: var(--row-selected-inactive);
}
[data-toolbar] > * {
  transition: opacity var(--fast) var(--ease);
}
:root[data-window-active="false"] [data-toolbar] > * {
  opacity: 0.55;
}
```

- [ ] **Step 3: Check and commit**

```bash
bun run check > "$SCRATCH/check.log" 2>&1; rc=$?; echo "exit $rc"
[ $rc -eq 0 ] && git add apps/web/src/client/ui/Toolbar.tsx apps/web/src/client/styles.css \
  && git commit -m "Title-bar rows: draggable, inset for window buttons, dim when inactive"
```

---

### Task 3: The sidebar as a source list

**Files:**
- Modify: `apps/web/src/client/chat/Sidebar.tsx`

**Interfaces:**
- Consumes: `Toolbar` (Task 2), `comboLabel` from `ui/shortcuts.ts`, `isMac` from `ui/platform.ts`.
- Props unchanged. The aside now fills its parent's width (the parent sets it).

- [ ] **Step 1: Imports**

Replace `Plus,` with `Plus,` + `SquarePen,` in the lucide import list and `PanelLeftClose,` with `PanelLeft,`. Add:

```tsx
import { isMac } from '../ui/platform.ts'
import { comboLabel } from '../ui/shortcuts.ts'
import { Toolbar } from '../ui/Toolbar.tsx'
```

- [ ] **Step 2: Chat rows (inside `row`)**

Rename input class → `"h-7 w-full rounded-md border border-focus bg-control px-2 text-[13px] outline-none ring-3 ring-focus/30"`.

Row button class:

```tsx
            className={cn(
              'relative flex h-7 w-full items-center gap-2 rounded-md pl-2 pr-14 text-left text-[13px] transition-colors',
              on ? 'text-fg' : 'text-fg-2 hover:bg-fill/70 hover:text-fg',
            )}
```

Selection highlight span class → `"absolute inset-0 rounded-md bg-row-selected"`. Inner span `gap-2.5` → `gap-2`.

Rename button class → `"absolute right-7 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-fill-strong hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"`.

Delete button class → `"absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-bad-soft hover:text-bad focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"`.

- [ ] **Step 3: Footer item style (`navItem`)**

```tsx
  const navItem = (on: boolean) =>
    cn(
      'flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors',
      on ? 'bg-row-selected text-fg' : 'text-fg-2 hover:bg-fill/70 hover:text-fg',
    )
```

- [ ] **Step 4: Replace the top of the aside (from `<aside` through the closing `</div>` of the search block)**

```tsx
    <aside
      className="material-sidebar flex h-full w-full flex-col border-r border-line"
      aria-label="Conversations"
    >
      <Toolbar inset material={false} className="border-b-0">
        <span className="hidden items-center gap-2 pl-1 text-[13px] font-semibold tracking-[-0.01em] browser:flex">
          <Logo size={20} />
          Myrmidon
        </span>
        <span className="flex-1" />
        <IconButton label="Hide sidebar" title={`Hide sidebar (${comboLabel('mod+b', isMac)})`} onClick={props.onCollapse}>
          <PanelLeft className="size-4" />
        </IconButton>
        <IconButton label="New task" title={`New task (${comboLabel('mod+n', isMac)})`} onClick={props.onNew}>
          <SquarePen className="size-4" />
        </IconButton>
      </Toolbar>
      <div className="px-2.5 pb-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search chats"
            className="h-7 w-full rounded-md bg-fill-strong/60 pl-7 pr-2 text-[13px] outline-none placeholder:text-muted focus:ring-3 focus:ring-focus/30"
          />
        </div>
      </div>
```

- [ ] **Step 5: Section headers, project rows and the list padding**

`<nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">` → `<nav className="min-h-0 flex-1 overflow-auto px-2.5 pb-3">`.

Projects header row: `"group/projects flex items-center px-3 pb-1 pt-3"` → `"group/projects flex items-center px-2 pb-1 pt-3"`; its label class
`"flex-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted"` → `"flex-1 text-[11px] font-semibold text-muted"`;
its add button class → `"grid size-5 place-items-center rounded-md text-muted transition-colors hover:bg-fill-strong hover:text-fg"`.

Empty-projects button: `rounded-lg px-2.5 py-2 … text-[12.5px] … hover:bg-surface-2` →
`"mx-0 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-muted hover:bg-fill/70 hover:text-fg"`.

Project row button class → `"flex h-7 w-full items-center gap-1.5 rounded-md pl-1 pr-20 text-left text-[13px] text-fg-2 transition-colors hover:bg-fill/70 hover:text-fg"`,
and its name span `"truncate font-medium"` → `"truncate"`.

The three project action buttons: `size-7` → `size-6`, `rounded-md` kept, `hover:bg-surface-3` → `hover:bg-fill-strong`,
and positions `right-[4.25rem]` → `right-[3.25rem]`, `right-9` → `right-7`, `right-1.5` → `right-1`.

Project chats wrapper `"ml-4 border-l border-line pl-1"` → `"pl-5"`.

Date group header `"px-3 pb-1 pt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted"` →
`"px-2 pb-1 pt-4 text-[11px] font-semibold text-muted"`.

Empty-state paragraphs: `px-3 py-4 text-[13px]` → `px-2 py-4 text-[12.5px]`; "No chats yet" `px-3 py-1.5 text-[12px]` → `px-2 py-1 text-[12px]`.

- [ ] **Step 6: Footer container**

`"grid gap-0.5 border-t border-line p-2"` → `"grid gap-px border-t border-line p-2.5"`.

- [ ] **Step 7: Check and commit**

```bash
bun run check > "$SCRATCH/check.log" 2>&1; rc=$?; echo "exit $rc"
[ $rc -eq 0 ] && git add apps/web/src/client/chat/Sidebar.tsx && git commit -m "Sidebar as a source list: toolbar, 28px rows, neutral selection"
```

---

### Task 4: The window shell: sidebar width, main toolbar, inspector

**Files:**
- Modify: `apps/web/src/client/App.tsx`
- Modify: `apps/web/src/client/chat/Workspace.tsx`
- Modify: `apps/web/src/client/Settings.tsx:232` (header only)

**Interfaces:**
- Consumes: `useSplitWidth`, `SplitDivider` (Task 1); `Toolbar`, `ToolbarTitle` (Task 2); `comboLabel`, `isMac`.

- [ ] **Step 1: App imports and state**

Add imports:

```tsx
import { SplitDivider, useSplitWidth } from './ui/SplitDivider.tsx'
import { isMac } from './ui/platform.ts'
import { comboLabel } from './ui/shortcuts.ts'
import { Toolbar, ToolbarTitle } from './ui/Toolbar.tsx'
```

Add `SquarePen` to the lucide import. After the `workspaceOpen` state add:

```tsx
  const sidebarSplit = useSplitWidth('myr-sidebar-width', { min: 220, max: 360, initial: 260 })
```

Change `if (window.innerWidth < 1280) setWorkspaceOpen(false)` to `if (window.innerWidth < 1100) setWorkspaceOpen(false)`.

Add to `useHotkeys([...])`: `{ combo: 'mod+n', run: () => newTask(), inInputs: true },`.

- [ ] **Step 2: Sidebar column**

Replace the desktop sidebar `motion.div` (key `"sidebar"`) with:

```tsx
          {!collapsed && (
            <motion.div
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: sidebarSplit.width, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={sidebarSplit.dragging ? { duration: 0 } : softSpring}
              className="hidden shrink-0 overflow-hidden md:block"
            >
              {sidebar}
            </motion.div>
          )}
```

and right after the closing `</AnimatePresence>` of that block add:

```tsx
        {!collapsed && <SplitDivider split={sidebarSplit} side="left" label="Resize sidebar" className="hidden md:block" />}
```

- [ ] **Step 3: Main toolbar**

Replace the `<header className="glass relative z-10 flex h-14 …">` element and its contents up to the title with:

```tsx
              <Toolbar inset={collapsed}>
                <IconButton
                  label="Show sidebar"
                  title={`Show sidebar (${comboLabel('mod+b', isMac)})`}
                  onClick={() => (window.innerWidth < 768 ? setMobileNav(true) : setCollapsed(!collapsed))}
                  className={cn(!collapsed && 'md:hidden')}
                >
                  <PanelLeft className="size-4" />
                </IconButton>
                {collapsed && (
                  <IconButton label="New task" title={`New task (${comboLabel('mod+n', isMac)})`} onClick={() => newTask()}>
                    <SquarePen className="size-4" />
                  </IconButton>
                )}
                <ToolbarTitle>
                  <motion.span key={title} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="truncate">
                    {title}
                  </motion.span>
                  {view === 'chat' && chat && (
                    <Pill tone={toneFor(running ? 'running' : chat.status)}>{running ? 'working' : chat.status}</Pill>
                  )}
                </ToolbarTitle>
```

Keep the two trailing controls (Workspace `IconButton`, Colony `Button`) as they are, but change the Colony button's
`variant="ghost"` to `variant="toolbar"`, and close with `</Toolbar>` instead of `</header>`. Remove the now-unused
`<div className="flex min-w-0 flex-1 items-center gap-2">` wrapper (its contents moved into `ToolbarTitle`).

- [ ] **Step 4: Inspector (Workspace) width and toolbar**

In `WorkspaceBody` add, after `const colony = useColony(colonyId)`:

```tsx
  const split = useSplitWidth('myr-inspector-width', { min: 320, max: 640, initial: 440 })
```

with `import { SplitDivider, useSplitWidth } from '../ui/SplitDivider.tsx'`.

Replace the panel's class line 254 with:

```tsx
            'fixed inset-y-0 right-0 z-40 w-full shadow-pop md:right-12 md:w-[min(440px,calc(100vw-3rem))] min-[1100px]:static min-[1100px]:z-auto min-[1100px]:w-[var(--inspector-w)] min-[1100px]:shadow-none',
```

and give that `div` `style={{ '--inspector-w': `${split.width}px` } as CSSProperties}` (import `type CSSProperties`
from `react`). Directly before that panel `div`, inside `<div className="flex h-full min-h-0">`, add:

```tsx
        {open && <SplitDivider split={split} side="right" label="Resize workspace" className="hidden min-[1100px]:block" />}
```

Panel header (line 260) `"flex h-14 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2"` →
`"drag-region flex h-[52px] shrink-0 items-center gap-2 border-b border-line pl-4 pr-2"` and add the attribute
`data-toolbar` to that `div`.

- [ ] **Step 5: Inspector rail lines up with the title bar**

Rail `nav` class (line 645) → `"hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-line bg-surface pb-2 md:flex"`,
and insert as its first child:

```tsx
          <div data-toolbar className="drag-region mb-1 h-[52px] w-full shrink-0 border-b border-line" />
```

Rail buttons (line 664): `'relative grid size-9 place-items-center rounded-lg transition-colors'` →
`'relative grid size-8 place-items-center rounded-md transition-colors'`.

- [ ] **Step 6: Settings header**

`Settings.tsx:232` `className="glass flex h-14 shrink-0 items-center gap-2 border-b border-line px-3"` →
`data-toolbar className="drag-region material-toolbar flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-3"`,
and its two `text-[14px]` spans → `text-[13px]`.

- [ ] **Step 7: Check and commit**

```bash
bun run check > "$SCRATCH/check.log" 2>&1; rc=$?; echo "exit $rc"
[ $rc -eq 0 ] && git add apps/web/src/client/App.tsx apps/web/src/client/chat/Workspace.tsx apps/web/src/client/Settings.tsx \
  && git commit -m "Window shell: unified title bar, resizable sidebar and inspector"
```

---

### Task 5: Visual pass

- [ ] **Step 1:** Restart the 4319 server (never 4318).
- [ ] **Step 2:** At 1440×900, 1100×800 and 960×600, in dark and light, check:
  - the sidebar toolbar, main toolbar, inspector header and rail top line up as one 52px band;
  - the sidebar shows the Myrmidon mark (browser) and is translucent;
  - chat rows are 28px with a neutral selection;
  - dragging both dividers resizes within limits, and the widths survive a reload;
  - double-clicking a divider resets it, and arrow keys move a focused divider;
  - collapsing the sidebar (⌘B) shows the toggle and New task in the main toolbar;
  - the inspector docks at 1100 and above and overlays below.
- [ ] **Step 3:** Inactive window: run `window.dispatchEvent(new Event('blur'))` in the page. The selection turns
  grey and the toolbar contents dim. `focus` restores them.
- [ ] **Step 4:** Fix what is broken at its source, re-run the check, and commit only the files changed
  (`git commit -m "Phase 2 visual fixes"`). Reset the viewport to `desktop`.
