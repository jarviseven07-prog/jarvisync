// Run with the repository Electron executable; no renderer or board service is created.
const { app, shell } = require('electron');
const { join, resolve } = require('node:path');
const { mkdirSync, existsSync, copyFileSync, writeFileSync } = require('node:fs');
const root = resolve(__dirname, '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const evidence = join(root, 'artifacts', 'desktop-entry');
app.setPath('userData', join(evidence, 'shortcut-profile'));
app.whenReady().then(() => {
  mkdirSync(evidence, { recursive: true });
  const linkPath = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'JarviSync 看板.lnk');
  const details = {
    target: join(root, 'desktop', 'JarviSync.exe'), cwd: root, args: '',
    description: 'JarviSync · 多 Agent 协作与项目管理',
    icon: join(root, 'desktop', 'assets', 'jarvisync.ico'), iconIndex: 0,
    appUserModelId: 'Jarvis.JarviSync',
  };
  if (!existsSync(details.target) || !existsSync(details.icon)) throw new Error('Build the launcher and icon first.');
  const before = existsSync(linkPath) ? shell.readShortcutLink(linkPath) : null;
  const target = apply ? linkPath : join(evidence, 'JarviSync-preview.lnk');
  if (apply && before) copyFileSync(linkPath, join(evidence, `start-menu-before-${Date.now()}.lnk`));
  mkdirSync(resolve(target, '..'), { recursive: true });
  if (!shell.writeShortcutLink(target, 'create', details)) throw new Error('Could not save the Unicode shortcut.');
  const after = shell.readShortcutLink(target);
  for (const key of Object.keys(details)) if (after[key] !== details[key]) throw new Error(`Shortcut readback mismatch: ${key}`);
  const result = { applied: apply, linkPath: target, before, after, checkedAt: new Date().toISOString() };
  writeFileSync(join(evidence, apply ? 'shortcut-installed.json' : 'shortcut-preview.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}).then(() => app.quit(), error => { console.error(error); app.exit(1); });
