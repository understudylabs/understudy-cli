// Replace this with the application's test entry point. It receives no expected
// answer or rubric. Declare imported dependencies in manifest.fingerprintFiles.
export async function run({ id, title, input }, { runId, repetition, workload }) {
  throw Object.assign(new Error('Connect the existing application runner using isolated test tools before fresh execution.'), { code: 'ADAPTER_SETUP_REQUIRED' });
}
