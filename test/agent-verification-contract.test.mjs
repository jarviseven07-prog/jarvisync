import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { startServer } from '../server/index.mjs';

test('验证读回缺少 challenge 或 receipt 时返回精确参数错误', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-verify-contract-'));
  const app = await startServer({ port: 0, dataDir: directory });
  t.after(async () => {
    await app.close();
    if (dirname(directory) === tmpdir() && basename(directory).startsWith('jarvisync-verify-contract-')) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const profile = await app.onboarding.prepare({ host: 'mcp', scope: 'work' });
  const connection = JSON.parse(await readFile(profile.configPath, 'utf8'));
  const session = { host: 'mcp', profileId: profile.id, sessionId: 'verify-contract-session' };
  const auth = { host: 'mcp', profileId: profile.id, connectionToken: connection.connectionToken, session };
  const read = await app.onboarding.verify({ ...auth, phase: 'read' });

  await assert.rejects(
    app.onboarding.verify({ ...auth, phase: 'readback', receipt: 'missing-challenge' }),
    error => error.status === 400 && error.details?.code === 'verification-challenge-required' && /challenge/.test(error.message),
  );
  const write = await app.onboarding.verify({ ...auth, phase: 'write', challenge: read.challenge });
  await assert.rejects(
    app.onboarding.verify({ ...auth, phase: 'readback', challenge: read.challenge }),
    error => error.status === 400 && error.details?.code === 'verification-receipt-required' && /receipt/.test(error.message),
  );
  const readback = await app.onboarding.verify({ ...auth, phase: 'readback', challenge: read.challenge, receipt: write.receipt });
  assert.equal(readback.verified, true);
});
