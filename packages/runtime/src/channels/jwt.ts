/**
 * RS256 JSON Web Tokens with Web Crypto (no library): checking the tokens Microsoft and Google sign their webhooks
 * with, against their published keys (JWKS), and signing the assertion a Google service account trades for an
 * access token.
 */

/** A public key from a JWKS; Bot Framework's carry the channels they may sign for (`endorsements`). */
export interface Jwk {
  readonly kid?: string
  readonly kty: string
  readonly n?: string
  readonly e?: string
  readonly endorsements?: readonly string[]
}

export interface JwtClaims {
  readonly iss?: string
  readonly aud?: string | readonly string[]
  readonly exp?: number
  readonly nbf?: number
  readonly iat?: number
  readonly [claim: string]: unknown
}

/** Why a token was refused; never carries the token. */
export class JwtError extends Error {}

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const
/** Clocks may differ by this much (Bot Framework allows 5 minutes). */
const SKEW_S = 300
/** A key id not in the cached set is looked up again at most this often (keys rotate rarely). */
const REFETCH_MS = 5 * 60_000

const json = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/** The public keys at a JWKS address (found lazily, e.g. from OpenID metadata), cached for `ttlMs`. */
export class KeySet {
  private _keys = new Map<string, { jwk: Jwk; key: CryptoKey }>()
  private _at = 0
  private _loading?: Promise<void>

  constructor(
    private readonly url: () => Promise<string>,
    private readonly ttlMs: number,
  ) {}

  async get(kid: string): Promise<{ jwk: Jwk; key: CryptoKey } | undefined> {
    const age = Date.now() - this._at
    const known = this._keys.get(kid)
    if (known && age < this.ttlMs) return known
    if (age >= this.ttlMs || age >= REFETCH_MS) {
      this._loading ??= this._load().finally(() => {
        this._loading = undefined
      })
      try {
        await this._loading
      } catch (err) {
        // Keys already known still verify while the address is unreachable.
        if (!known) throw err
      }
    }
    return this._keys.get(kid)
  }

  private async _load() {
    const res = await fetch(await this.url(), { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new JwtError(`signing keys answered ${res.status}`)
    const { keys } = (await res.json()) as { keys?: Jwk[] }
    const loaded = new Map<string, { jwk: Jwk; key: CryptoKey }>()
    for (const jwk of keys ?? []) {
      if (jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue
      // Only the key itself: other members (`use`, `alg`, x5c…) are not Web Crypto's to judge.
      const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, RS256, false, [
        'verify',
      ])
      loaded.set(jwk.kid, { jwk, key })
    }
    this._keys = loaded
    this._at = Date.now()
  }
}

/** A JWKS address read from OpenID metadata (`jwks_uri`), remembered once found. */
export function jwksFromMetadata(metadataUrl: string): () => Promise<string> {
  let found: string | undefined
  return async () => {
    if (found) return found
    const res = await fetch(metadataUrl, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new JwtError(`OpenID metadata answered ${res.status}`)
    const { jwks_uri } = (await res.json()) as { jwks_uri?: string }
    if (!jwks_uri) throw new JwtError('OpenID metadata has no jwks_uri')
    found = jwks_uri
    return found
  }
}

/**
 * Checks an RS256 token's signature against the key set, then its issuer, audience and lifetime; returns its claims
 * and the key that signed it. Throws `JwtError` with the reason.
 */
export async function verifyJwt(
  token: string,
  keys: KeySet,
  expect: { readonly issuers: readonly string[]; readonly audience: string },
): Promise<{ claims: JwtClaims; jwk: Jwk }> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('not a JWT')
  const [head = '', body = '', sig = ''] = parts
  let header: { alg?: string; kid?: string }
  let claims: JwtClaims
  try {
    header = json(head) as typeof header
    claims = json(body) as JwtClaims
  } catch {
    throw new JwtError('unreadable JWT')
  }
  // The algorithm is fixed here, never taken from the token (no `none`, no HMAC with a public key).
  if (header.alg !== 'RS256') throw new JwtError(`unexpected algorithm ${header.alg}`)
  if (!header.kid) throw new JwtError('no key id')
  const found = await keys.get(header.kid)
  if (!found) throw new JwtError('unknown signing key')
  const ok = await crypto.subtle.verify(
    RS256,
    found.key,
    Buffer.from(sig, 'base64url'),
    new TextEncoder().encode(`${head}.${body}`),
  )
  if (!ok) throw new JwtError('bad signature')
  const now = Date.now() / 1000
  if (typeof claims.exp !== 'number' || claims.exp < now - SKEW_S) throw new JwtError('expired')
  if (typeof claims.nbf === 'number' && claims.nbf > now + SKEW_S) throw new JwtError('not valid yet')
  if (!claims.iss || !expect.issuers.includes(claims.iss))
    throw new JwtError(`unexpected issuer ${claims.iss}`)
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(expect.audience)) throw new JwtError('unexpected audience')
  return { claims, jwk: found.jwk }
}

/** Signs claims with an RSA private key in PEM (PKCS #8, as Google's service account keys are). */
export async function signJwt(claims: JwtClaims, pem: string, kid?: string): Promise<string> {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
  const key = await crypto.subtle.importKey('pkcs8', der, RS256, false, ['sign'])
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const input = `${encode({ alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) })}.${encode(claims)}`
  const sig = await crypto.subtle.sign(RS256, key, new TextEncoder().encode(input))
  return `${input}.${Buffer.from(sig).toString('base64url')}`
}
