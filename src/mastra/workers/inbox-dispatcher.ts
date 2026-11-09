import { createHash } from 'node:crypto';
import { MastraWorker } from '@mastra/core/worker';
import type { WorkerStopOptions } from '@mastra/core/worker';
import { ensureDatabaseSchema } from '../database.js';
import { requirePostgres } from '../storage.js';
import { shutdownSpectrumSender } from '../workflows/careops-reply.js';

type QueuedMessage = {
  tenant_id: string;
  provider_message_id: string;
  space_id: string;
  sender_id: string;
  photon_line: string;
  message_text: string;
  dispatch_attempts: number;
};

const TERMINAL_FAILURES = new Set(['failed', 'tripwire', 'bailed', 'canceled']);
const ACTIVE_STATES = new Set(['running', 'pending', 'waiting', 'suspended', 'paused']);

function stableRunId(tenantId: string, messageId: string) {
  return `photon-${createHash('sha256').update(`${tenantId}:${messageId}`).digest('hex')}`;
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class InboxDispatcherWorker extends MastraWorker {
  readonly name = 'careops-inbox-dispatcher';
  private running = false;
  private loopTask?: Promise<void>;
  private inFlight = 0;

  get isRunning() {
    return this.running;
  }

  async start() {
    if (this.running || !process.env.DATABASE_URL) return;
    this.running = true;
    this.loopTask = this.runLoop();
  }

  async stop(_options?: WorkerStopOptions) {
    this.running = false;
    await this.loopTask;
    await shutdownSpectrumSender();
  }

  private async runLoop() {
    while (this.running) {
      try {
        await ensureDatabaseSchema();
        for (let i = 0; i < 10 && this.running; i += 1) {
          const row = await this.claimNext();
          if (!row) break;
          this.inFlight += 1;
          try {
            await this.dispatch(row);
          } catch {
            await this.releaseForRetry(row);
          } finally {
            this.inFlight -= 1;
          }
        }
      } catch (error) {
        this.deps?.logger.error('CareOps inbox worker poll failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
        });
      }

      if (this.running) await delay(1_000);
    }
  }

  private async claimNext(): Promise<QueuedMessage | undefined> {
    const pool = await requirePostgres();
    const result = await pool.query<QueuedMessage>(
      `WITH next_message AS (
         SELECT tenant_id, provider_message_id
           FROM careops_inbox
          WHERE (status = 'queued' AND (lease_until IS NULL OR lease_until < NOW()))
             OR (status = 'dispatching' AND lease_until < NOW())
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE careops_inbox AS inbox
          SET status = 'dispatching',
              dispatch_attempts = dispatch_attempts + 1,
              lease_until = NOW() + INTERVAL '90 seconds',
              updated_at = NOW()
         FROM next_message
        WHERE inbox.tenant_id = next_message.tenant_id
          AND inbox.provider_message_id = next_message.provider_message_id
       RETURNING inbox.tenant_id, inbox.provider_message_id, inbox.space_id,
                 inbox.sender_id, inbox.photon_line, inbox.message_text,
                 inbox.dispatch_attempts`,
    );
    return result.rows[0];
  }

  private async dispatch(row: QueuedMessage) {
    if (!this.mastra) throw new Error('Mastra instance is not registered on the worker.');
    const pool = await requirePostgres();
    const workflow = this.mastra.getWorkflow('careOpsReplyWorkflow');
    const baseRunId = stableRunId(row.tenant_id, row.provider_message_id);
    const prior = await workflow.getWorkflowRunById(baseRunId);

    if (prior && !TERMINAL_FAILURES.has(prior.status)) {
      await pool.query(
        `UPDATE careops_inbox
            SET status = $3, workflow_run_id = $4, lease_until = NULL, updated_at = NOW()
          WHERE tenant_id = $1 AND provider_message_id = $2`,
        [row.tenant_id, row.provider_message_id, prior.status === 'success' ? 'completed' : 'dispatched', baseRunId],
      );
      return;
    }

    const runId = prior
      ? `${baseRunId}-retry-${row.dispatch_attempts}`
      : baseRunId;
    const existingRetry = runId === baseRunId ? undefined : await workflow.getWorkflowRunById(runId);
    if (existingRetry && !TERMINAL_FAILURES.has(existingRetry.status)) {
      await pool.query(
        `UPDATE careops_inbox SET status = $3, workflow_run_id = $4, lease_until = NULL, updated_at = NOW()
          WHERE tenant_id = $1 AND provider_message_id = $2`,
        [row.tenant_id, row.provider_message_id, existingRetry.status === 'success' ? 'completed' : 'dispatched', runId],
      );
      return;
    }

    const run = await workflow.createRun({ runId, resourceId: row.tenant_id });
    await run.startAsync({
      inputData: {
        tenantId: row.tenant_id,
        messageId: row.provider_message_id,
        spaceId: row.space_id,
        senderId: row.sender_id,
        photonLine: row.photon_line,
        messageText: row.message_text,
      },
    });

    await pool.query(
      `UPDATE careops_inbox SET status = 'dispatched', workflow_run_id = $3, lease_until = NULL, updated_at = NOW()
        WHERE tenant_id = $1 AND provider_message_id = $2`,
      [row.tenant_id, row.provider_message_id, runId],
    );
  }

  private async releaseForRetry(row: QueuedMessage) {
    try {
      const pool = await requirePostgres();
      const delaySeconds = Math.min(60, 2 ** Math.min(row.dispatch_attempts, 6));
      await pool.query(
        `UPDATE careops_inbox
            SET status = 'queued', lease_until = NOW() + ($3 * INTERVAL '1 second'),
                failure_code = 'workflow-dispatch-failed', updated_at = NOW()
          WHERE tenant_id = $1 AND provider_message_id = $2`,
        [row.tenant_id, row.provider_message_id, delaySeconds],
      );
    } catch (error) {
      this.deps?.logger.error('CareOps failed to release inbox item', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
      });
    }
  }
}
