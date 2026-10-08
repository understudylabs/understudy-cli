// Wholly invented local functions; these names do not identify real models.
export async function run(task, context) {
  const model = context.model;
  if (!['synthetic/incumbent', 'synthetic/fast', 'synthetic/careful'].includes(model)) throw new Error('Choose one of the three synthetic demo models.');
  const { grams, priority } = task.input;
  let price = (grams <= 500 ? 4 : 7) + (priority ? 3 : 0);
  if (model === 'synthetic/incumbent' && grams === 500) price += 3;
  if (model === 'synthetic/fast' && priority) price -= 1;
  const fallback = model === 'synthetic/careful' && grams === 500 && priority;
  const missingCost = model === 'synthetic/careful' && grams === 250 && priority;
  const cost = missingCost ? null : model === 'synthetic/fast' ? 0.001 : model === 'synthetic/incumbent' ? 0.01 : 0.004;
  const requestId = `synthetic-${context.runId}-${task.id}-${context.repetition}`;
  return {
    output: { price },
    trace: [{ role: 'assistant', content: { price, explanation: 'Synthetic fixture output, not an inference result.' } }],
    metrics: { costUsd: cost, judgeCostUsd: 0, latencyMs: model === 'synthetic/fast' ? 80 : 200 },
    receipt: {
      requestIds: [requestId], callsComplete: true,
      calls: [{ requestId, requestedModel: model, servedModel: fallback ? 'synthetic/incumbent' : model, fallbackUsed: fallback, costUsd: cost, costBasis: 'synthetic' }],
    },
  };
}
