/** omp's language-server client: its server defaults, the client itself, and the helpers that read its answers. */
export type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  LspClient,
  ServerConfig,
  SymbolInformation,
  WorkspaceEdit,
} from '@oh-my-pi/pi-coding-agent/lsp/types'

/**
 * Loaded on the first lsp call, never at startup: omp's config discovery comes with them and must not run before omp
 * has been pointed at Myrmidon's folder.
 */
export async function loadLsp() {
  const [config, client, diagnostics, edits, utils] = await Promise.all([
    import('@oh-my-pi/pi-coding-agent/lsp/config'),
    import('@oh-my-pi/pi-coding-agent/lsp/client'),
    import('@oh-my-pi/pi-coding-agent/lsp/diagnostics'),
    import('@oh-my-pi/pi-coding-agent/lsp/edits'),
    import('@oh-my-pi/pi-coding-agent/lsp/utils'),
  ])
  return { config, client, diagnostics, edits, utils }
}
export type Lsp = Awaited<ReturnType<typeof loadLsp>>
