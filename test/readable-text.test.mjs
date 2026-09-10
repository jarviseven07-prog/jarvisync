import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sourcePath = resolve('src/readable-text.ts');
const run = promisify(execFile);

async function loadParser(t) {
  const output = await mkdtemp(join(tmpdir(), 'nodeboard-readable-text-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await run(process.execPath, [
    resolve('node_modules/typescript/bin/tsc'), sourcePath,
    '--ignoreConfig',
    '--outDir', output,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
  ]);
  return import(pathToFileURL(join(output, 'readable-text.js')).href);
}

test('空行分段、连续列表归类，普通连续行保持原有换行', async t => {
  const { parseReadableText } = await loadParser(t);
  const blocks = parseReadableText('第一行\n第二行\n\n- 一项\n* 二项\n\n1. 第一步\n3. 第三步');
  assert.deepEqual(blocks, [
    { type: 'paragraph', lines: ['第一行', '第二行'] },
    { type: 'list', ordered: false, items: [{ text: '一项' }, { text: '二项' }] },
    { type: 'list', ordered: true, items: [{ text: '第一步', ordinal: 1 }, { text: '第三步', ordinal: 3 }] },
  ]);
});

test('URL、版本号和段落中的编号不被误拆，文字及不可信标记保持普通文本', async t => {
  const { parseReadableText } = await loadParser(t);
  const text = '版本 1.2.3 请保留\nhttps://example.test/v1.2\n说明 2. 仍在同一段\n001. archival label\n<script>alert(1)</script>';
  const blocks = parseReadableText(text);
  assert.deepEqual(blocks, [{ type: 'paragraph', lines: text.split('\n') }]);
  assert.equal(JSON.stringify(blocks).includes('<script>alert(1)</script>'), true);
});

test('只有独立行开头的编号或项目符号才成为列表，内容不会因空列表而消失', async t => {
  const { parseReadableText } = await loadParser(t);
  const blocks = parseReadableText('  12. 有意从十二开始\n- \n* plain\n尾行');
  assert.deepEqual(blocks, [
    { type: 'list', ordered: true, items: [{ text: '有意从十二开始', ordinal: 12 }] },
    { type: 'list', ordered: false, items: [{ text: '' }, { text: 'plain' }] },
    { type: 'paragraph', lines: ['尾行'] },
  ]);
});
