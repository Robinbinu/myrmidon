/**
 * The Myrmidon desktop app's main process (Electrobun, on Bun): it starts or finds the Myrmidon server, shows its
 * dashboard in a native window with the platform's chrome and an app menu, and answers the page's bridge requests.
 * What differs between macOS, Linux and Windows is decided in src/platform.ts.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import Electrobun, {
  ApplicationMenu,
  type ApplicationMenuItemConfig,
  BrowserWindow,
  BuildConfig,
  GlobalShortcut,
  PATHS,
  Screen,
  Utils,
} from 'electrobun/main'
import { DESKTOP_COMPUTER_STOP } from '../../web/src/client/ui/desktop.ts'
import {
  badgeLabel,
  insetScript,
  parseRequest,
  preloadScript,
  type Request,
  replyScript,
  shortcutScript,
} from '../src/bridge.ts'
import { COMPUTER_STOP_KEYS, WINDOW_SIZE } from '../src/config.ts'
import { desktopCopy } from '../src/copy.ts'
import { setDockBadge } from '../src/dock.ts'
import { prepareOverlayWindow } from '../src/overlay-window.ts'
import { asPlatform, executableName, menuFor, titlebarInset, windowChrome } from '../src/platform.ts'
import {
  freePort,
  loopbackOrigin,
  myrmidonHome,
  overlayUrl,
  runningServer,
  type Server,
  startServer,
} from '../src/server.ts'

const t = desktopCopy
const platform = asPlatform(process.platform)
const chrome = windowChrome(platform)
const home = myrmidonHome()
const existing = await runningServer(home)
const port = existing ? undefined : freePort()
const origin = existing ? new URL(existing.pageUrl).origin : loopbackOrigin(port ?? 0)
// Only the page's main frame on this origin learns it, so iframes cannot use the bridge (see src/bridge.ts).
const secret = crypto.randomUUID()

const win = new BrowserWindow({
  title: t.appName,
  // A server to start shows a loading page meanwhile; it loads asynchronously, so the dashboard waits for it below.
  ...(existing ? { url: existing.pageUrl } : { html: loadingPage() }),
  frame: { ...WINDOW_SIZE },
  titleBarStyle: chrome.titleBarStyle,
  preload: preloadScript({ origin, secret, titlebarInsetPx: chrome.titlebarInsetPx }),
})
if (chrome.buttons) win.setWindowButtonPosition(chrome.buttons.x, chrome.buttons.y)

const run = (script: string) => win.webview.executeJavascript(script)
/** The dashboard's address, token included, once there is a server to show. */
let dashboard: string | undefined = existing?.pageUrl
// Entering or leaving full screen resizes the window; a reload starts again from the preload's windowed inset.
const fitTitlebar = () => run(insetScript(titlebarInset(chrome, win.isFullScreen())))
if (chrome.titlebarInsetPx) {
  win.on('resize', fitTitlebar)
  win.webview.on('dom-ready', fitTitlebar)
}

ApplicationMenu.setApplicationMenu(menu())
ApplicationMenu.on('application-menu-clicked', (event) => {
  const action = (event as { data?: { action?: string } }).data?.action
  if (action === 'reload') run('location.reload()')
  else if (action === 'devtools') win.webview.toggleDevTools()
  else if (action) run(shortcutScript(action))
})

Electrobun.events.on(`host-message-${win.webview.id}`, (event: { data?: { detail?: unknown } }) => {
  const request = parseRequest(event.data?.detail, secret)
  if (!request) return
  answer(request).then(
    (value) => run(replyScript(request.id, { ok: true, value })),
    (err: unknown) => run(replyScript(request.id, { ok: false, error: String(err) })),
  )
})

// Links that leave the app (target=_blank, window.open) open in the default browser, or in VS Code or Cursor for a
// chat's folder (Open in, in the chat list's menu).
Electrobun.events.on(`new-window-open-${win.webview.id}`, (event: { data?: { detail?: unknown } }) => {
  const detail = event.data?.detail
  const url = typeof detail === 'string' ? detail : (detail as { url?: unknown } | undefined)?.url
  if (typeof url === 'string' && /^(https?|mailto|vscode|cursor):/i.test(url)) Utils.openExternal(url)
})

async function answer(request: Request): Promise<unknown> {
  switch (request.method) {
    case 'pickFolder': {
      const [path] = await Utils.openFileDialog({
        // Electrobun's default "~/" is not expanded and opens in the app bundle.
        startingFolder: homedir(),
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      })
      return path || undefined
    }
    case 'reveal':
      return Utils.showItemInFolder(request.path)
    case 'notify':
      return Utils.showNotification({ title: request.title, body: request.body })
    case 'setBadge':
      return setDockBadge(badgeLabel(request.count))
    case 'computerControl':
      return computerControl(request.active)
  }
}

/**
 * While an agent drives the Mac, a see-through window over each display (the page's /overlay): a glow round the edge
 * and each agent's cursor, so it is plain the computer is in an agent's hands. Clicks pass through, and the windows
 * open without taking focus from the app the person is in. On macOS they cover the menu bar and every Space
 * (src/overlay-window.ts).
 */
