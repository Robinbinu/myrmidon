# Native UI overhaul — Design Spec

- **Date:** 2026-10-07
- **Status:** Draft, awaiting approval
- **Scope:** the web client (`apps/web/src/client`). The desktop shell (Electrobun or Tauri) is the next, separate
  project; this one makes the UI ready for it.

## 1. Goal

Someone using Myrmidon should not be able to tell they are in a web page. The client keeps Myrmidon's identity
(ink-and-paper palette, signal amber, pixel agent faces) and adopts the conventions of a premium macOS app, on every
OS: one look everywhere, like Linear, Raycast or the Claude and Codex desktop apps.

Success means:
- No browser behavior: no selectable labels, no pointer cursors on buttons, no page bounce, no browser context menu on
  app chrome, no dragged ghost images, no marketing-page layouts.
- The window is built from desktop parts: a unified toolbar that doubles as the title bar, a translucent source-list
  sidebar, resizable split panes, sheets, popovers, menus, context menus and keyboard shortcuts.
- The same build runs in a browser today and in a desktop shell later. The shell only sets a few attributes and
  receives the drag regions and inset that are already in place.

Non-goals: building the shell itself; per-OS themes (Windows Fluent, Adwaita); bundling SF Pro (Apple's license
forbids it off Apple platforms); redesigning what the screens do (flows and features stay as they are).

## 2. Decisions

| Decision | Choice | Reason |
|---|---|---|
| Look | Myrmidon identity in macOS style, same on every OS | Your choice. One design to keep consistent. |
| Type | `-apple-system, BlinkMacSystemFont` (SF on Apple), then Geist (already bundled) elsewhere; 13px for UI, 14px for reading content | macOS UI text is 13pt. Geist is close to SF and is already shipped. |
| Accent | Signal amber for primary buttons, focus rings and the active indicator, with near-black text on amber. Sidebar selection stays a neutral tint with an amber icon | Keeps the brand color and passes contrast. The neutral selection looks like Finder's graphite. |
| Materials | Glass (blur, saturation, hairline border, inner top highlight) only on the navigation layer: sidebar, toolbars, popovers, menus, sheets. Content stays opaque | Apple's Liquid Glass rule: glass floats over content and never sits behind lists or reading text. |
| Theme | Dark and light, follow the system, with an override in Settings (as now) | Both are already supported. |
| Shell readiness | `data-shell` and `data-platform` on `<html>`, a `--titlebar-inset` CSS variable, and `app-region: drag` on toolbars | Zero cost in the browser. The shell flips them later. |
| Dependencies | None new | motion, lucide, Tailwind v4 and React already cover everything. |

## 3. Native behavior (global)

Base layer, applied app-wide:
- `user-select: none` everywhere. Text that is content is selectable via a `select-text` utility: messages, Markdown,
  code, logs, diffs, file viewers, inputs and the audit list's targets.
- `cursor: default` everywhere. `pointer` is kept only for real links (`a[href]`).
- `-webkit-user-drag: none` on images and links, except elements that are meant to be dragged.
- No page scroll or bounce: `overscroll-behavior: none` on `html` and `body`. Panes scroll on their own with
  `overscroll-behavior: contain`.
- Scrollbars are thin, transparent until the pane is hovered or scrolling, and sit over the content.
- Focus rings show for keyboard focus only (`:focus-visible`). They are a soft 3px amber ring with a 6px radius.
- The browser context menu is suppressed on app chrome. It stays inside editable fields and over selected text, so
  spell check and Copy keep working. App context menus replace it where actions exist (section 5).
- An inactive window (`blur` on `window`) dims selection highlights and toolbar icons, as macOS does. This is set via
  `data-window-active` on `<html>`.
- External links always open outside the app (`target=_blank rel=noopener`). In the shell they go to the system
  browser.
- Native `title` tooltips stay as they are. The shell renders them as OS tooltips.

## 4. Window layout

