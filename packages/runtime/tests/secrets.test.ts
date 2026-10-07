import { expect, test } from 'bun:test'
import { redactDeep, redactSecrets } from '../src/secrets.ts'

test('known key formats, .env-style assignments and private keys are redacted', () => {
  const env = [
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ12',
    'DATABASE_PASSWORD="hunter2hunter2"',
    'PORT=3000',
  ].join('\n')
  const out = redactSecrets(env)
  expect(out).not.toContain('sk-proj-abcdef')
  expect(out).not.toContain('ghp_abcdef')
  expect(out).not.toContain('hunter2hunter2')
  expect(out).toContain('PORT=3000')
  expect(out).toContain('OPENAI_API_KEY=')

  expect(redactSecrets('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123"')).toBe(
    'curl -H "Authorization: Bearer [bearer token redacted]"',
  )
  expect(redactSecrets('{"apiKey": "AIzaSyA1234567890abcdefghijklmnopqrstuv"}')).not.toContain('AIzaSy')
  expect(
    redactSecrets(
      'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nok',
    ),
  ).toBe('key:\n[private key redacted]\nok')
  expect(redactSecrets('AKIAIOSFODNN7EXAMPLE is the id')).toBe('[aws key redacted] is the id')
})

test('ordinary text, ids and hashes are left alone', () => {
  const plain =
    'task-12345678901234567890 done; blob 0d42cc2b9ef5b4c050badc62fddbea690b5358d649a187047d4059b12a15a622; token count 1200'
  expect(redactSecrets(plain)).toBe(plain)
  expect(redactSecrets('The password field must be at least 8 characters.')).toBe(
    'The password field must be at least 8 characters.',
  )
})

test('every string in a payload is redacted, other values kept', () => {
  expect(
    redactDeep({
      tool: 'fs_read',
      ok: true,
      output: 'STRIPE_SECRET=sk_live_abcdefghijklmnop1234',
      n: 3,
      list: ['xoxb-1234567890-abc'],
    }),
  ).toEqual({
    tool: 'fs_read',
    ok: true,
    output: 'STRIPE_SECRET=[stripe key redacted]',
    n: 3,
    list: ['[slack token redacted]'],
  })
})
