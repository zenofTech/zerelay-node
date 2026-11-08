'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const crypto = require('node:crypto')
const { Zerelay, verifyWebhook, ZerelayError, ZerelayWebhookError } = require('..')

function mockServer(handler) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined })
      handler(req, res, calls.length)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })
  }))
}

const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(data === undefined ? '' : JSON.stringify(data))
}

test('send email: auth header, user agent, auto idempotency key', async () => {
  const { server, calls, url } = await mockServer((req, res) => json(res, 200, { task_id: 't1', status: 'queued', message: 'ok', test_mode: false }))
  const zr = new Zerelay('sk_test_abc', { baseUrl: url })
  const out = await zr.emails.send({ to: 'a@example.com', subject: 's', body: 'b' })
  assert.equal(out.task_id, 't1')
  assert.equal(calls[0].url, '/send-email')
  assert.equal(calls[0].headers['x-api-key'], 'sk_test_abc')
  assert.match(calls[0].headers['user-agent'], /^zerelay-node\//)
  assert.match(calls[0].headers['idempotency-key'], /^[0-9a-f-]{36}$/)
  assert.deepEqual(calls[0].body, { to: 'a@example.com', subject: 's', body: 'b' })
  server.close()
})

test('429 is retried after Retry-After, same idempotency key', async () => {
  const { server, calls, url } = await mockServer((req, res, n) => n === 1
    ? json(res, 429, { detail: 'Rate limit exceeded' }, { 'Retry-After': '1' })
    : json(res, 200, { id: 'sms_1' }))
  const zr = new Zerelay('sk_x', { baseUrl: url })
  const t0 = Date.now()
  const out = await zr.sms.send({ to: '08031234567', body: 'hi' })
  assert.equal(out.id, 'sms_1')
  assert.equal(calls.length, 2)
  assert.ok(Date.now() - t0 >= 900, 'waited for Retry-After')
  assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key'])
  server.close()
})

test('503 retried only when safe; errors carry status + detail', async () => {
  const { server, calls, url } = await mockServer((req, res) => json(res, 503, { detail: 'Worker unavailable' }))
  const zr = new Zerelay('sk_x', { baseUrl: url, maxRetries: 1 })
  await assert.rejects(zr.emails.sendBulk({ recipients: ['a@example.com'], subject: 's', body: 'b' }), (err) => {
    assert.ok(err instanceof ZerelayError)
    assert.equal(err.status, 503)
    assert.equal(err.message, 'Worker unavailable')
    return true
  })
  assert.equal(calls.length, 1, 'bulk send (not idempotent) is not retried on 503')
  await assert.rejects(zr.emails.get('t1'))
  assert.equal(calls.length, 3, 'GET retried once')
  server.close()
})

test('422 validation detail is flattened', async () => {
  const { server, url } = await mockServer((req, res) => json(res, 422, { detail: [{ loc: ['body', 'to'], msg: 'value is not a valid email address' }] }))
  const zr = new Zerelay('sk_x', { baseUrl: url })
  await assert.rejects(zr.emails.send({ to: 'x', subject: 's', body: 'b' }), /body\.to: value is not a valid email address/)
  server.close()
})

test('202 with no body (v3) returns status + test_mode', async () => {
  const { server, calls, url } = await mockServer((req, res) => { res.writeHead(202, { 'X-Zerelay-Test-Mode': 'true' }); res.end() })
  const zr = new Zerelay('sk_x', { baseUrl: url })
  const out = await zr.emails.mailSend({ personalizations: [{ to: [{ email: 'a@example.com' }] }], from: { email: 'b@example.com' }, subject: 's', content: [{ type: 'text/plain', value: 'x' }] })
  assert.deepEqual(out, { status: 202, test_mode: true })
  assert.equal(calls[0].url, '/v3/mail/send')
  server.close()
})

test('query params and path encoding', async () => {
  const { server, calls, url } = await mockServer((req, res) => json(res, 200, {}))
  const zr = new Zerelay('sk_x', { baseUrl: url + '/' })
  await zr.sms.get('sms_a/b', { refresh: true })
  await zr.sms.list({ status: 'sent', limit: 5, offset: undefined })
  assert.equal(calls[0].url, '/sms/messages/sms_a%2Fb?refresh=true')
  assert.equal(calls[1].url, '/sms/messages?status=sent&limit=5')
  server.close()
})

test('missing key throws', () => {
  const saved = process.env.ZERELAY_API_KEY
  delete process.env.ZERELAY_API_KEY
  assert.throws(() => new Zerelay(), /Missing Zerelay API key/)
  if (saved) process.env.ZERELAY_API_KEY = saved
})

test('verifyWebhook: valid, legacy headers, tampered, replayed', () => {
  const secret = 'whsec_test'
  const payload = JSON.stringify({ id: 1, event: 'delivered', payload: { recipient: 'a@example.com' } })
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')
  const event = verifyWebhook({ payload, headers: { 'X-Zerelay-Signature': sig, 'X-Zerelay-Timestamp': ts }, secret })
  assert.equal(event.event, 'delivered')
  assert.equal(verifyWebhook({ payload: Buffer.from(payload), headers: new Headers({ 'x-smtp-signature': sig, 'x-smtp-timestamp': ts }), secret }).id, 1)
  assert.throws(() => verifyWebhook({ payload: payload + ' ', headers: { 'x-zerelay-signature': sig, 'x-zerelay-timestamp': ts }, secret }), ZerelayWebhookError)
  assert.throws(() => verifyWebhook({ payload, headers: { 'x-zerelay-signature': sig, 'x-zerelay-timestamp': ts }, secret: 'whsec_other' }), /Invalid webhook signature/)
  const old = String(Math.floor(Date.now() / 1000) - 3600)
  const oldSig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${old}.${payload}`).digest('hex')
  assert.throws(() => verifyWebhook({ payload, headers: { 'x-zerelay-signature': oldSig, 'x-zerelay-timestamp': old }, secret }), /tolerance/)
  assert.equal(verifyWebhook({ payload, headers: { 'x-zerelay-signature': oldSig, 'x-zerelay-timestamp': old }, secret, toleranceSeconds: 0 }).id, 1)
  assert.throws(() => verifyWebhook({ payload, headers: {}, secret }), /Missing X-Zerelay-Signature/)
})

test('ESM entry', async () => {
  const mod = await import('../index.mjs')
  assert.equal(typeof mod.Zerelay, 'function')
  assert.equal(typeof mod.verifyWebhook, 'function')
  assert.equal(mod.default, mod.Zerelay)
})
