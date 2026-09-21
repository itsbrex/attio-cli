import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttioClient } from '../src/client.ts';
import { exportWorkspace } from '../src/export.ts';
import { installFetchMock } from './cli-test-helpers.ts';

const object = { api_slug: 'people', id: { object_id: 'people-object', workspace_id: 'workspace' } };
const record = { id: { ...object.id, record_id: 'record' }, values: { name: [{ value: 'Example' }] } };
const options = (directory: string) => ({ directory, objects: ['people'], include: ['records'] as const });

test('a process killed after a durable page resumes its checkpoint and reclaims its dead lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attio-crash-'));
  const source = `
    import { exportWorkspace } from ${JSON.stringify(new URL('../src/export.ts', import.meta.url).href)};
    import { AttioClient } from ${JSON.stringify(new URL('../src/client.ts', import.meta.url).href)};
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/objects')) return new Response(JSON.stringify({ data: [${JSON.stringify(object)}] }));
      const body = JSON.parse(init.body);
      if (body.offset === 1) {
        process.send('checkpoint-saved');
        await new Promise(resolve => setTimeout(resolve, 60000));
      }
      return new Response(JSON.stringify({ data: body.offset ? [] : [${JSON.stringify(record)}] }));
    };
    await exportWorkspace(new AttioClient('test'), ${JSON.stringify(options(root))});
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Child did not reach its checkpoint: ${stderr}`)), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('message', message => {
        clearTimeout(timeout);
        if (message !== 'checkpoint-saved') reject(new Error('Unexpected checkpoint signal'));
        else resolve();
      });
    });
    child.kill('SIGKILL');
    assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' });
    assert.equal(JSON.parse(await readFile(join(root, '.export.lock'), 'utf8')).pid, child.pid);
    const mock = installFetchMock((url, _method, body) => ({ body: url.endsWith('/objects') ? { data: [object] } : { data: body.offset ? [] : [record] } }));
    try {
      const result = await exportWorkspace(new AttioClient('test'), { ...options(root), include: ['records'], resume: true });
      assert.equal(result.status, 'complete');
      assert.equal(mock.calls.filter(call => call.body?.offset === 0 && call.body?.sorts[0].direction === 'asc').length, 0);
      assert.deepEqual(JSON.parse(await readFile(join(root, 'people.json'), 'utf8')), [record]);
    } finally { mock.restore(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});

test('new exports preserve existing directories and legacy manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attio-existing-'));
  const legacy = JSON.stringify({ schema: 'attio-workspace-export/v1', existing: true });
  await writeFile(join(root, 'manifest.json'), legacy);
  const mock = installFetchMock(() => { throw new Error('Should not contact API'); });
  try {
    await assert.rejects(exportWorkspace(new AttioClient('test'), { ...options(root), include: ['records'] }), /not empty/);
    await assert.rejects(exportWorkspace(new AttioClient('test'), { ...options(root), include: ['records'], resume: true }), /Unsupported export manifest/);
    assert.equal(await readFile(join(root, 'manifest.json'), 'utf8'), legacy);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('missing or looping cursors fail exports instead of marking empty file lists complete', async () => {
  for (const pagination of [undefined, { next_cursor: 'again' }]) {
    const root = await mkdtemp(join(tmpdir(), 'attio-cursor-'));
    const mock = installFetchMock((url, method, body) => ({ body: url.endsWith('/objects') ? { data: [object] }
      : method === 'POST' ? { data: body.offset ? [] : [record] } : { data: [], pagination } }));
    try {
      const result = await exportWorkspace(new AttioClient('test'), { directory: root, objects: ['people'], include: ['records', 'files'] });
      assert.equal(result.status, 'incomplete');
      assert.equal(result.resources.files.status, 'failed');
      assert.match(result.resources.files.error!, /pagination/);
      await assert.rejects(readFile(join(root, 'files.json')), { code: 'ENOENT' });
    } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
  }
});
