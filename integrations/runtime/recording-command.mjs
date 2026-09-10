import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConnection, createClient } from './client.mjs';
import { readSessionState, updateSessionState } from './hook.mjs';

const actions = new Set(['status', 'on', 'off']);

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function commandOptions(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!['--connection', '--session-id'].includes(key) || value === undefined || values[key]) throw new Error('用法：recording-command.mjs <status|on|off> --connection <连接文件> --session-id <Claude 会话 ID>');
    values[key] = value;
  }
  if (!actions.has(action) || !text(values['--connection']) || !text(values['--session-id'])) throw new Error('用法：recording-command.mjs <status|on|off> --connection <连接文件> --session-id <Claude 会话 ID>');
  return { action, connection: values['--connection'], sessionId: values['--session-id'] };
}

function sessionFor(config, sessionId) {
  return { host: config.host, profileId: config.profileId, sessionId };
}

function localIntent(state) {
  if (state?.explicitRecordingOverride === true) return 'on';
  if (state?.explicitRecordingOverride === false) return 'off';
  return 'unset';
}

function unavailable(error) {
  return { state: 'unavailable', message: error?.message || '无法读取已关联的本机看板。' };
}

export async function recordingCommand({ action, config, sessionId, client = createClient(config) }) {
  if (!actions.has(action)) throw new Error('不支持的记录命令。');
  const session = sessionFor(config, sessionId);
  let before = await readSessionState(config, session);
  if (action === 'status') {
    try {
      const discovered = await client.discover(session);
      return { action, session, localIntent: localIntent(before), remote: { state: 'available', revision: discovered.revision, binding: discovered.binding ?? null } };
    } catch (error) {
      return { action, session, localIntent: localIntent(before), remote: unavailable(error) };
    }
  }

  const recording = action === 'on';
  const next = await updateSessionState(config, session, current => ({ ...(current || {}), explicitRecordingOverride: recording }));
  let discovered;
  try {
    discovered = await client.discover(session);
  } catch (error) {
    return { action, session, localIntent: localIntent(next), remote: unavailable(error) };
  }
  if (!discovered.binding) {
    return { action, session, localIntent: localIntent(next), remote: { state: 'unbound', revision: discovered.revision } };
  }
  try {
    const result = await client.attach({
      session,
      recording,
      expectedRevision: discovered.revision,
      clientOperationId: `recording-${action}-${randomUUID()}`,
    });
    if (result.binding?.recording === recording) {
      await updateSessionState(config, session, current => current?.explicitRecordingOverride === recording
        ? { ...current, recordingDisabled: !recording }
        : current);
    }
    return { action, session, localIntent: localIntent(next), remote: { state: 'updated', revision: result.revision, binding: result.binding } };
  } catch (error) {
    return { action, session, localIntent: localIntent(next), remote: { state: 'not-updated', message: error?.message || '远端记录状态未更新。', ...(error?.details?.code ? { code: error.details.code } : {}) } };
  }
}

async function main() {
  const { action, connection, sessionId } = commandOptions();
  const config = await loadConnection(connection);
  process.stdout.write(`${JSON.stringify(await recordingCommand({ action, config, sessionId }))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
