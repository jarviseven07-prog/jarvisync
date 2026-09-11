import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeBuildIdentity } from '../server/build-identity.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Exercise the same Windows PowerShell version used by the shipped launcher.
const powershell = process.env.JARVISYNC_TEST_POWERSHELL || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

function spawnNode(entry, { cwd, env }) {
  const child = spawn(process.execPath, [entry], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderrText = '';
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  return child;
}

async function waitFor(url, expectedBuildId, allowLegacy = false) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.product === 'JarviSync' && (!expectedBuildId || health.buildId === expectedBuildId)) return health;
      } else if (allowLegacy && response.status === 404 && (await fetch(`${url}/api/board`)).ok) return null;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('mock service did not become healthy');
}

async function waitForMockReady({ child, readyPath, lockPath }) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const reason = child.signalCode ? `signal ${child.signalCode}` : `exit ${child.exitCode}`;
      throw new Error(`mock service exited early (${reason}): ${child.stderrText || 'no stderr'}`);
    }
    try {
      const ready = JSON.parse(await readFile(readyPath, 'utf8'));
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      if (ready.pid !== child.pid) throw new Error(`ready pid ${ready.pid} does not match mock pid ${child.pid}`);
      if (lock.pid !== child.pid) throw new Error(`lock pid ${lock.pid} does not match mock pid ${child.pid}`);
      if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw new Error(`invalid mock port ${ready.port}`);
      return ready;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`mock service did not report a matching ready record: ${lastError?.message || child.stderrText || 'no diagnostic'}`);
}

async function endpointDiagnostics(url, kind) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    let body;
    try { body = await response.json(); } catch { /* Status is still useful when the body is not JSON. */ }
    return kind === 'board'
      ? { status: response.status, schemaVersion: body?.schemaVersion, revision: body?.revision, projectsArray: Array.isArray(body?.projects), nodesArray: Array.isArray(body?.nodes) }
      : { status: response.status, product: body?.product, boardInstanceId: body?.boardInstanceId, buildId: body?.buildId };
  } catch (error) { return { error: error.message }; }
}

async function powershellHttpDiagnostics(port) {
  try {
    return JSON.parse(await runPowerShell(`
      Set-StrictMode -Version Latest
      function Get-DiagnosticHttpStatus($ErrorRecord) {
        $responseProperty = $ErrorRecord.Exception.PSObject.Properties['Response']
        if (-not $responseProperty -or -not $responseProperty.Value) { return $null }
        try { return [int]$responseProperty.Value.StatusCode } catch { return $null }
      }
      $board = $null; $boardWeb = $null; $health = $null
      try {
        $boardBody = Invoke-RestMethod -Uri 'http://127.0.0.1:${port}/api/board' -TimeoutSec 2
        $board = [pscustomobject]@{ status = 200; schemaVersion = $boardBody.schemaVersion; revision = $boardBody.revision; projectsArray = ($boardBody.projects -is [object[]]); nodesArray = ($boardBody.nodes -is [object[]]) }
      } catch {
        $board = [pscustomobject]@{ status = Get-DiagnosticHttpStatus $_; error = $_.Exception.Message }
      }
      try {
        $boardWebResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:${port}/api/board' -TimeoutSec 2 -UseBasicParsing
        $boardWeb = [pscustomobject]@{ status = [int]$boardWebResponse.StatusCode }
      } catch {
        $boardWeb = [pscustomobject]@{ status = Get-DiagnosticHttpStatus $_; error = $_.Exception.Message }
      }
      try {
        $healthResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:${port}/api/health' -TimeoutSec 2 -UseBasicParsing
        $healthBody = $healthResponse.Content | ConvertFrom-Json
        $health = [pscustomobject]@{ status = [int]$healthResponse.StatusCode; product = $healthBody.product; boardInstanceId = $healthBody.boardInstanceId; buildId = $healthBody.buildId }
      } catch {
        $health = [pscustomobject]@{ status = Get-DiagnosticHttpStatus $_; error = $_.Exception.Message }
      }
      [pscustomobject]@{ board = $board; boardWeb = $boardWeb; health = $health } | ConvertTo-Json -Depth 4 -Compress
    `));
  } catch (error) { return { error: error.message }; }
}

