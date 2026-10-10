/** A link that opens a folder in an editor that registers `scheme` (vscode, cursor), on macOS, Windows or Linux. */
export function editorLink(scheme: string, path: string): string {
  const forward = path.replaceAll('\\', '/')
  return `${scheme}://file${forward.startsWith('/') ? '' : '/'}${encodeURI(forward)}`
}
