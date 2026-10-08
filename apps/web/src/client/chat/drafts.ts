// What was typed in the message box but not sent, per chat, so a refresh or a crash doesn't throw it away. Only text:
// a browser can't hand back attached files after a reload.

const PREFIX = 'myr-draft:'

export function readDraft(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? ''
  } catch {
    return ''
  }
}

/** Keeps the text, or forgets the draft once the box is empty (sent or cleared). */
export function saveDraft(key: string, text: string) {
  try {
    if (text) localStorage.setItem(PREFIX + key, text)
    else localStorage.removeItem(PREFIX + key)
  } catch {
    // Private browsing or a full store: the draft just isn't kept, as before.
  }
}

export function forgetDraft(key: string) {
  saveDraft(key, '')
}
