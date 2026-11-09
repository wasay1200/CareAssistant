import 'dotenv/config';
import { Mastra } from '@mastra/core';
import { careOpsAssistant } from './agent.js';
import { mastraStorage } from './storage.js';
import { healthRoute, photonWebhookRoute } from './webhook.js';
import { careOpsReplyWorkflow } from './workflows/careops-reply.js';
import { InboxDispatcherWorker } from './workers/inbox-dispatcher.js';

export const mastra = new Mastra({
  agents: { careOpsAssistant },
  workflows: { careOpsReplyWorkflow },
  storage: mastraStorage,
  workers: [new InboxDispatcherWorker()],
  server: {
    apiRoutes: [healthRoute, photonWebhookRoute],
  },
});
