'use strict'

const crypto = require('node:crypto')

const VERSION = '0.1.0'
const DEFAULT_BASE_URL = 'https://api.zerelay.com'
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

class ZerelayError extends Error {
  constructor(message, { status = null, body = null, retryAfter = null } = {}) {
    super(message)
    this.name = 'ZerelayError'
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
  }
}

class ZerelayWebhookError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZerelayWebhookError'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function detailOf(body, fallback) {
  const d = body && typeof body === 'object' ? body.detail : null
  if (Array.isArray(d)) {
    return d.map((item) => (item && item.msg ? `${(item.loc || []).join('.')}: ${item.msg}` : String(item))).join('; ')
  }
  return (d && String(d)) || fallback
}

class Zerelay {
  /**
   * @param {string} [apiKey] Your API key. Defaults to process.env.ZERELAY_API_KEY.
   * @param {{ baseUrl?: string, timeout?: number, maxRetries?: number, fetch?: typeof fetch }} [options]
   */
  constructor(apiKey = process.env.ZERELAY_API_KEY, options = {}) {
    if (!apiKey) throw new Error('Missing Zerelay API key: pass it to new Zerelay(key) or set ZERELAY_API_KEY')
    this.apiKey = apiKey
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeout = options.timeout ?? 30000
    this.maxRetries = options.maxRetries ?? 2
    this._fetch = options.fetch || globalThis.fetch
    if (!this._fetch) throw new Error('No fetch implementation found (Node 18+ required, or pass options.fetch)')
    this.emails = new Emails(this)
    this.sms = new Sms(this)
  }

  /** What the configured key is: live/test, full/send-only, and the account's rate limits. */
  keyInfo() {
    return this.request('GET', '/api-keys/current')
  }

