import { packager } from '@electron/packager';
import { mkdir, mkdtemp, cp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
await mkdir(join(root, 'artifacts'), { recursive: true });
const staging = await mkdtemp(join(root, 'artifacts', 'desktop-source-'));
for (const name of ['desktop', 'server', 'shared', 'integrations']) await cp(join(root, name), join(staging, name), { recursive: true, filter: path => !path.split(/[\\/]/).includes('__pycache__') && !/\.(pyc|pyo)$/.test(path) });
await cp(resolve(process.env.NODEBOARD_PACKAGE_DIST_DIR || join(root, 'dist')), join(staging, 'dist'), { recursive: true });
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'nodeboard', productName: 'JarviSync', version: pkg.version, main: 'desktop/main.cjs', description: '个人与 AI 共用的本地项目画布', author: 'Jarvis', license: 'UNLICENSED' }, null, 2));
const paths = await packager({ dir: staging, out: join(root, 'artifacts', 'desktop'), name: 'JarviSync', icon: join(root, 'desktop', 'assets', 'jarvisync.ico'), platform: 'win32', arch: 'x64', electronVersion: pkg.devDependencies.electron.replace(/^[^\d]+/, ''), overwrite: true, asar: true, prune: false, win32metadata: { CompanyName: 'Jarvis', FileDescription: 'JarviSync 项目画布', ProductName: 'JarviSync' } });
console.log(paths.join('\n'));
