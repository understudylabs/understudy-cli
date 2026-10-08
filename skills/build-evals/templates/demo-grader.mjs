export async function grade(caseRecord, execution) {
  const output = execution.output;
  const shape = output !== null && typeof output === 'object' && !Array.isArray(output) && Number.isSafeInteger(output.price) && output.price >= 0;
  return { verdicts: {
    'output-shape': { status: shape ? 'pass' : 'fail', reason: shape ? 'The quote has a nonnegative integer price.' : 'A nonnegative integer price is required.' },
    'quote-correct': { status: !shape ? 'unscored' : output.price === caseRecord.expected.price ? 'pass' : 'fail', reason: !shape ? 'There is no valid numeric quote to compare.' : `Expected ${caseRecord.expected.price} units; observed ${output.price}.` }
  }, judge: { costUsd: 0 } };
}
