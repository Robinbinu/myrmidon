/** omp's computer-use supervisor and the protocol its desktop bridge answers in. */
export type {
  ComputerRunOk,
  ComputerSessionSnapshot,
} from '@oh-my-pi/pi-coding-agent/tools/computer/protocol'
export type {
  ComputerController,
  ComputerWorkerHandle,
} from '@oh-my-pi/pi-coding-agent/tools/computer/supervisor'

/** Loaded on first use, so people who drive the desktop through Cua Driver never load it. */
export const loadComputerSupervisor = () => import('@oh-my-pi/pi-coding-agent/tools/computer/supervisor')
