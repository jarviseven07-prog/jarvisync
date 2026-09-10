const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const desktopShellFiles = ['desktop/JarviSync.exe', 'desktop/assets/jarvisync.ico', 'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/shell-identity.cjs'];
function computeDesktopShellId(root) {
  const hash = createHash('sha256').update('jarvisync-desktop-v1\0');
  for (const path of desktopShellFiles) {
    const file = join(root, path);
    const digest = path === 'desktop/JarviSync.exe' && !existsSync(file)
      ? 'not-built'
      : createHash('sha256').update(readFileSync(file)).digest('hex');
    hash.update(path).update('\0').update(digest).update('\n');
  }
  return hash.digest('hex');
}
module.exports = { computeDesktopShellId, desktopShellFiles };
if (require.main === module) process.stdout.write(computeDesktopShellId(resolve(process.argv[2] || join(__dirname, '..'))) + '\n');
