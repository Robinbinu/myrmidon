/**
 * The signals that stop `myrmidon serve` cleanly. Ctrl+C is SIGINT everywhere (on Windows the console's Ctrl+C event,
 * as Node maps it); systemd stops a service with SIGTERM. Windows adds Ctrl+Break (SIGBREAK) and closing the console
 * window (SIGHUP, after which Windows ends the process within seconds). Elsewhere SIGHUP keeps its default.
 */
export function shutdownSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM']
}