  /**
   * Call any endpoint (see https://api.zerelay.com/docs).
   * Retries 429s always, and network errors / 502-504 for GETs and requests that carry an
   * Idempotency-Key, honouring Retry-After.
   */
  async request(method, path, { query, body, headers = {}, idempotent = false } = {}) {
    const url = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
    const canRetryFailures = method === 'GET' || idempotent
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeout)
      let response
      try {
        response = await this._fetch(url, {
          method,
          headers: {
            'X-API-Key': this.apiKey,
            'User-Agent': `zerelay-node/${VERSION}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        })
      } catch (err) {
        clearTimeout(timer)
        if (canRetryFailures && attempt < this.maxRetries) {
          await sleep(this._backoff(attempt))
          continue
        }
        const reason = err && err.name === 'AbortError' ? `timed out after ${this.timeout}ms` : (err && err.message) || String(err)
        throw new ZerelayError(`Request to ${method} ${path} failed: ${reason}`)
      }
      clearTimeout(timer)
      const text = await response.text()
      let data = null
      if (text) {
        try { data = JSON.parse(text) } catch { data = text }
      }
      if (response.ok) {
        if (data === null) return { status: response.status, test_mode: response.headers.get('x-zerelay-test-mode') === 'true' }
        return data
      }
      const retryAfter = Number(response.headers.get('retry-after')) || null
      const retryable = response.status === 429 || (canRetryFailures && RETRYABLE_STATUS.has(response.status))
      if (retryable && attempt < this.maxRetries) {
        await sleep(retryAfter ? Math.min(retryAfter, 60) * 1000 : this._backoff(attempt))
        continue
      }
      throw new ZerelayError(detailOf(data, `HTTP ${response.status}`), { status: response.status, body: data, retryAfter })
    }
  }

  _backoff(attempt) {
    return Math.min(8000, 500 * 2 ** attempt) * (0.8 + Math.random() * 0.4)
  }
}

class Emails {
  constructor(client) { this._c = client }

  /**
   * Send one email. Retries are safe: an Idempotency-Key is generated unless you pass one.
   * @param {{ to: string, subject: string, body: string, sender_identity_id?: number, attachments?: object[] }} params
   */
  send(params, { idempotencyKey } = {}) {
    return this._c.request('POST', '/send-email', {
      body: params,
      headers: { 'Idempotency-Key': idempotencyKey || crypto.randomUUID() },
      idempotent: true,
    })
  }

  /** One message to many recipients (each gets their own copy). */
  sendBulk(params) {
    return this._c.request('POST', '/send-bulk-emails', { body: params })
  }

  /** Full control (cc, bcc, separate text/html, templates, categories): the SendGrid v3 format. */
  mailSend(payload) {
    return this._c.request('POST', '/v3/mail/send', { body: payload })
  }

  /** Status of a send by task_id. */
  get(taskId) {
    return this._c.request('GET', `/email-status/${encodeURIComponent(taskId)}`)
  }

  list(query = {}) {
    return this._c.request('GET', '/emails', { query })
  }
}

class Sms {
  constructor(client) { this._c = client }

  /**
   * Send an SMS to one or more Nigerian numbers, paid from your SMS wallet.
   * @param {{ to: string|string[], body: string, sender_id?: string, route?: string, schedule_at?: string, reference?: string }} params
   */
  send(params, { idempotencyKey } = {}) {
    return this._c.request('POST', '/sms/send', {
      body: params,
      headers: { 'Idempotency-Key': idempotencyKey || crypto.randomUUID() },
      idempotent: true,
    })
  }

  /** Price a send without sending or charging. */
  quote(params) {
    return this._c.request('POST', '/sms/quote', { body: params, idempotent: true })
  }

  get(messageId, { refresh = false } = {}) {
    return this._c.request('GET', `/sms/messages/${encodeURIComponent(messageId)}`, { query: { refresh } })
  }

  list(query = {}) {
    return this._c.request('GET', '/sms/messages', { query })
  }

  /** Cancel a scheduled message (fully refunded). */
  cancel(messageId) {
    return this._c.request('POST', `/sms/messages/${encodeURIComponent(messageId)}/cancel`)
  }

  wallet() {
    return this._c.request('GET', '/sms/wallet')
  }
}

function headerValue(headers, name) {
  if (!headers) return undefined
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v
  }
  return undefined
}

/**
 * Verify a Zerelay webhook and return the parsed event. Throws ZerelayWebhookError if the
 * signature is wrong or the timestamp is older than `toleranceSeconds` (replay protection).
 * Pass the RAW request body (string or Buffer) - not a re-serialised JSON object.
 */
function verifyWebhook({ payload, headers, secret, toleranceSeconds = 300, now = Date.now() / 1000 }) {
  if (!secret) throw new ZerelayWebhookError('Missing webhook signing secret')
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
  const signature = headerValue(headers, 'x-zerelay-signature') || headerValue(headers, 'x-smtp-signature')
  const timestamp = headerValue(headers, 'x-zerelay-timestamp') || headerValue(headers, 'x-smtp-timestamp')
  if (!signature || !timestamp) throw new ZerelayWebhookError('Missing X-Zerelay-Signature or X-Zerelay-Timestamp header')
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) throw new ZerelayWebhookError('Invalid X-Zerelay-Timestamp header')
  if (toleranceSeconds > 0 && Math.abs(now - ts) > toleranceSeconds) {
    throw new ZerelayWebhookError('Webhook timestamp is outside the allowed tolerance (possible replay)')
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(String(signature))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ZerelayWebhookError('Invalid webhook signature')
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new ZerelayWebhookError('Webhook body is not valid JSON')
  }
}

Zerelay.verifyWebhook = verifyWebhook
Zerelay.ZerelayError = ZerelayError
Zerelay.ZerelayWebhookError = ZerelayWebhookError
Zerelay.VERSION = VERSION

module.exports = Zerelay
module.exports.Zerelay = Zerelay
module.exports.default = Zerelay
module.exports.verifyWebhook = verifyWebhook
module.exports.ZerelayError = ZerelayError
module.exports.ZerelayWebhookError = ZerelayWebhookError
module.exports.VERSION = VERSION
