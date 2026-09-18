import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const read = relative => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// Codex refreshes its cached copy of a plugin only when the manifest version changes, and the MCP
// server reports its own version to the host, so every one of these has to move with package.json.
test('release version is the same everywhere a host reads it', async () => {
  const { version } = JSON.parse(await read('../package.json'));
  for (const manifest of ['../integrations/claude-code/jarvisync/.claude-plugin/plugin.json', '../integrations/codex/jarvisync/.codex-plugin/plugin.json']) {
    assert.equal(JSON.parse(await read(manifest)).version, version, manifest);
  }
  const reported = new RegExp(`serverInfo: \\{ name: 'jarvisync', version: '${version.replaceAll('.', '\\.')}' \\}`);
  assert.match(await read('../integrations/runtime/mcp.mjs'), reported);
});