async function isolatedRuntimeDiagnostics({ data, port, old, serverEntry }) {
  let lock;
  try { lock = JSON.parse(await readFile(join(data, 'server.lock'), 'utf8')); }
  catch (error) { lock = { error: error.message }; }
  let process;
  try {
    process = JSON.parse(await runPowerShell([
      "$listenerError = $null; $processError = $null",
      `try { $listeners = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; address = $_.LocalAddress } }) } catch { $listeners = @(); $listenerError = $_.Exception.Message }`,
      `try { $target = Get-CimInstance Win32_Process -Filter 'ProcessId=${old?.pid || 0}' -ErrorAction Stop; $targetInfo = if ($target) { [pscustomobject]@{ pid = [int]$target.ProcessId; name = $target.Name; commandLine = $target.CommandLine } } else { $null } } catch { $targetInfo = $null; $processError = $_.Exception.Message }`,
      '[pscustomobject]@{ listeners = $listeners; listenerError = $listenerError; target = $targetInfo; processError = $processError } | ConvertTo-Json -Depth 4 -Compress',
    ].join('; ')));
  } catch (error) { process = { error: error.message }; }
  return {
    expectedMockPid: old?.pid,
    expectedServerEntry: serverEntry,
    mockExitCode: old?.exitCode,
    mockStderr: old?.stderrText || '',
    lock,
    process,
    nodeHttp: {
      board: await endpointDiagnostics(`http://127.0.0.1:${port}/api/board`, 'board'),
      health: await endpointDiagnostics(`http://127.0.0.1:${port}/api/health`, 'health'),
    },
    powershellHttp: await powershellHttpDiagnostics(port),
  };
}

async function fixtureServerPidFromLock({ data, serverEntry }) {
  if (!serverEntry) return undefined;
  let pid;
  try { pid = JSON.parse(await readFile(join(data, 'server.lock'), 'utf8')).pid; }
  catch { return undefined; }
  if (!Number.isInteger(pid) || pid < 1) return undefined;
  try {
    const result = JSON.parse(await runPowerShell([
      `$target = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue`,
      `$matchesFixture = $target -and $target.Name -eq 'node.exe' -and $target.CommandLine -and $target.CommandLine.IndexOf(${quote(serverEntry)}, [System.StringComparison]::OrdinalIgnoreCase) -ge 0`,
      'if ($matchesFixture) { [pscustomobject]@{ pid = [int]$target.ProcessId } | ConvertTo-Json -Compress } else { $null | ConvertTo-Json -Compress }',
    ].join('; ')));
    return result?.pid === pid ? pid : undefined;
  } catch { return undefined; }
}

async function runPowerShell(command) {
  const env = { ...process.env };
  // A parent pwsh must not replace Windows PowerShell's own module search path.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const child = spawn(powershell, ['-NoProfile', '-Command', `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference = 'Stop'; ${command}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`PowerShell failed: ${stderr || stdout}`);
  return stdout;
}