```
┌───────────────┬──────────────────────────────────┬──────────────┬──┐
│ ● ● ●   ⊞  ✎  │  Title  · status        ⊕  ⋯     │ Inspector    │▣ │  ← unified toolbars, 52px, drag regions
├───────────────┼──────────────────────────────────┼──────────────┤▣ │
│ Source list   │                                  │              │▣ │
│ (glass)       │   Content (opaque)               │  Inspector   │▣ │  ← Workspace = inspector + icon rail
│  PROJECTS     │                                  │  panel       │  │
│   ▸ demo-app  │                                  │              │  │
│  TODAY        │                                  │              │  │
│   • chat      │   ┌──── composer ────┐           │              │  │
│ ───────────── │   └──────────────────┘           │              │  │
│ ⚙ Settings    │                                  │              │  │
└───────────────┴──────────────────────────────────┴──────────────┴──┘
     ↔ resizable                                       ↔ resizable
```

- **Toolbars.** Every column gets its own 52px toolbar row, so they line up into one unified title bar. The sidebar's
  toolbar reserves `--titlebar-inset` (0 in the browser, about 78px for macOS traffic lights in the shell). Toolbars
  are drag regions; controls inside them are `no-drag`. The current `h-14` header becomes this toolbar.
- **Sidebar (source list).**
  - Glass material.
  - Rows are 28px high with 13px text and 16px icons, and section headers are 11px semibold caps.
  - Selection is a rounded 6px neutral fill.
  - "New task" becomes a toolbar icon button (✎), with ⌘N.
  - Search is a compact field in the sidebar.
  - Settings, Colonies and Compare runs sit in a footer source group.
- **Split view.** The sidebar (220–360px) and the inspector (320–640px) are resizable by dragging their dividers.
  Widths persist per machine. Double-clicking a divider resets it.
- **Inspector (Workspace).** Its look is unchanged: the icon rail on the far right selects the view, as Xcode's
  inspector tabs do. It gets the toolbar row and the new density.
- **Narrow windows.** Below 1100px the inspector overlays the content. Below 768px the sidebar becomes a slide-over,
  as now. Phone layouts keep working but are not a target.

## 5. Components (`ui/`)

New or rebuilt primitives. Each is a small file with one purpose.

| Component | Replaces / adds | Notes |
|---|---|---|
| `platform.ts` | new | Detects the shell and OS, sets `data-shell`, `data-platform`, `data-window-active`, and exposes `isMac` for shortcut labels (⌘ or Ctrl). |
| `Toolbar` | header markup | 52px tall, drag region, title slot, leading and trailing groups. |
| `SplitView` | fixed widths | Resizable panes with persisted widths, keyboard-adjustable dividers and ARIA `separator`. |
| `SourceList` / `SourceRow` | Sidebar rows | Sections, rows, disclosure triangles and badges. |
| `Button` | `Button`, `IconButton` | Variants: `push` (bordered, subtle gradient), `primary` (amber), `borderless`, `toolbar` (icon, hover tint). 22/28px heights. No `rounded-full` buttons. |
| `Segmented` | `Segmented` | macOS segmented control. |
| `PopupButton` | `Select` | A native `<select>` (keeps keyboard and accessibility) styled as a macOS popup button with ⌃⌄ chevrons. |
| `Switch`, `Checkbox` | `Switch` | macOS proportions. |
| `Menu` / `ContextMenu` | new | Glass, 6px radius, 22px rows, shortcut hints, separators and destructive items last. Opened by `useContextMenu(items)`. Keyboard-navigable and closes on Esc or outside click. |
| `Popover` | ad-hoc dropdowns (model picker, project pill) | Anchored and scale-in from the anchor. |
| `Sheet` | `Modal` | Slides down from the toolbar, dims the window, ⌘. or Esc closes it. Full-size modals (the colony console) become a large sheet. |
| `shortcuts.ts` | scattered keydown handlers | A registry: `useShortcut('mod+n', fn)`, a shortcuts sheet (⌘/), and labels rendered per platform. |
| `Badge` | `Pill` | Small capsules used only for status. |

## 6. Screens

- **New task (home).** The marketing hero (big headline, floating cursors) gives way to a calm start view:
  - the pixel mascot at a modest size, a one-line greeting and the composer centered;
  - suggestion chips underneath and recent chats as a short list.
  - The pixel identity stays, with less theater.
- **Chat.**
  - Transcript and round cards get the new type scale, hairline cards and selectable content.
  - The composer becomes a glass-edged field anchored to the bottom, and its toolbar controls become popup buttons.
  - The title and status sit in the toolbar, and the Colony console opens as a sheet.
