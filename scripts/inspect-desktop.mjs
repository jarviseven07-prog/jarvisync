import { _electron } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve('.');
const output = join(root, 'artifacts', 'desktop-qa');
await mkdir(output, { recursive: true });
const app = await _electron.launch({ executablePath: join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], env: { ...process.env, NODEBOARD_DESKTOP_DATA_DIR: join(output, 'user-data') }, timeout: 30000 });
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '作品集更新', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.screenshot({ path: join(output, '01-overview.png') });
  await page.getByRole('heading', { name: '搭建视觉方向', exact: true }).click();
  await page.getByLabel('节点详情', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, '02-inspector.png') });
  await writeFile(join(output, 'initial-state.txt'), await page.locator('body').innerText());
  console.log(JSON.stringify({ url: page.url(), contentSize: page.viewportSize(), output }));
} finally { await app.close(); }
