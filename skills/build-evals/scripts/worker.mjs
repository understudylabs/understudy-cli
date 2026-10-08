import { pathToFileURL } from 'node:url';

// Each operation runs in a separately terminated process. This is a deadline,
// not a security sandbox: adapters and graders must be trusted application code.
process.once('disconnect', () => {
  if (process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }
  process.exit(1);
});
let started = false;
// Keep the IPC listener alive while an adapter awaits a never-settling promise;
// the parent owns the deadline and terminates this worker after one operation.
process.on('message', async message => {
  if (started) return;
  started = true;
  try {
    const module = await import(pathToFileURL(message.module).href);
    const operation = message.kind === 'execute' ? module.run : module.grade;
    if (typeof operation !== 'function') throw Object.assign(new Error(`Export async ${message.kind === 'execute' ? 'run' : 'grade'} from the configured module.`), { code: 'MODULE_SETUP_REQUIRED' });
    const value = message.kind === 'execute'
      ? await operation(message.case, message.context)
      : await operation(message.case, message.execution);
    process.send({ ok: true, value });
  } catch (error) {
    process.send({ ok: false, error: { message: String(error?.message ?? error), code: String(error?.code ?? 'OPERATION_ERROR') } });
  }
});
