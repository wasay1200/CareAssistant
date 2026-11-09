import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { instructions } from './instructions.js';

export const careOpsAssistant = new Agent({
  id: 'careops-agency-assistant',
  name: 'Caregiver Agency Assistant',
  model: process.env.MASTRA_MODEL ?? 'mastra/anthropic/claude-sonnet-5-5',
  instructions,
  memory: new Memory({
    options: { lastMessages: 20 },
  }),
});