- **Context menus.**
  - Chat row: Rename, Export, Copy link, Delete.
  - Project row: New task here, Permissions, Reveal path.
  - Message: Copy, Copy as Markdown.
  - File: Open, Copy name.
  - Audit target, shell command or URL: Copy.
- **Settings.** Laid out like System Settings: a left list of sections with small monochrome icon tiles and grouped
  forms on the right (inset rounded groups, label left, control right). It keeps all of today's sections and contents.
- **Command menu (⌘K).** Spotlight style: a floating glass panel, a large field and grouped results.
- **Colony console, Compare, Git and Diff views.** These are restyled through the tokens and primitives, with no
  layout changes beyond the toolbar and density.

## 7. Shortcuts

| Keys | Action |
|---|---|
| ⌘N | New task |
| ⌘K | Command menu |
| ⌘, | Settings |
| ⌘B | Toggle sidebar |
| ⌘J | Toggle inspector |
| ⌘1…⌘9 | Jump to the nth chat in the sidebar |
| ⌘⇧[ / ⌘⇧] | Previous or next chat |
| ⌘/ | Keyboard shortcuts sheet |
| ⌘. / Esc | Stop the round, or close the sheet when one is open |

On Windows and Linux, ⌘ is Ctrl. Browsers reserve some of these keys (⌘N, ⌘W): those work in the shell and fall back to
the menu in a browser.

## 8. Tokens

`tokens.css` is rewritten around these groups:
- **Surfaces:** `window`, `sidebar` (glass), `content`, `raised`, `control`, `separator` (hairline).
- **Text:** `label`, `secondary`, `tertiary`, `quaternary`, as in macOS's label colors.
- **Accent:** `accent` (amber), `on-accent`, `focus`.
- **Status:** `ok`, `warn`, `bad`, `work`, `idle`.
- **Type scale:** 11, 12, 13 (UI), 14 (reading), 17 (title), 22 (large title).
- **Radii:** 4 (badges), 6 (controls and menus), 10 (cards and popovers), 14 (sheets).
- **Materials:** glass blur 30px, saturate 180%, and a tint at 70% (dark) or 72% (light).
- **Motion:** 120ms for controls, 200ms for popovers and sheets, and standard ease-out. Reduced motion is honored.

AA contrast is kept on every surface in both themes, as now. The old token names are kept as aliases until every
screen is migrated, then removed.

## 9. Phases

Each phase is one commit, checked with `bun run check` and a visual pass before the next one.

1. **Foundation.**
   - Tokens, type and global behaviors (section 3).
   - `platform.ts` and `shortcuts.ts`.
   - Button, Segmented, PopupButton, Switch and Badge.
2. **Window.**
   - Toolbar and SplitView.
   - The sidebar as a source list.
   - Inspector chrome and the inactive-window state.
3. **Overlays.** Menu, ContextMenu, Popover, Sheet (all modals move to it), the command menu and the shortcuts sheet.
4. **Content.** The new-task view, transcript, composer, Markdown and context menus.
5. **Settings** as System Settings.
6. **The rest.**
   - Colony console, Compare, Git, Diff and Audit.
   - Remove legacy aliases and `legacy.css` classes that are no longer used.
   - A final "browser tells" audit.

## 10. Testing

- `bun run check` (typecheck, Biome, tests) passes after every phase.
- Unit tests cover the pure logic: shortcut parsing and matching, platform labels and split-view width clamping.
- Visual pass after every phase in the in-app browser:
  - widths 1440, 1100 and 800, in dark and light;
  - a phone check at 375.
- Final audit checklist, each item checked by hand:
  - no selectable chrome text, no pointer cursor except on links, no overscroll;
  - no browser context menu on chrome, and every shortcut works;
  - sheets close with Esc, and keyboard focus is visible;
  - AA contrast holds in both themes.

## 11. Risks

- **Size.** Many files change, Settings.tsx (2.6k lines) most of all. Phases keep each step reviewable, and the old
  token aliases keep unmigrated screens rendering correctly in the meantime.
- **Browser-reserved shortcuts.** These are documented and work in the shell. Nothing depends on them in the browser.
- **Glass performance.** Backdrop blur is used only on the navigation layer, never on scrolling content.
