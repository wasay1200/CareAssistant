import { requirePostgres } from './storage.js';

export function configuredPhotonLines() {
  return (process.env.PHOTON_LINE ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

let schemaPromise: Promise<void> | undefined;

export async function ensureDatabaseSchema() {
  schemaPromise ??= initializeSchema().catch((error) => {
    schemaPromise = undefined;
    throw error;
  });
  await schemaPromise;
}

async function initializeSchema() {
  const pool = await requirePostgres();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS careops_tenants (
      tenant_id TEXT PRIMARY KEY,
      agency_name TEXT NOT NULL,
      photon_line TEXT NOT NULL UNIQUE,
      allowed_senders TEXT[] NOT NULL DEFAULT '{}',
      system_instructions TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS careops_inbox (
      tenant_id TEXT NOT NULL REFERENCES careops_tenants(tenant_id),
      provider_message_id TEXT NOT NULL,
      provider_webhook_id TEXT,
      space_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      photon_line TEXT NOT NULL,
      message_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      lease_until TIMESTAMPTZ,
      workflow_run_id TEXT,
      failure_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, provider_message_id)
    );

    CREATE INDEX IF NOT EXISTS careops_inbox_dispatch_idx
      ON careops_inbox(status, lease_until, created_at);

    CREATE TABLE IF NOT EXISTS careops_outbox (
      tenant_id TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      reply_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      failure_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, provider_message_id),
      FOREIGN KEY (tenant_id, provider_message_id)
        REFERENCES careops_inbox(tenant_id, provider_message_id)
    );
  `);

  const tenantId = process.env.CAREGIVER_AGENCY_ID?.trim();
  const agencyName = process.env.CAREGIVER_AGENCY_NAME?.trim();
  // PHOTON_LINE may list several lines for this agency; the first one is the tenant's routing key.
  const [photonLine] = configuredPhotonLines();
  if (!tenantId || !agencyName || !photonLine) {
    throw new Error('Set CAREGIVER_AGENCY_ID, CAREGIVER_AGENCY_NAME, and PHOTON_LINE.');
  }

  const allowedSenders = (process.env.TEST_SENDERS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  await pool.query(
    `INSERT INTO careops_tenants
       (tenant_id, agency_name, photon_line, allowed_senders, enabled)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (tenant_id) DO UPDATE SET
       agency_name = EXCLUDED.agency_name,
       photon_line = EXCLUDED.photon_line,
       allowed_senders = EXCLUDED.allowed_senders,
       enabled = TRUE,
       updated_at = NOW()`,
    [tenantId, agencyName, photonLine, allowedSenders],
  );
}
