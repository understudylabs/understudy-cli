// Wholly invented local app. The deliberate bug is `< 500` rather than `<= 500`.
// It performs no network request and has no external side effects.
export async function run({ input }) {
  const price = (input.grams < 500 ? 4 : 7) + (input.priority ? 3 : 0);
  return { output: { price }, trace: [{ role: 'user', content: `Quote a ${input.grams}-gram ${input.priority ? 'priority' : 'standard'} parcel.` }, { role: 'assistant', content: { price } }], metrics: { costUsd: 0, judgeCostUsd: 0, inputTokens: 0, outputTokens: 0 }, receipt: { model: 'synthetic-local-function', requestIds: [], scope: { environment: 'offline-synthetic' } } };
}
