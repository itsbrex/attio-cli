import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttioClient } from '../src/client.ts';
import { exportWorkspace, type ExportOptions } from '../src/export.ts';
import { ExportStore, fileDigest } from '../src/export-store.ts';
import { createProgram, installFetchMock, runCli } from './cli-test-helpers.ts';
import { register } from '../src/commands/export.ts';

const object = { api_slug: 'people', id: { object_id: 'obj_people', workspace_id: 'workspace' } };
const record = (id: string) => ({ id: { ...object.id, record_id: id }, created_at: '2026-01-01', values: { name: [{ value: id, active_from: '2026-01-01' }] }, extra: { preserved: true } });
const records = [record('rec1'), record('rec2')];
const json = async (root: string, name: string) => JSON.parse(await readFile(join(root, name), 'utf8'));
async function directory() { return mkdtemp(join(tmpdir(), 'attio-export-')); }
const config = (directory: string, more: Partial<ExportOptions> = {}): ExportOptions => ({ directory, objects: ['people'], include: ['records'], ...more });
function recordPage(body: any, data = records) { return { data: (body.sorts[0].direction === 'asc' ? data : [...data].reverse()).slice(body.offset, body.offset + 1) }; }

test('export follows short pages through empty termination, preserves full payloads, and resumes without re-fetching pages', async () => {
  const root = await directory();
  const mock = installFetchMock((url, _method, body) => ({ body: url.endsWith('/objects') ? { data: [object] } : recordPage(body) }));
  try {
    const result = await exportWorkspace(new AttioClient('test'), config(root));
    assert.equal(result.status, 'complete');
    assert.deepEqual(await json(root, 'people.json'), [...records].reverse());
    assert.deepEqual(result.resources['records:people'].details?.verified_passes, [1, 2]);
    assert.equal(mock.calls.filter(call => call.method === 'POST').length, 6);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'people.json'))).mode & 0o777, 0o600);
    mock.calls.length = 0;
    assert.equal((await exportWorkspace(new AttioClient('test'), config(root, { resume: true }))).status, 'complete');
    assert.deepEqual(mock.calls.map(call => new URL(call.url).pathname), ['/v2/objects']);
    assert.ok(!(await readdir(root)).includes('.export.lock'));
  } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('interrupted export resumes durable pages and does not publish partial record data', async () => {
  const root = await directory(); let broken = true;
  const mock = installFetchMock((url, _method, body) => {
    if (url.endsWith('/objects')) return { body: { data: [object] } };
    if (broken && body.offset === 1) throw new Error('connection lost');
    return { body: recordPage(body) };
  });
  try {
    assert.equal((await exportWorkspace(new AttioClient('test'), config(root))).status, 'incomplete');
    await assert.rejects(readFile(join(root, 'people.json')), { code: 'ENOENT' });
    broken = false;
    assert.equal((await exportWorkspace(new AttioClient('test'), config(root, { resume: true }))).status, 'complete');
    assert.equal(mock.calls.filter(call => call.body?.offset === 0 && call.body?.sorts[0].direction === 'asc').length, 1);
    assert.deepEqual(await json(root, 'people.json'), [...records].reverse());
  } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('export has no 10,000-record cap', async () => {
  const root = await directory(); const many = Array.from({ length: 10001 }, (_, i) => record(`rec${i}`));
  const mock = installFetchMock((url, _method, body) => ({ body: url.endsWith('/objects') ? { data: [object] } : { data: (body.sorts[0].direction === 'asc' ? many : [...many].reverse()).slice(body.offset, body.offset + 500) } }));
  try {
    const result = await exportWorkspace(new AttioClient('test'), config(root));
    assert.equal(result.status, 'complete');
    assert.equal(result.resources['records:people'].outputs[0].count, 10001);
    assert.equal((await json(root, 'people.json')).length, 10001);
  } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('wrong workspace, changed scope, corrupt outputs/checkpoints, and concurrent writers fail closed', async () => {
  const root = await directory(); let workspace = 'workspace';
  const mock = installFetchMock((url, _method, body) => ({ body: url.endsWith('/objects') ? { data: [{ ...object, id: { ...object.id, workspace_id: workspace } }] } : recordPage(body) }));
  try {
    await exportWorkspace(new AttioClient('test'), config(root));
    workspace = 'different';
    await assert.rejects(exportWorkspace(new AttioClient('test'), config(root, { resume: true })), /Workspace, objects, or resource selection changed/);
    workspace = 'workspace';
    await assert.rejects(exportWorkspace(new AttioClient('test'), config(root, { resume: true, include: ['attributes'] })), /resource selection changed/);
    const checkpoint = join(root, '.checkpoints', (await readdir(join(root, '.checkpoints')))[0]);
    const original = await readFile(checkpoint, 'utf8'); const damaged = JSON.parse(original); damaged.sha256 = 'broken';
    await writeFile(checkpoint, JSON.stringify(damaged));
    const corrupt = await exportWorkspace(new AttioClient('test'), config(root, { resume: true }));
    assert.equal(corrupt.status, 'incomplete'); assert.match(corrupt.resources['records:people'].error!, /checksum mismatch/);
    await writeFile(checkpoint, original);
    const store = new ExportStore(root); await store.acquire(true);
    await assert.rejects(exportWorkspace(new AttioClient('test'), config(root, { resume: true })), /already running/);
    await store.release();
    await writeFile(join(root, 'people.json'), '[]');
    await assert.rejects(exportWorkspace(new AttioClient('test'), config(root, { resume: true })), /checksum mismatch/);
  } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('membership disagreement never publishes a falsely complete record file', async () => {
  const root = await directory();
  const mock = installFetchMock((url, _method, body) => ({ body: url.endsWith('/objects') ? { data: [object] } : { data: body.offset ? [] : [record(body.sorts[0].direction === 'asc' ? 'first' : 'second')] } }));
  try {
    const result = await exportWorkspace(new AttioClient('test'), config(root));
    assert.equal(result.status, 'incomplete');
    assert.match(result.resources['records:people'].error!, /did not stabilize/);
    await assert.rejects(readFile(join(root, 'people.json')), { code: 'ENOENT' });
  } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('related export keeps active definitions, capped active choices, notes and files despite email scope denial', async () => {
  const root = await directory();
  const attr = (id: string, type: string) => ({ id: { ...object.id, attribute_id: id }, api_slug: id, type, is_archived: false, config: { preserved: true } });
  const attrs = [attr('selection', 'select'), attr('stage', 'status')];
  const archived = { ...attr('old', 'text'), is_archived: true };
  const note = { id: { workspace_id: 'workspace', note_id: 'note1' }, parent_object: 'obj_people', parent_record_id: 'rec1', content_markdown: '# Full note', content_plaintext: 'Full note', tags: [] };
  const file = { id: { workspace_id: 'workspace', file_id: 'file1' }, object_id: 'obj_people', object_slug: 'people', record_id: 'rec1', file_type: 'file', name: 'report.pdf', content_size: 4 };
  const mock = installFetchMock((url, method, body) => {
    const u = new URL(url); const p = u.pathname;
    if (p === '/v2/objects') return { body: { data: [object] } };
    if (method === 'POST') return { body: recordPage(body) };
    if (p.endsWith('/attributes')) { assert.equal(u.searchParams.get('show_archived'), 'false'); return { body: { data: u.searchParams.get('offset') === '0' ? [...attrs, archived] : [] } }; }
    if (p.endsWith('/options') || p.endsWith('/statuses')) { assert.equal(u.searchParams.get('show_archived'), 'false'); return { body: { data: [{ title: 'Archived choice', is_archived: true }, ...Array.from({ length: 102 }, (_, i) => ({ title: `Choice ${i}`, is_archived: false }))] } }; }
    if (p === '/v2/notes') {
      assert.equal(u.searchParams.has('parent_object'), false);
      return { body: { data: u.searchParams.get('offset') === '0' ? [note, { ...note, id: { ...note.id, note_id: 'unrelated' }, parent_record_id: 'outside' }] : [] } };
    }
    if (p === '/v2/emails') return { status: 403, body: { type: 'auth_error', message: 'email:read required' } };
    if (p === '/v2/files') return { body: { data: u.searchParams.get('record_id') === 'rec1' ? [file] : [], pagination: { next_cursor: null } } };
    throw new Error(`Unexpected ${p}`);
  });
  const client = new AttioClient('test');
  client.downloadFile = async (_id, destination) => { await writeFile(destination, 'file', { mode: 0o600 }); return fileDigest(destination); };
  try {
    const result = await exportWorkspace(client, config(root, { include: ['records', 'attributes', 'notes', 'emails', 'files'] }));
    assert.equal(result.status, 'incomplete'); assert.equal(result.resources.emails.status, 'blocked');
    assert.deepEqual(await json(root, 'notes.json'), [note]);
    assert.deepEqual(await json(root, 'attributes/people.json'), attrs);
    const choices = await json(root, 'attributes/people-choices.json');
    assert.equal(choices.length, 2);
    assert.ok(choices.every((choice: any) => choice.exported_count === 100 && choice.available_count === 102 && choice.truncated));
    assert.ok(choices.flatMap((choice: any) => choice.options ?? choice.statuses).every((choice: any) => !choice.is_archived));
    assert.equal(result.resources['attributes:people'].details?.truncated_attributes, 2);
    await assert.rejects(exportWorkspace(client, config(root, { include: ['records', 'attributes', 'notes', 'emails', 'files'], resume: true, maxChoices: 50 })), /Attribute export policy changed/);
    assert.deepEqual(await json(root, 'files.json'), [file]);
    assert.equal(await readFile(join(root, 'files/file1.bin'), 'utf8'), 'file');
    assert.equal(result.resources.files.details?.records_checked, 2);
    assert.equal(result.resources.files.details?.downloaded, 1);
    assert.ok(mock.calls.every(call => call.method === 'GET' || call.url.endsWith('/records/query')));
    await assert.rejects(readFile(join(root, 'emails.json')), { code: 'ENOENT' });
  } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('cursor exports continue after empty pages and resume failed downloads', async () => {
  const root = await directory(); let broken = true; let emailPages = 0;
  const file = { id: { workspace_id: 'workspace', file_id: 'file1' }, object_id: 'obj_people', record_id: 'rec1', file_type: 'connected-file' };
  const email = { id: { workspace_id: 'workspace', mailbox_id: 'mailbox', email_id: 'email1' }, subject_line: 'Metadata only' };
  const mock = installFetchMock((url, method, body) => {
    const u = new URL(url);
    if (u.pathname === '/v2/objects') return { body: { data: [object] } };
    if (method === 'POST') return { body: recordPage(body) };
    if (u.pathname === '/v2/emails') {
      emailPages++; assert.equal(u.searchParams.get('linked_object'), 'people');
      return { body: { data: u.searchParams.has('cursor') ? [email] : [], pagination: { next_cursor: u.searchParams.has('cursor') ? null : 'next' } } };
    }
    return { body: { data: u.searchParams.get('record_id') === 'rec1' ? [file] : [], pagination: { next_cursor: null } } };
  });
  const client = new AttioClient('test'); let downloadCalls = 0;
  client.downloadFile = async (_id, destination) => { downloadCalls++; if (broken) throw new Error('download interrupted'); await writeFile(destination, 'contents', { mode: 0o600 }); return fileDigest(destination); };
  const opts = config(root, { include: ['records', 'emails', 'files'] });
  try {
    const first = await exportWorkspace(client, opts);
    assert.equal(first.status, 'incomplete'); assert.equal(emailPages, 2);
    assert.deepEqual(await json(root, 'emails.json'), [email]);
    assert.equal((await json(root, 'downloads.json'))[0].status, 'failed');
    broken = false;
    const second = await exportWorkspace(client, { ...opts, resume: true });
    assert.equal(second.status, 'complete'); assert.equal(emailPages, 2); assert.equal(downloadCalls, 2);
    assert.equal((await json(root, 'downloads.json'))[0].status, 'complete');
  } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('CLI export validates resources and exposes resumable JSON output', async () => {
  const root = await directory();
  const mock = installFetchMock((url, _method, body) => ({ body: url.endsWith('/objects') ? { data: [object] } : recordPage(body) }));
  try {
    await assert.rejects(runCli(createProgram([register]), ['export', 'people', '--include', 'unknown', '--dir', root]), /Unknown or empty/);
    assert.equal(mock.calls.length, 0);
    await runCli(createProgram([register]), ['export', 'people', '--include', 'records', '--dir', root]);
    await runCli(createProgram([register]), ['export', 'people', '--include', 'records', '--dir', root, '--resume']);
    assert.equal((await json(root, 'manifest.json')).status, 'complete');
  } finally { mock.restore(); await rm(root, { recursive: true, force: true }); }
});
