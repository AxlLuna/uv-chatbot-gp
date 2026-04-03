import { Agent, run } from '@openai/agents';
import { buildInstructions } from './instructions.js';
import { allTools } from './tools.js';

/**
 * Creates a fresh Agent instance with today's date baked into the instructions.
 * Called per-request so the date is always accurate.
 */
function createAgent() {
  return new Agent({
    name:         'UV-Bot',
    instructions: buildInstructions(),
    model:        'gpt-4.1',
    tools:        allTools,
  });
}

/**
 * @param {string}           message
 * @param {string|undefined} lastResponseId
 * @returns {Promise<{ output: string, responseId: string }>}
 */
export async function runAgent(message, lastResponseId) {
  const agent  = createAgent();
  const result = await run(agent, message, {
    previousResponseId: lastResponseId,
  });

  // Log every tool call so we can verify tools are being invoked
  const toolCalls = result.newItems?.filter(
    (item) => item.type === 'tool_call_item' || item.type === 'tool_result_item'
  ) ?? [];

  if (toolCalls.length) {
    console.log(`[UV-Bot] Tool activity (${toolCalls.length} events):`);
    for (const item of toolCalls) {
      if (item.type === 'tool_call_item') {
        console.log(`  → called: ${item.rawItem?.name}`, item.rawItem?.arguments ?? '');
      } else if (item.type === 'tool_result_item') {
        const preview = JSON.stringify(item.rawItem?.output ?? '').slice(0, 120);
        console.log(`  ← result: ${preview}…`);
      }
    }
  } else {
    console.log('[UV-Bot] No tool calls in this turn.');
  }

  return {
    output:     result.finalOutput,
    responseId: result.lastResponseId,
  };
}
