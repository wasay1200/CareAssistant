import { createHmac, timingSafeEqual } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { ensureDatabaseSchema } from './database.js';
import { requirePostgres } from './storage.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TIMESTAMP_AGE_SECONDS = 5 * 60;

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

function verifySignature(rawBody: Buffer, timestamp: string | undefined, signature: string | undefined) {
  const secret = process.env.SPECTRUM_SIGNING_SECRET;
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_TIMESTAMP_AGE_SECONDS) return false;

  const expected = Buffer.from(
    `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(rawBody).digest('hex')}`,
  );
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
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

    if (!verifySignature(
      rawBody,
      c.req.header('X-Spectrum-Timestamp'),
      c.req.header('X-Spectrum-Signature'),
    )) {
      return c.text('unauthorized', 401);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return c.text('invalid json', 400);
    }

    const parsed = textMessageEvent.safeParse(parsedJson);
    const eventHeader = c.req.header('X-Spectrum-Event');
    if (!parsed.success || parsed.data.event !== eventHeader) return c.text('invalid event', 400);

    const { event, space, message } = parsed.data;
    const content = message.content;
    if (
      event !== 'messages' ||
      message.direction !== 'inbound' ||
      message.platform.toLowerCase() !== 'imessage' ||
      space.platform.toLowerCase() !== 'imessage' ||
      space.type !== 'dm' ||
      content.type !== 'text' ||
      typeof content.text !== 'string' ||
      !space.phone
    ) {
      return c.body(null, 204);
    }

    const senderAllowlist = new Set(
      (process.env.TEST_SENDERS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    );
    if (!senderAllowlist.has(message.sender.id)) return c.body(null, 204);
    if (content.text.length > 8_000) return c.body(null, 204);

    await ensureDatabaseSchema();
    const pool = await requirePostgres();
    const tenantResult = await pool.query<{
      tenant_id: string;
      photon_line: string;
      allowed_senders: string[];
    }>(
      `SELECT tenant_id, photon_line, allowed_senders
         FROM careops_tenants
        WHERE photon_line = $1 AND enabled = TRUE`,
      [space.phone],
    );
    const tenant = tenantResult.rows[0];
    if (!tenant || !tenant.allowed_senders.includes(message.sender.id)) return c.body(null, 204);

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

    return c.json({ accepted: true }, 202);
  },
});
