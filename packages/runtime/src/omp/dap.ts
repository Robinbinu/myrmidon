/** omp's Debug Adapter Protocol client and adapter config, behind the debug tool. */
export type { DapClient } from '@oh-my-pi/pi-coding-agent/dap/client'
export type {
  DapBreakpoint,
  DapCapabilities,
  DapEvaluateResponse,
  DapExitedEventBody,
  DapInitializeArguments,
  DapOutputEventBody,
  DapResolvedAdapter,
  DapScope,
  DapStackFrame,
  DapStartDebuggingArguments,
  DapStoppedEventBody,
  DapThread,
  DapVariable,
} from '@oh-my-pi/pi-coding-agent/dap/types'

/**
 * Loaded on the first debug call: the adapter config reads omp's config folders, which must not load before omp has
 * been pointed at Myrmidon's folder.
 */
export async function loadDap() {
  const [client, config] = await Promise.all([
    import('@oh-my-pi/pi-coding-agent/dap/client'),
    import('@oh-my-pi/pi-coding-agent/dap/config'),
  ])
  return { client, config }
}
export type Dap = Awaited<ReturnType<typeof loadDap>>
