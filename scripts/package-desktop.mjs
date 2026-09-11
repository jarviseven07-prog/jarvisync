import { packager } from '@electron/packager';
import { mkdir, mkdtemp, cp, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const license = await readFile(join(root, 'LICENSE'), 'utf8');
const notices = [
  'JarviSync — third-party notices',
  'This file preserves the license texts of the frontend dependency graph and Vite runtime helpers. Some entries are build-time type declarations.',
  'Electron and Chromium notices are distributed separately in LICENSE and LICENSES.chromium.html beside the executable.',
];
for (const [packagePath, metadata] of Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right))) {
  if (!packagePath || (metadata.dev && packagePath !== 'node_modules/vite')) continue;
  const packageRoot = join(root, packagePath);
  const files = (await readdir(packageRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(entry.name))
    .map(entry => entry.name).sort();
  if (!files.length) throw new Error(`Missing third-party license text: ${packagePath}`);
  const dependency = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  notices.push(`\n${'='.repeat(72)}\n${dependency.name} ${metadata.version}\nLicense: ${metadata.license || dependency.license || 'See license text'}\n`);
  for (const name of files) notices.push(`--- ${name} ---\n${await readFile(join(packageRoot, name), 'utf8')}`);
}
const thirdPartyNotices = `${notices.join('\n\n')}\n`;
const quickStart = `JarviSync ${pkg.version} — Windows x64\n\n完整解压 ZIP 后，双击 JarviSync.exe。请保留同目录的全部文件。\nExtract the whole ZIP, then open JarviSync.exe. Keep all files together.\n\n当前界面为中文。桌面包无需另行安装 Node.js；接入 Agent 前请先安装对应宿主。\nThe interface is currently Chinese. The desktop package includes its runtime; install your agent host separately.\n\n默认数据目录 / Data: %APPDATA%/Nodeboard/data\n备份前请暂停 Agent 写入，关闭应用并停止使用此数据目录的后台服务，再复制整个目录。\nPause agent writes and stop the app and any background service using this data directory before copying the entire directory.\n\n源码、文档与更新 / Source, documentation and updates:\nhttps://github.com/jarviseven07-prog/jarvisync\n\nJarviSync: MIT (LICENSE-JarviSync.txt)\nThird-party notices: THIRD_PARTY_NOTICES.txt, LICENSE, LICENSES.chromium.html\n`;
await mkdir(join(root, 'artifacts'), { recursive: true });
const staging = await mkdtemp(join(root, 'artifacts', 'desktop-source-'));
for (const name of ['desktop', 'server', 'shared', 'integrations']) await cp(join(root, name), join(staging, name), { recursive: true, filter: path => !path.split(/[\\/]/).includes('__pycache__') && !/\.(pyc|pyo)$/.test(path) });
await cp(resolve(process.env.NODEBOARD_PACKAGE_DIST_DIR || join(root, 'dist')), join(staging, 'dist'), { recursive: true });
await writeFile(join(staging, 'LICENSE'), license);
await writeFile(join(staging, 'THIRD_PARTY_NOTICES.txt'), thirdPartyNotices);
await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'nodeboard', productName: 'JarviSync', version: pkg.version, main: 'desktop/main.cjs', description: '多 Agent 协作与项目管理看板', author: 'Jarvis', license: pkg.license }, null, 2));
const paths = await packager({ dir: staging, out: join(root, 'artifacts', 'desktop'), name: 'JarviSync', icon: join(root, 'desktop', 'assets', 'jarvisync.ico'), platform: 'win32', arch: 'x64', electronVersion: pkg.devDependencies.electron.replace(/^[^\d]+/, ''), overwrite: true, asar: true, prune: false, win32metadata: { CompanyName: 'Jarvis', FileDescription: 'JarviSync 项目画布', ProductName: 'JarviSync' } });
for (const path of paths) {
  await writeFile(join(path, 'LICENSE-JarviSync.txt'), license);
  await writeFile(join(path, 'THIRD_PARTY_NOTICES.txt'), thirdPartyNotices);
  await writeFile(join(path, 'README.txt'), quickStart);
}
console.log(paths.join('\n'));
