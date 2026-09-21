import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttioClient } from '../src/client.ts';
import { fileDigest } from '../src/export-store.ts';

test('file download streams bytes and never sends API credentials to signed redirects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attio-download-')); const original = globalThis.fetch;
  const calls: Array<{ url: string; auth: string | null; redirect?: RequestRedirect }> = [];
  globalThis.fetch = async (input, init) => {
    const url = input.toString(); calls.push({ url, auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    if (calls.length === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
    if (url.includes('api.attio.com')) return new Response(null, { status: 302, headers: { location: 'https://storage.example/file?signature=secret' } });
    if (url.includes('storage.example')) return new Response(null, { status: 307, headers: { location: 'https://cdn.example/file' } });
    return new Response(new Uint8Array([0, 255, 17, 65]), { headers: { 'content-length': '4' } });
  };
  try {
    const output = join(root, 'file.bin');
    const result = await new AttioClient('private-token').downloadFile('file-id', output);
    assert.deepEqual(result, await fileDigest(output));
    assert.deepEqual([...await readFile(output)], [0, 255, 17, 65]);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(calls.map(call => call.auth), ['Bearer private-token', 'Bearer private-token', null, null]);
    assert.ok(calls.every(call => call.redirect === 'manual'));
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});

test('file download refuses unsafe redirects and detects truncated payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attio-download-')); const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://storage.example/file' } });
    await assert.rejects(new AttioClient('test').downloadFile('file-id', join(root, 'unsafe')), /Unsafe file download redirect/);
    globalThis.fetch = async () => new Response('short', { headers: { 'content-length': '100' } });
    await assert.rejects(new AttioClient('test').downloadFile('file-id', join(root, 'short')), /length mismatch/);
    await assert.rejects(readFile(join(root, 'short')), { code: 'ENOENT' });
    globalThis.fetch = async () => new Response(JSON.stringify({ type: 'auth_error', message: 'file:read required' }), { status: 403 });
    await assert.rejects(new AttioClient('test').downloadFile('file-id', join(root, 'blocked')), /file:read required/);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});
