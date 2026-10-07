/**
 * Small local websites for the browser evals. Each is deterministic, so a score changes only when Myrmidon does,
 * and each needs real browsing: search and pages, a form, a table.
 */

const page = (title: string, body: string) =>
  new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

const PRODUCTS = [
  { sku: 'LMP-204', name: 'Arc floor lamp', kind: 'lamp', price: 89 },
  { sku: 'DSK-118', name: 'Oak desk', kind: 'desk', price: 240 },
  { sku: 'LMP-377', name: 'Brass desk lamp', kind: 'lamp', price: 54 },
  { sku: 'CHR-510', name: 'Mesh chair', kind: 'chair', price: 130 },
  { sku: 'LMP-912', name: 'Paper pendant lamp', kind: 'lamp', price: 29 },
  { sku: 'SHF-033', name: 'Wall shelf', kind: 'shelf', price: 45 },
  { sku: 'LMP-450', name: 'Clip-on reading lamp', kind: 'lamp', price: 35 },
]

/** A shop: search with paged results (two per page); the SKU is only on each product's own page. */
export function shopSite(request: Request): Response {
  const url = new URL(request.url)
  if (url.pathname.startsWith('/product/')) {
    const p = PRODUCTS.find((x) => x.sku === url.pathname.slice(9))
    if (!p) return new Response('Not found', { status: 404 })
    return page(p.name, `<h1>${p.name}</h1><p class="price">$${p.price}</p><p>SKU: <code>${p.sku}</code></p>`)
  }
  if (url.pathname === '/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const at = Math.max(1, Number(url.searchParams.get('page')) || 1)
    const hits = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q) || p.kind === q)
    const shown = hits.slice((at - 1) * 2, at * 2)
    const next =
      at * 2 < hits.length ? `<a href="/search?q=${encodeURIComponent(q)}&page=${at + 1}">Next page</a>` : ''
    return page(
      `Search: ${q}`,
      `<h1>${hits.length} results for “${q}”</h1>${shown
        .map(
          (p) =>
            `<div class="result"><a href="/product/${p.sku}">${p.name}</a> <span>$${p.price}</span></div>`,
        )
        .join('')}${next}`,
    )
  }
  return page(
    'Shop',
    `<h1>Furniture shop</h1><form action="/search"><input name="q" aria-label="Search products"><button>Search</button></form>`,
  )
}

/** A contact form; the confirmation code depends on what was sent, so it cannot be guessed. */
export function formSite(request: Request): Response {
  const url = new URL(request.url)
  if (url.pathname === '/sent') {
    const name = url.searchParams.get('name') ?? ''
    const email = url.searchParams.get('email') ?? ''
    const topic = url.searchParams.get('topic') ?? ''
    if (!name || !email.includes('@') || !topic)
      return page('Missing fields', '<p class="error">Please fill in every field.</p><a href="/">Back</a>')
    return page(
      'Thank you',
      `<h1>Thanks, ${name}!</h1><p>Confirmation code: <strong>${confirmation(name, email, topic)}</strong></p>`,
    )
  }
  return page(
    'Contact',
    `<h1>Contact us</h1><form action="/sent">
      <label>Name <input name="name"></label>
      <label>Email <input name="email" type="email"></label>
      <label>Topic <select name="topic"><option value="">Choose…</option><option>Sales</option><option>Support</option></select></label>
      <button>Send</button></form>`,
  )
}

export function confirmation(name: string, email: string, topic: string): string {
  return `C-${Bun.hash(`${name.trim().toLowerCase()}|${email.trim().toLowerCase()}|${topic}`).toString(36).slice(0, 6).toUpperCase()}`
}

/** A report page with a table; the answer needs reading the right row and column. */
export function tableSite(): Response {
  const rows = [
    ['Norway', 410, 455],
    ['Chile', 380, 512],
    ['Kenya', 290, 330],
    ['Japan', 505, 498],
  ]
  return page(
    'Revenue report',
    `<h1>Regional revenue (k$)</h1><table><tr><th>Country</th><th>2024</th><th>2025</th></tr>${rows
      .map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`)
      .join('')}</table>`,
  )
}
