/** omp's small helpers (pi-utils): frontmatter, binary sniffing, image headers, its folders, archives. */
export { getLogsDir } from '@oh-my-pi/pi-utils'
export { BINARY_SNIFF_BYTES } from '@oh-my-pi/pi-utils/binary'
export { parseFrontmatter } from '@oh-my-pi/pi-utils/frontmatter'
export { parseImageMetadata } from '@oh-my-pi/pi-utils/mime'

/** omp's zip and tar reader and writer, loaded on the first archive read. */
export const loadArchives = () => import('@oh-my-pi/pi-utils/ar')
