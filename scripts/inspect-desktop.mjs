import { _electron } from '@playwright/test';
// Outside Electron this module resolves to the platform's binary path.
import electronPath from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve('.');
const output = join(root, 'artifacts', 'desktop-qa');
await mkdir(output, { recursive: true });
const app = await _electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, NODEBOARD_DESKTOP_DATA_DIR: join(output, 'user-data') }, timeout: 30000 });
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '作品集更新', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  // Both themes are worth a look: the palette is defined twice and only one half shows at a time.
  for (const theme of ['light', 'dark']) {
    await page.getByLabel(theme === 'light' ? '切换到浅色模式' : '切换到深色模式').click().catch(() => {});
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    await page.screenshot({ path: join(output, `01-overview-${theme}.png`) });
    // Scope to the canvas node: once the inspector is open the same heading exists twice.
    await page.getByTestId('rf__node-n-visual').getByRole('heading', { name: '搭建视觉方向' }).click();
    await page.getByLabel('节点详情', { exact: true }).waitFor();
    await page.screenshot({ path: join(output, `02-inspector-${theme}.png`) });
  }
  await writeFile(join(output, 'initial-state.txt'), await page.locator('body').innerText());
  console.log(JSON.stringify({ url: page.url(), contentSize: page.viewportSize(), output }));
} finally { await app.close(); }
