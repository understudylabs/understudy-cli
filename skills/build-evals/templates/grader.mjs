// Implement the manifest's criteria independently of the application's output.
// Return every criterion as {status: 'pass'|'fail'|'unscored', reason: '...'}.
// Add judge: {costUsd: 0} for deterministic local checks; paid judges should
// return their actual cost, model and requestIds, leaving missing cost null.
export async function grade(caseRecord, execution) {
  throw Object.assign(new Error('Write observable checks and acceptable/incorrect controls before validation.'), { code: 'GRADER_SETUP_REQUIRED' });
}
