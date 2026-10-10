import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { setDockBadge } from '../src/dock.ts'
import {
  appBundle,
  executableName,
  type MenuItem,
  menuFor,
  onnxRuntimeLibraries,
  platformOf,
  sidecarDist,
  sidecarFiles,
  sidecarTarget,
  titlebarInset,
  windowChrome,
} from '../src/platform.ts'

test('the sidecar is myrmidon.exe on Windows and myrmidon elsewhere', () => {
  expect(executableName('myrmidon', 'win32')).toBe('myrmidon.exe')
  expect(executableName('myrmidon', 'linux')).toBe('myrmidon')
  expect(executableName('myrmidon', 'darwin')).toBe('myrmidon')
})

test('only macOS hides its title bar and insets the toolbar for the traffic lights', () => {
  expect(windowChrome('darwin')).toEqual({
    titleBarStyle: 'hiddenInset',
    buttons: { x: 20, y: 19 },
    titlebarInsetPx: 78,
  })
  for (const platform of ['linux', 'win32'] as const)
    expect(windowChrome(platform)).toEqual({ titleBarStyle: 'default', titlebarInsetPx: 0 })
})

test('full screen hides the traffic lights, so the toolbar keeps no room for them there', () => {
  const mac = windowChrome('darwin')
  expect(titlebarInset(mac, false)).toBe(78)
  expect(titlebarInset(mac, true)).toBe(0)
  expect(titlebarInset(windowChrome('win32'), false)).toBe(0)
})

test('the menu keeps macOS-only roles on macOS and drops them, and the separators they leave, elsewhere', () => {
  const menu: MenuItem[] = [
    {
      label: 'Myrmidon',
      submenu: [
        { label: 'About', role: 'about' },
        { type: 'separator' },
        { label: 'Hide', role: 'hide' },
        { role: 'hideOthers' },
        { role: 'showAll' },
        { type: 'separator' },
        { label: 'Quit', role: 'quit' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { type: 'separator' }, { role: 'bringAllToFront' }] },
  ]
  expect(menuFor('darwin', menu)).toEqual(menu)
  for (const platform of ['linux', 'win32'] as const)
    expect(menuFor(platform, menu)).toEqual([
      {
        label: 'Myrmidon',
        submenu: [{ label: 'About', role: 'about' }, { type: 'separator' }, { label: 'Quit', role: 'quit' }],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }] },
    ])
})

test('a sidecar target is the host’s by default, or one Bun can compile for', () => {
  expect(sidecarTarget(undefined, { platform: 'darwin', arch: 'arm64' })).toEqual({
    platform: 'darwin',
    arch: 'arm64',
    bun: 'bun-darwin-arm64',
  })
  expect(sidecarTarget(undefined, { platform: 'win32', arch: 'x64' }).bun).toBe('bun-windows-x64')
  expect(sidecarTarget('bun-windows-x64', { platform: 'darwin', arch: 'arm64' })).toEqual({
    platform: 'win32',
    arch: 'x64',
    bun: 'bun-windows-x64',
  })
  expect(sidecarTarget('bun-linux-arm64', { platform: 'darwin', arch: 'arm64' })).toMatchObject({
    platform: 'linux',
    arch: 'arm64',
  })
  expect(() => sidecarTarget('bun-freebsd-x64', { platform: 'darwin', arch: 'arm64' })).toThrow(
    'unknown target',
  )
  expect(() => sidecarTarget(undefined, { platform: 'freebsd', arch: 'x64' })).toThrow('freebsd')
  expect(sidecarDist('/d', 'win32', 'x64')).toBe(join('/d', 'dist', 'win32-x64'))
})

test('the onnxruntime libraries copied beside the addon are the ones each platform loads', () => {
  const darwin = ['libonnxruntime.1.30.0.dylib', 'libonnxruntime.1.dylib', 'onnxruntime_binding.node']
  expect(onnxRuntimeLibraries('darwin', darwin)).toEqual(['libonnxruntime.1.dylib'])
  expect(onnxRuntimeLibraries('linux', ['libonnxruntime.so.1', 'onnxruntime_binding.node'])).toEqual([
    'libonnxruntime.so.1',
  ])
  const win = ['dxil.dll', 'DirectML.dll', 'dxcompiler.dll', 'onnxruntime.dll', 'onnxruntime_binding.node']
  expect(onnxRuntimeLibraries('win32', win)).toEqual([
    'dxil.dll',
    'DirectML.dll',
    'dxcompiler.dll',
    'onnxruntime.dll',
  ])
})

test('the app ships the executable and every native library beside it, on each platform', () => {
  const dist = [
    'myrmidon',
    'myrmidon.exe',
    'pi_natives.linux-x64-modern.node',
    'onnxruntime_binding.node',
    'libonnxruntime.1.dylib',
    'libonnxruntime.so.1',
    'onnxruntime.dll',
    'notes.txt',
  ]
  const native = dist.filter((n) => n !== 'myrmidon' && n !== 'myrmidon.exe' && n !== 'notes.txt')
  expect(sidecarFiles('darwin', dist)).toEqual(['myrmidon', ...native])
  expect(sidecarFiles('linux', dist)).toEqual(['myrmidon', ...native])
  expect(sidecarFiles('win32', dist)).toEqual(['myrmidon.exe', ...native])
})

test('Resources is inside Contents in a macOS bundle and beside bin on Linux and Windows', () => {
  const mac = appBundle('macos', 'Myrmidon', 'stable')
  expect(mac.name).toBe('Myrmidon.app')
  expect(mac.resources('/b/Myrmidon.app')).toBe(join('/b/Myrmidon.app', 'Contents', 'Resources'))
  expect(appBundle('macos', 'My App', 'dev').name).toBe('My App-dev.app')
  for (const os of ['linux', 'win'] as const) {
    const bundle = appBundle(os, 'My App', 'canary')
    expect(bundle.name).toBe('MyApp-canary')
    expect(bundle.resources('/b/MyApp-canary')).toBe(join('/b/MyApp-canary', 'Resources'))
  }
  expect(platformOf('win')).toBe('win32')
  expect(platformOf('macos')).toBe('darwin')
  expect(() => platformOf('beos')).toThrow('beos')
})

test('the Dock badge is a no-op without a Dock, and loads nothing macOS-only to be one', () => {
  expect(setDockBadge('3', 'linux')).toBeUndefined()
  expect(setDockBadge(undefined, 'win32')).toBeUndefined()
})
