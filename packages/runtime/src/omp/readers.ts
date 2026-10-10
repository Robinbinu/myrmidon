/**
 * omp's readers for what agents open: images, documents, SQLite files, and where its page readers (yt-dlp,
 * trafilatura) are installed. Each loads on its first use, so a round that reads none of these never loads it.
 */
export const loadImageResize = () => import('@oh-my-pi/pi-coding-agent/utils/image-resize')
export const loadMarkit = () => import('@oh-my-pi/pi-coding-agent/markit')
export type Markit = InstanceType<Awaited<ReturnType<typeof loadMarkit>>['Markit']>
export const loadSqliteReader = () => import('@oh-my-pi/pi-coding-agent/tools/sqlite-reader')
export const loadToolsManager = () => import('@oh-my-pi/pi-coding-agent/utils/tools-manager')