let overlays: BrowserWindow[] = []
function showOverlays(on: boolean) {
  if (!on || !dashboard) {
    for (const w of overlays) w.close()
    overlays = []
    return
  }
  if (overlays.length) return
  for (const display of Screen.getAllDisplays()) {
    const w = new BrowserWindow({
      title: t.overlayTitle,
      url: overlayUrl(dashboard),
      frame: { ...display.bounds },
      titleBarStyle: 'hidden',
      transparent: true,
      passthrough: true,
      hidden: true,
    })
    if (!prepareOverlayWindow(w.ptr, w.webview.ptr)) {
      w.setAlwaysOnTop(true)
      w.setVisibleOnAllWorkspaces(true)
    }
    w.showInactive()
    overlays.push(w)
  }
}

/** The global Esc, held only while an agent controls the Mac: it tells the page to stop computer use. */
let stopKey: string | undefined
function computerControl(active: boolean): boolean {
  showOverlays(active)
  if (active && !stopKey)
    stopKey = COMPUTER_STOP_KEYS.find((key) =>
      GlobalShortcut.register(key, () => run(shortcutScript(DESKTOP_COMPUTER_STOP))),
    )
  else if (!active && stopKey) {
    GlobalShortcut.unregister(stopKey)
    stopKey = undefined
  }
  return stopKey !== undefined
}

// The server: the one already running for this home, or one the app starts and stops with itself.
const starting = new AbortController()
const serverReady: Promise<Server> = existing
  ? Promise.resolve(existing)
  : startServer({ ...serverCommand(), home, port: port ?? 0, signal: starting.signal })
let stopped = false

Electrobun.events.on('before-quit', (event: { response?: { allow: boolean } }) => {
  if (stopped) return
  // Quit waits for the server to stop its running chats, then asks again.
  event.response = { allow: false }
  starting.abort(new Error('quit'))
  void serverReady
    .then((server) => server.stop())
    .catch(() => {})
    .finally(() => {
      stopped = true
      Utils.quit()
    })
})

const loadingShown = new Promise<void>((resolve) => win.webview.on('dom-ready', () => resolve()))
serverReady.then(
  async (server) => {
    if (!server.owned) return
    await loadingShown
    dashboard = server.pageUrl
    win.webview.loadURL(server.pageUrl)
  },
  async (err: unknown) => {
    if (starting.signal.aborted) return
    await Utils.showMessageBox({
      type: 'error',
      title: t.errors.startTitle,
      message: t.errors.startTitle,
      detail: `${err instanceof Error ? err.message : String(err)}\n\n${t.errors.detail}`,
      buttons: [t.errors.ok],
    })
    stopped = true
    Utils.quit()
  },
)

/** The CLI to run `serve` with: the repository's source in development, the bundled executable in a built app. */
function serverCommand(): { command: string[]; cwd?: string } {
  if (BuildConfig.getSync().isPackaged)
    return { command: [join(PATHS.RESOURCES_FOLDER, 'app', 'sidecar', executableName('myrmidon', platform))] }
  // Set by electrobun.config.ts at build time. Run from the repository so its bunfig.toml builds the dashboard's CSS.
  const repo = process.env.MYRMIDON_DESKTOP_REPO
  if (!repo) throw new Error('MYRMIDON_DESKTOP_REPO is not set')
  return { command: [Bun.which('bun') ?? process.execPath, join(repo, 'apps/cli/src/main.ts')], cwd: repo }
}

function menu(): ApplicationMenuItemConfig[] {
  const m = t.menu
  return menuFor(platform, [
    {
      label: t.appName,
      submenu: [
        { label: m.about, role: 'about' },
        { type: 'separator' },
        { label: m.settings, action: 'mod+,', accelerator: 'CommandOrControl+,' },
        { type: 'separator' },
        { label: m.hide, role: 'hide' },
        { role: 'hideOthers' },
        { role: 'showAll' },
        { type: 'separator' },
        { label: m.quit, role: 'quit' },
      ],
    },
    {
      label: m.file,
      submenu: [
        { label: m.newChat, action: 'mod+n', accelerator: 'CommandOrControl+N' },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: m.edit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: m.view,
      submenu: [
        { label: m.commandMenu, action: 'mod+k', accelerator: 'CommandOrControl+K' },
        { label: m.toggleSidebar, action: 'mod+b', accelerator: 'CommandOrControl+B' },
        { type: 'separator' },
        { label: m.reload, action: 'reload', accelerator: 'CommandOrControl+R' },
        { label: m.developerTools, action: 'devtools', accelerator: 'CommandOrControl+Alt+I' },
        { type: 'separator' },
        { role: 'toggleFullScreen' },
      ],
    },
    {
      label: m.window,
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'bringAllToFront' }],
    },
  ]) as ApplicationMenuItemConfig[]
}

/** What the window shows until the server answers: the app's background and one line, draggable like a title bar. */
function loadingPage(): string {
  return `<!doctype html><meta charset="utf-8"><style>
  :root { color-scheme: light dark; font: 13px -apple-system, BlinkMacSystemFont, sans-serif }
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: Canvas; color: GrayText;
    -webkit-app-region: drag; app-region: drag; user-select: none; cursor: default }
</style><p>${t.starting}</p>`
}
