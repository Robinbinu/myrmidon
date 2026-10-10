/**
 * What differs between macOS, Linux and Windows for the desktop shell and its build, as pure functions of the
 * platform (and architecture), so each one is tested on any machine.
 */
import { join } from 'node:path'
import { TITLEBAR_INSET_PX, WINDOW_BUTTONS } from './config.ts'

/** The platforms the app is built for, as `process.platform` names them. */
export type Platform = 'darwin' | 'linux' | 'win32'
export type Arch = 'x64' | 'arm64'

/** The operating system as Electrobun's build names it (`ELECTROBUN_OS`, the build folder `stable-<os>-<arch>`). */
export type ElectrobunOs = 'macos' | 'linux' | 'win'

export function asPlatform(value: string): Platform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`Myrmidon's desktop app does not support the platform ${value}`)
}

export function asArch(value: string): Arch {
  if (value === 'x64' || value === 'arm64') return value
  throw new Error(`Myrmidon's desktop app does not support the architecture ${value}`)
}

export function platformOf(os: string): Platform {
  if (os === 'macos') return 'darwin'
  if (os === 'win') return 'win32'
  if (os === 'linux') return 'linux'
  throw new Error(`unknown ELECTROBUN_OS ${os}`)
}

/** An executable's file name: Windows runs only files that end in `.exe`. */
export const executableName = (name: string, platform: Platform) =>
  platform === 'win32' ? `${name}.exe` : name

/**
 * The window's title bar. On macOS it is hidden and inset, with the traffic lights moved into the client's toolbar
 * row and the toolbar leaving room for them. Linux and Windows draw their window buttons on the right, in a title bar
 * the window manager owns, so there the frame is the normal one and the page needs no inset.
 */
export function windowChrome(platform: Platform): {
  titleBarStyle: 'hiddenInset' | 'default'
  buttons?: { x: number; y: number }
  titlebarInsetPx: number
} {
  return platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', buttons: { ...WINDOW_BUTTONS }, titlebarInsetPx: TITLEBAR_INSET_PX }
    : { titleBarStyle: 'default', titlebarInsetPx: 0 }
}

/** The toolbar's room for the window buttons now: none in full screen, where macOS hides the traffic lights. */
export const titlebarInset = (chrome: { titlebarInsetPx: number }, fullScreen: boolean): number =>
  fullScreen ? 0 : chrome.titlebarInsetPx

/** Menu roles only AppKit has (hiding apps, bringing all windows forward); elsewhere they would be dead items. */
const MAC_ONLY_ROLES = new Set(['hide', 'hideOthers', 'showAll', 'bringAllToFront'])

/** A menu item as Electrobun's ApplicationMenu takes it, as far as the platform filter needs to know. */
export type MenuItem =
  | { type: 'separator' }
  | {
      type?: 'normal'
      label?: string
      role?: string
      action?: string
      accelerator?: string
      submenu?: MenuItem[]
    }

/** The menu without what the platform lacks, and without a separator left first, last or doubled by that. */
export function menuFor(platform: Platform, items: readonly MenuItem[]): MenuItem[] {
  const kept = items.flatMap((item): MenuItem[] => {
    if (item.type === 'separator') return [item]
    if (platform !== 'darwin' && item.role && MAC_ONLY_ROLES.has(item.role)) return []
    return [item.submenu ? { ...item, submenu: menuFor(platform, item.submenu) } : item]
  })
  return kept.filter(
    (item, i) =>
      item.type !== 'separator' || (i > 0 && i < kept.length - 1 && kept[i + 1]?.type !== 'separator'),
  )
}

/** A target for the compiled server: Bun's `--target` name and the platform it runs on. */
export interface SidecarTarget {
  readonly platform: Platform
  readonly arch: Arch
  /** Bun's compile target, e.g. `bun-windows-x64`. */
  readonly bun: Bun.Build.CompileTarget
}

/** The targets Bun can compile the server for from any host. */
export const SIDECAR_TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-x64',
  'bun-windows-arm64',
] as const satisfies readonly Bun.Build.CompileTarget[]

/** The target named by `--target=…`, or the host's when none is given. */
export function sidecarTarget(
  name: string | undefined,
  host: { platform: string; arch: string },
): SidecarTarget {
  if (name === undefined) {
    const platform = asPlatform(host.platform)
    const arch = asArch(host.arch)
    const os = platform === 'win32' ? 'windows' : platform
    return { platform, arch, bun: `bun-${os}-${arch}` }
  }
  const known = SIDECAR_TARGETS.find((t) => t === name)
  if (!known) throw new Error(`unknown target ${name}; one of ${SIDECAR_TARGETS.join(', ')}`)
  const [, os = '', arch = ''] = known.split('-')
  return { platform: asPlatform(os === 'windows' ? 'win32' : os), arch: asArch(arch), bun: known }
}

/** Where `desktop:sidecar` puts a target's build, and the build hook looks for it: `dist/<platform>-<arch>`. */
export const sidecarDist = (desktopDir: string, platform: Platform, arch: Arch) =>
  join(desktopDir, 'dist', `${platform}-${arch}`)

/**
 * onnxruntime's shared libraries, of the files beside its addon in onnxruntime-node, that the addon loads: the one
 * versioned name it links to on macOS and Linux, and every DLL on Windows (onnxruntime.dll and the DirectML
 * libraries it loads). Windows finds a DLL beside the executable; macOS and Linux beside the addon (@loader_path,
 * $ORIGIN), which is the same folder once both are copied there.
 */
export function onnxRuntimeLibraries(platform: Platform, files: readonly string[]): string[] {
  if (platform === 'win32') return files.filter((name) => /\.dll$/i.test(name))
  const wanted = platform === 'darwin' ? 'libonnxruntime.1.dylib' : 'libonnxruntime.so.1'
  return files.filter((name) => name === wanted)
}

/** Of a sidecar build folder, what the app ships: the executable and the native code it loads from beside itself. */
export function sidecarFiles(platform: Platform, files: readonly string[]): string[] {
  const executable = executableName('myrmidon', platform)
  return files.filter((name) => name === executable || /\.(node|dylib|dll|so(\.\d+)*)$/i.test(name))
}

/**
 * The app bundle Electrobun builds in its build folder, and its Resources folder, where the app finds what it ships
 * (Electrobun's PATHS.RESOURCES_FOLDER is `../Resources` from the launcher's folder): `Myrmidon.app/Contents/Resources`
 * on macOS, `Myrmidon/Resources` beside `Myrmidon/bin` on Linux and Windows. A channel other than stable is in the
 * name (`Myrmidon-canary`); Electrobun drops spaces from it except in a macOS bundle's.
 */
export function appBundle(
  os: ElectrobunOs,
  appName: string,
  channel: string,
): { name: string; resources: (bundle: string) => string } {
  const suffix = channel === 'stable' ? '' : `-${channel}`
  return os === 'macos'
    ? { name: `${appName}${suffix}.app`, resources: (bundle) => join(bundle, 'Contents', 'Resources') }
    : { name: `${appName.replace(/ /g, '')}${suffix}`, resources: (bundle) => join(bundle, 'Resources') }
}
