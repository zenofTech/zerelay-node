# Zerelay for Node.js

Official Node.js SDK for the [Zerelay](https://zerelay.com) email and SMS API. No dependencies; Node 18+.

```bash
npm install zerelay
```

## Send an email

```js
const { Zerelay } = require('zerelay') // or: import { Zerelay } from 'zerelay'

const zerelay = new Zerelay(process.env.ZERELAY_API_KEY)

const { task_id } = await zerelay.emails.send({
  to: 'jane@example.com',
  subject: 'Your order has shipped',
  body: '<p>It will arrive on Friday.</p>',
})
```

Need cc/bcc, separate text and HTML parts, templates or categories? Use `emails.mailSend()`, which takes the SendGrid v3 `/mail/send` format:

```js
await zerelay.emails.mailSend({
  personalizations: [{ to: [{ email: 'jane@example.com' }], cc: [{ email: 'ops@example.com' }] }],
  from: { email: 'orders@yourdomain.com', name: 'Your Store' },
  subject: 'Order #1001',
  content: [
    { type: 'text/plain', value: 'Thanks for your order' },
    { type: 'text/html', value: '<p>Thanks for your order</p>' },
  ],
})
```

## Send an SMS

```js
const message = await zerelay.sms.send({ to: '08031234567', body: 'Your code is 4821' })
console.log(message.status, message.cost_kobo)
```

## Test mode

Create a **test key** (`sk_test_...`) under **API Keys** in the dashboard. Test keys check every request exactly like a live key does, but nothing is sent, charged or counted toward your quota. Webhooks still fire, marked `"test_mode": true`. Send to `bounce@simulator.zerelay.com` to simulate a bounce.

## Verify webhooks

Every webhook is signed with your endpoint's secret. Verify the **raw** body:

```js
const express = require('express')
const { verifyWebhook } = require('zerelay')

app.post('/webhooks/zerelay', express.raw({ type: 'application/json' }), (req, res) => {
  let event
  try {
    event = verifyWebhook({ payload: req.body, headers: req.headers, secret: process.env.ZERELAY_WEBHOOK_SECRET })
  } catch (err) {
    return res.status(400).send(err.message)
  }
  // event.event is e.g. "delivered", "bounce", "sms.delivered"; de-duplicate on event.id
  res.sendStatus(200)
})
```

## Errors and retries

Failed requests throw a `ZerelayError` with `status`, `message` (the API's explanation) and `body`. The client retries automatically:

- **Rate limits (429)** are always retried, after the `Retry-After` delay.
- **Network errors and 502/503/504** are retried only when repeating the request is safe. That covers GETs, plus `emails.send()` and `sms.send()`, which send an automatic `Idempotency-Key`.

Change this with `new Zerelay(key, { maxRetries: 0 })`.

Any other endpoint can be called with `zerelay.request(method, path, { body, query })`. The full reference is at <https://api.zerelay.com/docs>.

## License

MIT
