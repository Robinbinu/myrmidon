/** omp's SSH helpers: host-name checks, connection sharing, targets and POSIX quoting. */
export { validateHostName } from '@oh-my-pi/pi-coding-agent/ssh/config-writer'
export {
  resolveSshControlDir,
  supportsSshControlMaster,
} from '@oh-my-pi/pi-coding-agent/ssh/connection-manager'
export { buildSshTarget, wrapInPosixShell } from '@oh-my-pi/pi-coding-agent/ssh/utils'
export { assertOwnerPrivateDir } from '@oh-my-pi/pi-coding-agent/utils/owner-private-dir'
export { quotePosixArgument } from '@oh-my-pi/pi-coding-agent/utils/shell-quote'
