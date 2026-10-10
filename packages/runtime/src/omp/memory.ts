/** omp's memory helpers: secret redaction before a memory is kept, and hindsight's content checks and clock. */
export {
  formatCurrentTime,
  hasSubstantiveContent,
  stripMemoryTags,
} from '@oh-my-pi/pi-coding-agent/hindsight/content'
export { redactMemorySecrets } from '@oh-my-pi/pi-coding-agent/memory-backend/redact'
