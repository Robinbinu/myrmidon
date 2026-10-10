/**
 * Encrypted share files. A chat's HTML export is sealed in this page with a fresh random key and wrapped in a page that
 * opens itself: the file holds only ciphertext, the key is shown to the person once, and the reader's browser decrypts
 * it. Myrmidon has no public place to host a share (its preview origin and public address need this machine's own
 * keys), so nothing is uploaded: the person sends the file, and the key by another way.
 *
 * Ported from omp's session sharing (pi-coding-agent export/share.ts and export/html/share-loader.js): the same sealed
 * layout `[12-byte IV][AES-256-GCM(gzip(payload))]`, a 32-byte key written base64url, read from the address's
 * `#fragment` (which browsers never send anywhere) and decrypted in the reader's browser. omp uploads the blob to its
 * share server; here the blob travels inside the file instead.
 */

/** AES-256: the key's length, and GCM's 12-byte IV, as omp seals. */
const KEY_BYTES = 32
const IV_BYTES = 12

function base64(bytes: Uint8Array): string {
  let binary = ''
  // String.fromCharCode takes its bytes as arguments; a whole export at once would overflow the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const base64url = (bytes: Uint8Array) =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Seals `html` with a new key: the sealed bytes as base64, and the key as base64url to hand the person. */
export async function sealHtml(html: string): Promise<{ sealed: string; key: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const compressed = await new Response(
    new Blob([html]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer()
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed))
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength)
  out.set(iv, 0)
  out.set(ciphertext, IV_BYTES)
  return { sealed: base64(out), key: base64url(keyBytes) }
}

/**
 * The share file's decryption, as the source it carries: plain JavaScript with nothing from outside it, since it runs
 * in the reader's browser without Myrmidon. Fails with `key` for a wrong, short or malformed key (GCM's tag check
 * catches a wrong one), `sealed` for a damaged file. Kept as source so the tests run exactly what the file runs.
 */
export const UNSEAL_SOURCE = `async function unseal(sealedText, keyText) {
  function bytes(b64, code) {
    try {
      var binary = atob(b64);
    } catch (_err) {
      throw new Error(code);
    }
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  var b64 = keyText.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  var keyBytes = bytes(b64, 'key');
  if (keyBytes.length !== ${KEY_BYTES}) throw new Error('key');
  var sealed = bytes(sealedText.replace(/\\s+/g, ''), 'sealed');
  if (sealed.length <= ${IV_BYTES}) throw new Error('sealed');
  var key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  var plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, ${IV_BYTES}) }, key, sealed.subarray(${IV_BYTES}));
  } catch (_err) {
    throw new Error('key');
  }
  return await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}`

/** What the share file says before it is opened: it is read by someone who may not know Myrmidon. */
export interface ShareFileText {
  readonly title: string
  readonly body: string
  readonly keyLabel: string
  readonly open: string
  readonly errors: { readonly key: string; readonly sealed: string; readonly browser: string }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
/** JSON inside a <script>: `<` escaped, so no text can close the script early. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

/**
 * The share file: the sealed chat, and a page that asks for the key (or takes it from `#key` in its address) and puts
 * the decrypted page in its place. The chat's title is not in it: until it is opened the file says nothing of what it
 * holds. Its policy allows only its own script, inline styles and data: pictures, so neither the loader nor the chat
 * can reach the network; the chat page is parsed, not run, and carries a stricter policy of its own.
 */
export function shareFile(sealed: string, text: ShareFileText): string {
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(text.title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}form{background:#2c2c2e!important}input{background:#1c1c1e!important;color:inherit}}form{width:min(420px,calc(100% - 32px));background:#fff;border-radius:14px;padding:24px;box-shadow:0 8px 30px rgb(0 0 0/.12)}h1{margin:0 0 8px;font-size:20px}p{margin:0 0 16px;opacity:.8}label{display:block;font-size:13px;font-weight:600;margin-bottom:4px}input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid rgb(128 128 128/.4);border-radius:8px;font:13px ui-monospace,Menlo,monospace}button{margin-top:12px;padding:8px 16px;border:0;border-radius:8px;background:#ffb31a;color:#1a1204;font-weight:600;cursor:pointer}output{display:block;margin-top:10px;color:#d70015;font-size:13px}</style>
</head><body>
<form id="unlock"><h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.body)}</p>
<label for="key">${escapeHtml(text.keyLabel)}</label><input id="key" autocomplete="off" spellcheck="false" autofocus>
<button type="submit">${escapeHtml(text.open)}</button><output id="error" aria-live="polite"></output></form>
<script type="application/octet-stream" id="sealed">${sealed}</script>
<script>
${UNSEAL_SOURCE}
(function () {
  var errors = ${scriptJson(text.errors)};
  var error = document.getElementById('error');
  async function open(keyText) {
    error.textContent = '';
    try {
      if (!window.crypto || !crypto.subtle || typeof DecompressionStream === 'undefined') throw new Error('browser');
      var html = await unseal(document.getElementById('sealed').textContent, keyText);
      var page = new DOMParser().parseFromString(html, 'text/html');
      document.replaceChild(document.adoptNode(page.documentElement), document.documentElement);
    } catch (err) {
      error.textContent = errors[err && err.message] || errors.key;
    }
  }
  var fromAddress = location.hash.slice(1);
  if (fromAddress) {
    // Out of the address bar once read, so it is not left on screen or in a copied address.
    history.replaceState(null, '', location.pathname + location.search);
    open(fromAddress);
  }
  document.getElementById('unlock').addEventListener('submit', function (e) {
    e.preventDefault();
    open(document.getElementById('key').value);
  });
})();
</script>
</body></html>
`
}
