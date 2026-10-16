import { isAbsolute, relative } from 'node:path'

/**
 * Models kept for one project path (Settings → Models & providers): a model scoped to a folder is used only by chats
 * whose project is that folder or inside it, so a work account's model never answers a personal chat. omp scopes
 * models per project through each project's own settings; here the person sets it in one place.
 */

/** The folder `ref` is kept for, when `project` (a chat's project path, if any) is not inside it; else undefined. */
export function scopedOut(
  scopes: Readonly<Record<string, string>>,
  ref: string,
  project: string | undefined,
): string | undefined {
  const folder = scopes[ref]?.trim()
  if (!folder) return undefined
  if (!project) return folder
  const rel = relative(folder, project)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? undefined : folder
}
