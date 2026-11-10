import { createHmac, timingSafeEqual } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { configuredPhotonLines, ensureDatabaseSchema } from './database.js';
import { requirePostgres } from './storage.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TIMESTAMP_AGE_SECONDS = 5 * 60;
const INBOUND_MESSAGE_EVENTS = new Set(['messages', 'message.received']);

const textMessageEvent = z.object({
  event: z.string(),
  space: z.object({
    id: z.string().min(1),
    platform: z.string(),
    type: z.string().optional(),
    phone: z.string().optional(),
  }).passthrough(),
  message: z.object({
    id: z.string().min(1),
    direction: z.string(),
    platform: z.string(),
    sender: z.object({ id: z.string().min(1), platform: z.string() }),
    content: z.object({ type: z.string() }).passthrough(),
  }).passthrough(),
}).passthrough();

type VerifyResult =
  | { ok: true; scheme: 'standard' | 'legacy' }
  | { ok: false; reason: string };

// Log only the last two digits of a phone handle.
function maskHandle(value: string) {
  return value.length > 4 ? `${value.slice(0, 3)}…${value.slice(-2)}` : '…';
}

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

function timestampFresh(timestamp: string) {
  if (!/^\d+$/.test(timestamp)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  return Number.isFinite(age) && age <= MAX_TIMESTAMP_AGE_SECONDS;
}

// Photon returns two secrets when a webhook is registered. `normalized-events.v1`
// webhooks sign with the legacy hex `signingSecret` (X-Spectrum-Timestamp /
// X-Spectrum-Signature). `raw-inbound.v1` webhooks sign with the Standard Webhooks
// `whsec_` secret (webhook-id / webhook-timestamp / webhook-signature).
// Configure both and verify against whichever headers the delivery carries.
function configuredSecrets() {
  const values = [process.env.SPECTRUM_SIGNING_SECRET, process.env.SPECTRUM_STANDARD_SIGNING_SECRET]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  return {
    standard: values.find((value) => value.startsWith('whsec_')),
    legacy: values.find((value) => !value.startsWith('whsec_')),
  };
}

function verifySignature(rawBody: Buffer, header: (name: string) => string | undefined): VerifyResult {
  const { standard, legacy } = configuredSecrets();
  if (!standard && !legacy) return { ok: false, reason: 'signing-secret-not-configured' };

  let failure: VerifyResult | undefined;
  if (standard && header('webhook-signature')) {
    const result = verifyStandard(rawBody, header, standard);
    if (result.ok) return result;
    failure = result;
  }
  if (legacy && header('X-Spectrum-Signature')) {
    const result = verifyLegacy(rawBody, header, legacy);
    if (result.ok) return result;
    failure = result;
  }
  if (failure) return failure;
  if (header('X-Spectrum-Signature')) return { ok: false, reason: 'legacy-secret-not-configured' };
  if (header('webhook-signature')) return { ok: false, reason: 'standard-secret-not-configured' };
  return { ok: false, reason: 'signature-headers-missing' };
}

function verifyStandard(
  rawBody: Buffer,
  header: (name: string) => string | undefined,
  secret: string,
): VerifyResult {
  const id = header('webhook-id');
  const timestamp = header('webhook-timestamp');
  const signatures = header('webhook-signature');
  if (!id || !timestamp || !signatures) return { ok: false, reason: 'standard-headers-missing' };
  if (!timestampFresh(timestamp)) return { ok: false, reason: 'timestamp-expired' };

  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = Buffer.from(
    createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest('base64'),
  );
  const matched = signatures
    .split(' ')
    .map((entry) => entry.split(','))
    .some(([version, value]) => version === 'v1' && !!value && safeEqual(expected, Buffer.from(value)));
  return matched ? { ok: true, scheme: 'standard' } : { ok: false, reason: 'standard-signature-mismatch' };
}

function verifyLegacy(
  rawBody: Buffer,
  header: (name: string) => string | undefined,
  secret: string,
): VerifyResult {
  if (/^https?:\/\//i.test(secret)) return { ok: false, reason: 'signing-secret-is-a-url' };

  const timestamp = header('X-Spectrum-Timestamp');
  const signature = header('X-Spectrum-Signature');
  if (!timestamp || !signature) return { ok: false, reason: 'legacy-headers-missing' };
  if (!timestampFresh(timestamp)) return { ok: false, reason: 'timestamp-expired' };

  const expected = Buffer.from(
    `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(rawBody).digest('hex')}`,
  );
  return safeEqual(expected, Buffer.from(signature))
    ? { ok: true, scheme: 'legacy' }
    : { ok: false, reason: 'legacy-signature-mismatch' };
}

export const healthRoute = registerApiRoute('/healthz', {
  method: 'GET',
  requiresAuth: false,
  handler: async (c) => {
    try {
      await ensureDatabaseSchema();
      await (await requirePostgres()).query('SELECT 1');
      return c.json({ status: 'ok', service: 'careassistant-cloud-agent' });
    } catch {
      return c.json({ status: 'unavailable', service: 'careassistant-cloud-agent' }, 503);
    }
  },
});

export const photonWebhookRoute = registerApiRoute('/photon/webhook', {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) return c.text('payload too large', 413);

    const verification = verifySignature(rawBody, (name) => c.req.header(name));
    if (!verification.ok) {
      console.warn('Photon webhook rejected', {
        reason: verification.reason,
        hasStandardHeaders: !!c.req.header('webhook-signature'),
        hasLegacyHeaders: !!c.req.header('X-Spectrum-Signature'),
      });
      return c.text('unauthorized', 401);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return c.text('invalid json', 400);
    }

    const parsed = textMessageEvent.safeParse(parsedJson);
    // X-Spectrum-Event is optional on current Photon deliveries; only reject a contradiction.
    const eventHeader = c.req.header('X-Spectrum-Event');
    if (!parsed.success || (eventHeader && parsed.data.event !== eventHeader)) {
      console.warn('Photon webhook payload invalid', {
        scheme: verification.scheme,
        event: parsed.success ? parsed.data.event : undefined,
        eventHeader: eventHeader ?? null,
      });
      return c.text('invalid event', 400);
    }

    const { event, space, message } = parsed.data;
    const content = message.content;
    const ignored = (reason: string, details: Record<string, unknown> = {}) => {
      console.info('Photon webhook ignored', { reason, messageId: message.id, ...details });
      return c.body(null, 204);
    };
    if (
      !INBOUND_MESSAGE_EVENTS.has(event) ||
      message.direction !== 'inbound' ||
      message.platform.toLowerCase() !== 'imessage' ||
      space.platform.toLowerCase() !== 'imessage' ||
      space.type !== 'dm' ||
      content.type !== 'text' ||
      typeof content.text !== 'string' ||
      !space.phone
    ) {
      return ignored('unsupported-message', { event, spaceType: space.type ?? null, contentType: content.type });
    }

    const senderAllowlist = new Set(
      (process.env.TEST_SENDERS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    );
    if (!senderAllowlist.has(message.sender.id)) {
      return ignored('sender-not-allowlisted', { sender: maskHandle(message.sender.id) });
    }
    if (content.text.length > 8_000) return ignored('message-too-long');

    // Photon labels shared-pool iMessage conversations with the literal "shared".
    // Only map that label in the explicitly enabled, single-tenant demo mode.
    const sharedLine = space.phone === 'shared';
    if (sharedLine && process.env.PHOTON_SHARED_LINE_TEST_MODE !== 'true') {
      return ignored('shared-line-test-mode-disabled');
    }
    // Every line listed in PHOTON_LINE belongs to this agency, so map any of them
    // (and the shared-pool label) to the agency's primary line.
    const agencyLines = configuredPhotonLines();
    const routingLine = sharedLine || agencyLines.includes(space.phone) ? agencyLines[0] : space.phone;
    if (!routingLine) return ignored('routing-line-missing');

    await ensureDatabaseSchema();
    const pool = await requirePostgres();
    const tenantResult = await pool.query<{
      tenant_id: string;
      photon_line: string;
      allowed_senders: string[];
    }>(
      `SELECT tenant_id, photon_line, allowed_senders
         FROM careops_tenants
        WHERE photon_line = $1
          AND enabled = TRUE
          AND ($2::boolean = FALSE OR (SELECT COUNT(*) FROM careops_tenants WHERE enabled = TRUE) = 1)`,
      [routingLine, sharedLine],
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) return ignored('tenant-not-found', { line: maskHandle(routingLine), sharedLine });
    if (!tenant.allowed_senders.includes(message.sender.id)) {
      return ignored('sender-not-allowed-for-tenant', { sender: maskHandle(message.sender.id) });
    }

    await pool.query(
      `INSERT INTO careops_inbox
         (tenant_id, provider_message_id, provider_webhook_id, space_id, sender_id,
          photon_line, message_text, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
       ON CONFLICT (tenant_id, provider_message_id) DO NOTHING`,
      [
        tenant.tenant_id,
        message.id,
        c.req.header('X-Spectrum-Webhook-Id') ?? null,
        space.id,
        message.sender.id,
        tenant.photon_line,
        content.text,
      ],
    );

    console.info('Photon inbound message queued', {
      messageId: message.id,
      webhookId: c.req.header('X-Spectrum-Webhook-Id') ?? null,
      tenantId: tenant.tenant_id,
      lineMode: sharedLine ? 'shared-test' : 'dedicated',
    });

    return c.json({ accepted: true }, 202);
  },
});
