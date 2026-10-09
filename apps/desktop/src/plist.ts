const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An XML Info.plist with `key` set to the string `value` in its top-level dict, replacing a value already there. */
export function setPlistString(plist: string, key: string, value: string): string {
  const k = escapeXml(key)
  const v = escapeXml(value)
  const existing = new RegExp(`(<key>${escapeRegExp(k)}</key>\\s*<string>)[\\s\\S]*?(</string>)`)
  if (existing.test(plist))
    return plist.replace(existing, (_, open: string, close: string) => `${open}${v}${close}`)
  const end = plist.lastIndexOf('</dict>')
  if (end < 0) throw new Error('Info.plist has no top-level dict')
  return `${plist.slice(0, end)}    <key>${k}</key>\n    <string>${v}</string>\n${plist.slice(end)}`
}
