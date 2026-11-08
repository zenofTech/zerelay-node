export interface ZerelayOptions {
  /** Defaults to https://api.zerelay.com */
  baseUrl?: string
  /** Per-request timeout in milliseconds. Default 30000. */
  timeout?: number
  /** Retries for 429s (and, for safe requests, network errors / 502-504). Default 2. */
  maxRetries?: number
  fetch?: typeof fetch
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  headers?: Record<string, string>
  /** Allow retrying network errors / 5xx (only when the request is safe to repeat). */
  idempotent?: boolean
}

export interface Attachment {
  /** Base64-encoded file content */
  content: string
  filename: string
  type?: string
  disposition?: 'attachment' | 'inline'
  content_id?: string
}

export interface SendEmailParams {
  to: string
  subject: string
  /** HTML or plain text */
  body: string
  sender_identity_id?: number
  attachments?: Attachment[]
}

export interface SendEmailResponse {
  task_id: string
  status: 'queued' | 'dropped' | string
  message: string
  test_mode: boolean
}

export interface SendBulkParams {
  recipients: string[]
  subject: string
  body: string
  sender_identity_id?: number
  attachments?: Attachment[]
}

export interface SmsSendParams {
  to: string | string[]
  body: string
  sender_id?: string
  route?: 'standard' | 'corporate' | string
  /** ISO 8601 with a timezone offset, e.g. 2026-12-25T09:00:00+01:00 */
  schedule_at?: string
  reference?: string
}

export interface SmsRecipient {
  to: string
  status: string
  delivery_status: string | null
  error_code: string | null
  error_message: string | null
  charged_kobo: number
  refunded_kobo: number
  delivered_at: string | null
}

export interface SmsMessage {
  id: string
  status: string
  sender_id: string
  route: string
  encoding: string
  pages: number
  recipients_total: number
  recipients_sent: number
  recipients_failed: number
  recipients_unknown: number
  price_kobo_per_page: number
  charged_kobo: number
  refunded_kobo: number
  cost_kobo: number
  reference: string | null
  scheduled_for: string | null
  created_at: string
  sent_at: string | null
  body: string | null
  recipients?: SmsRecipient[]
}

export interface SmsSendResponse extends SmsMessage {
  balance_kobo: number
  test_mode: boolean
}

export interface WebhookEvent<P = Record<string, unknown>> {
  id: number | string
  event: string
  created_at: string
  user_id: number
  test_mode?: boolean
  task_id?: string | null
  email_id?: number | null
  payload: P
}

export class ZerelayError extends Error {
  status: number | null
  body: unknown
  retryAfter: number | null
}

export class ZerelayWebhookError extends Error {}

export interface VerifyWebhookOptions {
  /** The raw request body, exactly as received */
  payload: string | Buffer
  /** Request headers (Node IncomingHttpHeaders, a plain object, or a Fetch Headers) */
  headers: Record<string, string | string[] | undefined> | Headers
  /** The endpoint's signing secret (whsec_...) */
  secret: string
  /** Reject events whose timestamp is older than this. Default 300; 0 disables. */
  toleranceSeconds?: number
}

export function verifyWebhook<P = Record<string, unknown>>(options: VerifyWebhookOptions): WebhookEvent<P>

declare class Emails {
  send(params: SendEmailParams, options?: { idempotencyKey?: string }): Promise<SendEmailResponse>
  sendBulk(params: SendBulkParams): Promise<Record<string, unknown>>
  /** SendGrid v3 /mail/send format */
  mailSend(payload: Record<string, unknown>): Promise<{ status: number; test_mode: boolean }>
  get(taskId: string): Promise<{ task_id: string; status: string; recipient: string | null; sent_at: string | null }>
  list(query?: Record<string, unknown>): Promise<Record<string, unknown>[]>
}

declare class Sms {
  send(params: SmsSendParams, options?: { idempotencyKey?: string }): Promise<SmsSendResponse>
  quote(params: SmsSendParams): Promise<Record<string, unknown>>
  get(messageId: string, options?: { refresh?: boolean }): Promise<SmsMessage>
  list(query?: { status?: string; limit?: number; offset?: number }): Promise<SmsMessage[]>
  cancel(messageId: string): Promise<SmsMessage>
  wallet(): Promise<{ balance_kobo: number; [key: string]: unknown }>
}

export class Zerelay {
  constructor(apiKey?: string, options?: ZerelayOptions)
  readonly emails: Emails
  readonly sms: Sms
  keyInfo(): Promise<{ key_prefix: string; scope: 'full' | 'send'; mode: 'live' | 'test'; account_email: string; rate_limits: Record<string, number> }>
  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>
  static verifyWebhook: typeof verifyWebhook
  static VERSION: string
}

export const VERSION: string
export default Zerelay
