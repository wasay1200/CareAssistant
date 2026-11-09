# CareAssistant cloud demo

This repository contains the cloud hosted Mastra Server for the CareOps caregiver agency demo. Photon delivers signed iMessage events to the server; Mastra stores each accepted event in PostgreSQL, dispatches a durable workflow, generates a response with Claude Sonnet through Mastra, and sends it through Spectrum. No Mac, local listener, ngrok tunnel, OpenAI key, Supabase, or CRM integration is needed in production.

## Message flow

1. Photon sends a signed `POST /photon/webhook` event over HTTPS.
2. The route verifies the raw body HMAC and timestamp, checks the configured test sender and line, then writes the inbound event to the Postgres inbox before returning `202`.
3. A Mastra worker dispatches the event into a persisted workflow. Mastra's Postgres storage keeps workflow and memory state available across restarts.
4. The shared agent uses tenant scoped memory and agency specific instructions loaded from the tenant configuration. The demo does not expose record writing tools.
5. The workflow sends the reply through the Spectrum SDK. A durable outbox record prevents a retry from sending twice if delivery is ambiguous.

The included startup seed configures one demo agency. Additional agencies should receive their own Photon line and an agency configuration row, while keeping the tenant ID derived from the server side line mapping. Do not derive tenant identity from incoming message text or a caller supplied field.

## Mastra Cloud setup

Connect this GitHub repository to the existing Mastra project `starter-agent-6d53`, with the repository root as the application directory. Attach a Mastra managed PostgreSQL database to the Production environment, then add these environment variables there:

| Variable | Value |
|---|---|
| `PHOTON_PROJECT_ID` | The Photon Spectrum project ID |
| `PHOTON_PROJECT_SECRET` | The matching Photon project secret |
| `SPECTRUM_SIGNING_SECRET` | The secret returned once when the Photon webhook is created |
| `CAREGIVER_AGENCY_ID` | `careops-demo` |
| `CAREGIVER_AGENCY_NAME` | `Caregiver Agency Demo` |
| `PHOTON_LINE` | The dedicated Photon iMessage line |
| `TEST_SENDERS` | Comma separated E.164 allowlist for the demo testers |
| `MASTRA_MODEL` | `mastra/anthropic/claude-sonnet-5-5` |

Mastra supplies `DATABASE_URL` to the runtime when its managed PostgreSQL database is attached. Keep credentials in the Mastra environment variable manager; never put them in GitHub, logs, or a local `.env` committed to the repository.

After the first successful deployment, copy the public server URL from the Mastra project and register this Photon webhook URL:

```text
https://<mastra-server-host>/photon/webhook
```

Select the `messages` event. Save the signing secret immediately in the Production environment as `SPECTRUM_SIGNING_SECRET`; Photon only returns it when the webhook is created. The route is unauthenticated at the Mastra layer and relies on Photon HMAC verification.

## Test

Open `/healthz` on the deployed server. It should return `200` with `status: "ok"` after PostgreSQL is attached and initialized. Text the Photon line from a number included in `TEST_SENDERS`; the first message should introduce the demo assistant and ask whether the tester is a caregiver, family contact, or coordinator.

Only fictional sample data belongs in this demo. It is not a clinical system and is not ready for real patient information. No CRM, schedule, payroll, family-notification, or care-record write is enabled. The outbox uses at-most-once delivery for ambiguous send outcomes because the current Spectrum text-send surface does not expose a stable client GUID; ambiguous outcomes are recorded for review rather than automatically resent.

## Local development

Use Node.js 22.13 or newer. Copy `.env.example` to `.env`, provide a development Postgres URL and test credentials, then run `npm install`, `npm run typecheck`, and `npm run dev`. The local environment is for development and is not the production service.
