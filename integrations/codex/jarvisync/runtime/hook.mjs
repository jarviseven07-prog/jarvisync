export * from '../../../runtime/hook.mjs';
import { runHook } from '../../../runtime/hook.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const result = await runHook({
    rawInput: raw ? JSON.parse(raw) : {},
    configPath: new URL('./connection.json', import.meta.url),
    configuredHost: 'codex',
  });
  if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
} catch {
  // An unavailable local board cannot block a Codex session.
}
