import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderHttpError, isProviderContextOverflowError } from '../dist/providers/errors.js'

test('provider context overflow classifier recognizes common 400/413/422 context-limit responses', () => {
  const cases = [
    new ProviderHttpError(400, '{"error":{"code":"context_length_exceeded","message":"maximum context length is 200000 tokens"}}'),
    new ProviderHttpError(413, 'Request entity too large: prompt is too long for this model'),
    new ProviderHttpError(422, 'prompt_too_long: input exceeds model context window'),
  ]
  for (const error of cases) assert.equal(isProviderContextOverflowError(error), true)
})

test('provider context overflow classifier rejects unrelated errors and ambiguous status codes', () => {
  const cases = [
    new ProviderHttpError(400, '{"error":{"message":"invalid JSON schema"}}'),
    new ProviderHttpError(401, 'maximum context length exceeded'),
    new ProviderHttpError(429, 'prompt is too long'),
    new Error('maximum context length exceeded'),
    null,
    undefined,
  ]
  for (const error of cases) assert.equal(isProviderContextOverflowError(error), false)
})
