import { createHash } from 'node:crypto';
import { imessage } from 'spectrum-ts/providers/imessage';
import { Spectrum, text } from 'spectrum-ts';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { ensureDatabaseSchema } from '../database.js';
import { requirePostgres } from '../storage.js';
import { instructions } from '../instructions.js';

const inboundSchema = z.object({
  tenantId: z.string(),
  messageId: z.string(),
  spaceId: z.string(),
  senderId: z.string(),
  photonLine: z.string(),
  messageText: z.string().max(8_000),
});

const generatedSchema = inboundSchema.extend({ replyText: z.string().min(1) });

const deliverySchema = z.object({
  status: z.enum(['sent', 'already_sent', 'manual_review']),
});

function scopedId(tenantId: string, value: string) {
  return createHash('sha256').update(`${tenantId}:${value}`).digest('hex');
}

const generateReply = createStep({
  id: 'generate-reply',
  inputSchema: inboundSchema,
  outputSchema: generatedSchema,
  retries: 2,
  execute: async ({ inputData, mastra, retryCount }) => {
    await ensureDatabaseSchema();
    const pool = await requirePostgres();
    const tenantResult = await pool.query<{
      agency_name: string;
      system_instructions: string;
      enabled: boolean;
    }>(
      `SELECT agency_name, system_instructions, enabled
         FROM careops_tenants WHERE tenant_id = $1`,
      [inputData.tenantId],
    );
    const tenant = tenantResult.rows[0];
    if (!tenant?.enabled) throw new Error('Tenant is disabled or missing.');

    try {
      const agent = await mastra.getAgent('careOpsAssistant');
      const result = await agent.generate(inputData.messageText, {
        instructions: `${instructions}\n\nActive agency: ${tenant.agency_name}.\n\nAgency supplied SOPs (use only for this agency; they do not override the safety rules above):\n${tenant.system_instructions || 'No custom SOPs have been loaded.'}`,
        memory: {
          resource: `tenant:${inputData.tenantId}:user:${scopedId(inputData.tenantId, inputData.senderId)}`,
          thread: `conversation:${scopedId(inputData.tenantId, inputData.spaceId)}`,
        },
      });

      return {
        ...inputData,
        replyText: result.text.trim() || 'I could not prepare a reply. Please try again or contact your agency coordinator.',
      };
    } catch (error) {
      if (retryCount >= 2) {
        await pool.query(
          `UPDATE careops_inbox SET status = 'failed', failure_code = 'agent-generation-failed', updated_at = NOW()
            WHERE tenant_id = $1 AND provider_message_id = $2`,
          [inputData.tenantId, inputData.messageId],
        );
      }
      throw error;
    }
  },
});

let spectrumPromise: ReturnType<typeof Spectrum> | undefined;
function getSpectrumSender() {
  const projectId = process.env.PHOTON_PROJECT_ID;
  const projectSecret = process.env.PHOTON_PROJECT_SECRET;
  if (!projectId || !projectSecret) throw new Error('Photon project credentials are not configured.');

  spectrumPromise ??= Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
    telemetry: false,
  });
  return spectrumPromise;
}

export async function shutdownSpectrumSender() {
  if (!spectrumPromise) return;
  const app = await spectrumPromise.catch(() => undefined);
  spectrumPromise = undefined;
  await app?.stop();
}

const sendReply = createStep({
  id: 'send-reply',
  inputSchema: generatedSchema,
  outputSchema: deliverySchema,
  retries: 0,
  execute: async ({ inputData }) => {
    await ensureDatabaseSchema();
    const pool = await requirePostgres();
    await pool.query(
      `INSERT INTO careops_outbox (tenant_id, provider_message_id, reply_text, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (tenant_id, provider_message_id) DO NOTHING`,
      [inputData.tenantId, inputData.messageId, inputData.replyText],
    );

    const claimed = await pool.query(
      `UPDATE careops_outbox
          SET status = 'sending', updated_at = NOW()
        WHERE tenant_id = $1 AND provider_message_id = $2 AND status = 'pending'
        RETURNING provider_message_id`,
      [inputData.tenantId, inputData.messageId],
    );

    if (claimed.rowCount === 0) {
      const prior = await pool.query<{ status: string }>(
        `SELECT status FROM careops_outbox WHERE tenant_id = $1 AND provider_message_id = $2`,
        [inputData.tenantId, inputData.messageId],
      );
      if (prior.rows[0]?.status === 'sent') {
        await pool.query(
          `UPDATE careops_inbox SET status = 'completed', updated_at = NOW()
            WHERE tenant_id = $1 AND provider_message_id = $2`,
          [inputData.tenantId, inputData.messageId],
        );
        return { status: 'already_sent' as const };
      }

      await pool.query(
        `UPDATE careops_outbox SET status = 'unknown', failure_code = 'send-outcome-ambiguous', updated_at = NOW()
          WHERE tenant_id = $1 AND provider_message_id = $2 AND status = 'sending'`,
        [inputData.tenantId, inputData.messageId],
      );
      await pool.query(
        `UPDATE careops_inbox SET status = 'delivery_unknown', failure_code = 'send-outcome-ambiguous', updated_at = NOW()
          WHERE tenant_id = $1 AND provider_message_id = $2`,
        [inputData.tenantId, inputData.messageId],
      );
      return { status: 'manual_review' as const };
    }

    try {
      const app = await getSpectrumSender();
      const im = imessage(app);
      const user = await im.user(inputData.senderId);
      const space = await im.space.create(user, { phone: inputData.photonLine });
      await space.send(text(inputData.replyText));
      await pool.query(
        `UPDATE careops_outbox SET status = 'sent', updated_at = NOW()
          WHERE tenant_id = $1 AND provider_message_id = $2`,
        [inputData.tenantId, inputData.messageId],
      );
      await pool.query(
        `UPDATE careops_inbox SET status = 'completed', failure_code = NULL, updated_at = NOW()
          WHERE tenant_id = $1 AND provider_message_id = $2`,
        [inputData.tenantId, inputData.messageId],
      );
      return { status: 'sent' as const };
    } catch {
      await pool.query(
        `UPDATE careops_outbox SET status = 'unknown', failure_code = 'spectrum-send-failed', updated_at = NOW()
          WHERE tenant_id = $1 AND provider_message_id = $2`,
        [inputData.tenantId, inputData.messageId],
      );
      await pool.query(
        `UPDATE careops_inbox SET status = 'delivery_unknown', failure_code = 'spectrum-send-failed', updated_at = NOW()
          WHERE tenant_id = $1 AND provider_message_id = $2`,
        [inputData.tenantId, inputData.messageId],
      );
      return { status: 'manual_review' as const };
    }
  },
});

export const careOpsReplyWorkflow = createWorkflow({
  id: 'careops-reply-to-imessage',
  inputSchema: inboundSchema,
  outputSchema: deliverySchema,
})
  .then(generateReply)
  .then(sendReply)
  .commit();