async function runNodeScript(entry, args, cwd) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Node script failed: ${stderr}`);
}


async function lockFileExclusively(path) {
  const command = [
    `$stream = [System.IO.File]::Open(${quote(path)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)`,
    "[Console]::Out.WriteLine('LOCKED')",
    'try { Start-Sleep -Seconds 60 } finally { $stream.Dispose() }',
  ].join('; ');
  const child = spawn(powershell, ['-NoProfile', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolveReady, rejectReady) => {
    child.stdout.once('data', chunk => {
      if (String(chunk).includes('LOCKED')) resolveReady();
      else rejectReady(new Error(`lock helper did not report readiness: ${chunk}`));
    });
    child.once('exit', code => rejectReady(new Error(`lock helper exited early (${code}): ${stderr}`)));
  });
  return child;
}

async function releaseLockedFile(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function stopProcess(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function launcherDiagnostics(dataDir) {
  const logs = join(dataDir, 'launcher');
  try {
    const names = (await readdir(logs)).filter(name => /-(server|error)\.log$/.test(name)).sort();
    const latest = names.slice(-2);
    const text = await Promise.all(latest.map(async name => `${name}:\n${await readFile(join(logs, name), 'utf8')}`));
    return text.join('\n');
  } catch { return 'no launcher diagnostic was written'; }
}

test('build identity maps a verified artifact and installed dist to the same runtime paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-build-id-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'server'), { recursive: true });
  await mkdir(join(directory, 'shared'), { recursive: true });
  await mkdir(join(directory, 'integrations'), { recursive: true });
  await mkdir(join(directory, 'artifacts', 'agent-onboarding-build'), { recursive: true });
  await mkdir(join(directory, 'dist'), { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'server', 'entry.mjs'), 'export default 1\n'),
    writeFile(join(directory, 'shared', 'entry.mjs'), 'export default 2\n'),
    writeFile(join(directory, 'integrations', 'entry.mjs'), 'export default 3\n'),
    writeFile(join(directory, 'artifacts', 'agent-onboarding-build', 'index.html'), '<main>same</main>\n'),
    writeFile(join(directory, 'dist', 'index.html'), '<main>same</main>\n'),
  ]);
  const artifact = await computeBuildIdentity({ root: directory, distDir: join(directory, 'artifacts', 'agent-onboarding-build') });
  const installed = await computeBuildIdentity({ root: directory, distDir: join(directory, 'dist') });
  assert.equal(artifact.buildId, installed.buildId);
  assert.ok(artifact.inputs.some(input => input.path.startsWith('server/')));
  assert.ok(artifact.inputs.some(input => input.path.startsWith('frontend/')));
  await mkdir(join(directory, 'integrations', '__pycache__'), { recursive: true });
  await writeFile(join(directory, 'integrations', '__pycache__', 'entry.cpython-313.pyc'), 'generated cache');
  await writeFile(join(directory, 'integrations', 'ignored.tmp'), 'temporary cache');
  const cacheIgnored = await computeBuildIdentity({ root: directory, distDir: join(directory, 'dist') });
  assert.equal(cacheIgnored.buildId, installed.buildId);
  await writeFile(join(directory, 'integrations', 'entry.mjs'), 'export default 33\n');
  const sourceChanged = await computeBuildIdentity({ root: directory, distDir: join(directory, 'dist') });
  assert.notEqual(sourceChanged.buildId, installed.buildId);
});

test('verified candidate backs up and replaces an isolated old service before health readback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-verified-update-'));
  const data = join(directory, 'data');
  let old; let loadedPid;
  let serverEntry;
  t.after(async () => {
    const stopped = new Set();
    for (const pid of [old?.pid, loadedPid]) {
      if (pid) { await stopProcess(pid); stopped.add(pid); }
    }
    const fixturePid = await fixtureServerPidFromLock({ data, serverEntry });
    if (fixturePid && !stopped.has(fixturePid)) await stopProcess(fixturePid);
    let cleanupError;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) { cleanupError = error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw cleanupError;
  });
  const artifact = join(directory, 'artifacts', 'agent-onboarding-build');
  await mkdir(join(directory, 'server'), { recursive: true });
  await mkdir(join(directory, 'shared'), { recursive: true });
  await mkdir(join(directory, 'integrations'), { recursive: true });
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(join(artifact, 'assets'), { recursive: true });
  await mkdir(join(directory, 'dist'), { recursive: true });
  await Promise.all([
    cp(join(root, 'server', 'build-identity.mjs'), join(directory, 'server', 'build-identity.mjs')),
    cp(join(root, 'scripts', 'verified-update.ps1'), join(directory, 'scripts', 'verified-update.ps1')),
    cp(join(root, 'scripts', 'load-verified-update.ps1'), join(directory, 'scripts', 'load-verified-update.ps1')),
    writeFile(join(directory, 'shared', 'runtime.mjs'), 'export const shared = true\n'),
    writeFile(join(directory, 'integrations', 'runtime.mjs'), 'export const integration = true\n'),
    writeFile(join(directory, 'dist', 'index.html'), '<main>old</main>\n'),
    writeFile(join(directory, 'dist', 'stale-old.js'), 'old hashed asset\n'),
    writeFile(join(artifact, 'index.html'), '<main>verified</main>\n'),
    writeFile(join(artifact, 'assets', 'style.css'), 'main { color: black; }\n'),
    writeFile(join(data, 'board.json'), JSON.stringify({ schemaVersion: 1, revision: 7, projects: [], nodes: [] })),
  ]);
  await writeFile(join(directory, 'server', 'mock-server.mjs'), `
    import { createServer } from 'node:http';
    import { readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { computeBuildId } from './build-identity.mjs';
    const data = process.env.NODEBOARD_DATA_DIR;
    const root = process.cwd();
    const port = Number(process.env.PORT || 0);
    const legacy = process.env.MOCK_LEGACY === '1';
    let identity;
    try { identity = JSON.parse(await readFile(join(data, 'instance.json'), 'utf8')); }
    catch { identity = { boardInstanceId: 'isolated-board' }; if (!legacy) await writeFile(join(data, 'instance.json'), JSON.stringify(identity)); }
    const buildId = await computeBuildId({ root, distDir: join(root, 'dist') });
    const server = createServer(async (request, response) => {
      const board = JSON.parse(await readFile(join(data, 'board.json'), 'utf8'));
      const health = request.url === '/api/health';
      const body = health && !legacy ? { product: 'JarviSync', boardInstanceId: identity.boardInstanceId, buildId } : request.url === '/api/board' ? board : { error: 'missing' };
      response.writeHead((health && !legacy) || request.url === '/api/board' ? 200 : 404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
    });
    await writeFile(join(data, 'server.lock'), JSON.stringify({ pid: process.pid }));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await writeFile(join(data, 'mock-server-ready.json'), JSON.stringify({ pid: process.pid, port: server.address().port }));
  `);
  await mkdir(join(directory, 'artifacts', 'agent-onboarding-qa'), { recursive: true });
  const manifestPath = join(directory, 'artifacts', 'agent-onboarding-qa', 'verified-files.json');
  await cp(join(root, 'scripts', 'write-verified-manifest.mjs'), join(directory, 'scripts', 'write-verified-manifest.mjs'));
  await runNodeScript(join(directory, 'scripts', 'write-verified-manifest.mjs'), [directory, artifact, manifestPath], directory);
  const candidate = JSON.parse(await readFile(manifestPath, 'utf8'));
  serverEntry = join(directory, 'server', 'mock-server.mjs');
  old = spawnNode(serverEntry, { cwd: directory, env: { ...process.env, PORT: '0', NODEBOARD_DATA_DIR: data, MOCK_LEGACY: '1' } });
  const { port } = await waitForMockReady({ child: old, readyPath: join(data, 'mock-server-ready.json'), lockPath: join(data, 'server.lock') });
  await waitFor(`http://127.0.0.1:${port}`, undefined, true);
  const validateOnly = JSON.parse(await runPowerShell(`& ${quote(join(directory, 'scripts', 'load-verified-update.ps1'))} -ValidateOnly`));
  assert.equal(validateOnly.verified, true);
  assert.equal(validateOnly.pending, true);
  const command = [
    `. ${quote(join(directory, 'scripts', 'verified-update.ps1'))}`,
    `$candidate = Get-JarviSyncVerifiedCandidate -Root ${quote(directory)} -NodeExecutable ${quote(process.execPath)}`,
    `Invoke-JarviSyncVerifiedUpdate -Candidate $candidate -DataDir ${quote(data)} -Port ${port} -NodeExecutable ${quote(process.execPath)} -ServerEntry ${quote(serverEntry)} | ConvertTo-Json -Compress`,
  ].join('; ');
  let loaded;
  try { loaded = JSON.parse(await runPowerShell(command)); }
  catch (error) {
    error.message += `\nIsolated runtime diagnostics:\n${JSON.stringify(await isolatedRuntimeDiagnostics({ data, port, old, serverEntry }))}`;
    error.message += `\nIsolated launcher diagnostics:\n${await launcherDiagnostics(data)}`;
    throw error;
  }
  loadedPid = loaded.Pid;
  assert.equal(loaded.Status, 'loaded');
  assert.equal(loaded.BuildId, candidate.buildId);
  assert.ok(loaded.Backup);
  const health = await waitFor(`http://127.0.0.1:${port}`, candidate.buildId);
  assert.equal(health.boardInstanceId, 'isolated-board');
  assert.equal(await readFile(join(directory, 'dist', 'index.html'), 'utf8'), '<main>verified</main>\n');
  await assert.rejects(stat(join(directory, 'dist', 'stale-old.js')));
  assert.equal(await readFile(join(loaded.Backup, 'data', 'board.json'), 'utf8'), await readFile(join(data, 'board.json'), 'utf8'));
});

test('verified update backup skips a locked Electron profile but preserves all business data and fails on business copy errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-verified-backup-'));
  const data = join(directory, 'data');
  const dist = join(directory, 'dist');
  let locked;
  t.after(async () => {
    await releaseLockedFile(locked);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    mkdir(join(data, 'desktop-profile', 'Network'), { recursive: true }),
    mkdir(join(data, 'agent-integrations', 'codex'), { recursive: true }),
    mkdir(join(data, 'history'), { recursive: true }),
    mkdir(join(data, 'uploads'), { recursive: true }),
    mkdir(dist, { recursive: true }),
  ]);
  const originals = {
    board: JSON.stringify({ schemaVersion: 1, revision: 9, projects: [], nodes: [] }),
    instance: JSON.stringify({ boardInstanceId: 'backup-test' }),
    connection: JSON.stringify({ profileId: 'codex-test', token: 'test-only' }),
    history: 'history entry\n',
    upload: 'upload bytes\n',
    frontend: '<main>old frontend</main>\n',
  };
  await Promise.all([
    writeFile(join(data, 'board.json'), originals.board),
    writeFile(join(data, 'instance.json'), originals.instance),
    writeFile(join(data, 'agent-integrations', 'codex', 'connection.json'), originals.connection),
    writeFile(join(data, 'history', 'revision-9.json'), originals.history),
    writeFile(join(data, 'uploads', 'delivery.txt'), originals.upload),
    writeFile(join(data, 'desktop-profile', 'Network', 'Cookies'), 'browser profile lock target'),
    writeFile(join(dist, 'index.html'), originals.frontend),
    writeFile(join(dist, 'stale-old.js'), 'stale frontend asset\n'),
  ]);

  locked = await lockFileExclusively(join(data, 'desktop-profile', 'Network', 'Cookies'));
  const result = JSON.parse(await runPowerShell([
    `. ${quote(join(root, 'scripts', 'verified-update.ps1'))}`,
    `$backup = New-JarviSyncUpdateBackup -Root ${quote(directory)} -DataDir ${quote(data)} -DistDir ${quote(dist)}`,
    `$record = Get-Content -LiteralPath (Join-Path $backup 'backup-record.json') -Raw | ConvertFrom-Json`,
    '[pscustomobject]@{ backup = $backup; record = $record } | ConvertTo-Json -Depth 5 -Compress',
  ].join('; ')));
  const exclusions = Array.isArray(result.record.excludedDataEntries) ? result.record.excludedDataEntries : [result.record.excludedDataEntries];
  assert.equal(exclusions[0].path, 'desktop-profile');
  assert.equal(exclusions[0].present, true);
  await assert.rejects(stat(join(result.backup, 'data', 'desktop-profile')));
  assert.equal(await readFile(join(result.backup, 'data', 'board.json'), 'utf8'), originals.board);
  assert.equal(await readFile(join(result.backup, 'data', 'instance.json'), 'utf8'), originals.instance);
  assert.equal(await readFile(join(result.backup, 'data', 'agent-integrations', 'codex', 'connection.json'), 'utf8'), originals.connection);
  assert.equal(await readFile(join(result.backup, 'data', 'history', 'revision-9.json'), 'utf8'), originals.history);
  assert.equal(await readFile(join(result.backup, 'data', 'uploads', 'delivery.txt'), 'utf8'), originals.upload);
  assert.equal(await readFile(join(result.backup, 'dist', 'index.html'), 'utf8'), originals.frontend);
  assert.equal(await readFile(join(result.backup, 'dist', 'stale-old.js'), 'utf8'), 'stale frontend asset\n');
  assert.equal(await readFile(join(data, 'board.json'), 'utf8'), originals.board);
  assert.equal(await readFile(join(data, 'agent-integrations', 'codex', 'connection.json'), 'utf8'), originals.connection);
  assert.equal(await readFile(join(dist, 'index.html'), 'utf8'), originals.frontend);

  await releaseLockedFile(locked);
  locked = await lockFileExclusively(join(data, 'board.json'));
  await assert.rejects(
    runPowerShell(`. ${quote(join(root, 'scripts', 'verified-update.ps1'))}; New-JarviSyncUpdateBackup -Root ${quote(directory)} -DataDir ${quote(data)} -DistDir ${quote(dist)} | Out-Null`),
    /used by another process|because it is being used|cannot access|拒绝访问/i,
  );
});
