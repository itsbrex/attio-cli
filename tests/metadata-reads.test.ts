import assert from 'node:assert/strict';
import test from 'node:test';
import { register as attributes } from '../src/commands/attributes.ts';
import { register as members } from '../src/commands/members.ts';
import { register as comments } from '../src/commands/comments.ts';
import { createProgram, installFetchMock } from './cli-test-helpers.ts';

async function run(args: string[]): Promise<string> {
  const program = createProgram([attributes, members, comments]);
  program.configureOutput({ writeErr: () => undefined });
  const output: string[] = []; const original = console.log;
  console.log = (...values) => { output.push(values.join(' ')); };
  try { await program.parseAsync(['--api-key', 'test', ...args], { from: 'user' }); }
  finally { console.log = original; }
  return output.join('\n');
}

test('attribute reads support object/list targets and preserve full JSON', async () => {
  const value = { id: { attribute_id: 'attr1' }, api_slug: 'name', config: { untouched: true } };
  const mock = installFetchMock(url => ({ body: { data: url.endsWith('/attributes') ? [value] : value } }));
  try {
    assert.deepEqual(JSON.parse(await run(['--json', 'attributes', 'list', 'people'])), [value]);
    assert.deepEqual(JSON.parse(await run(['--json', 'attributes', 'get', 'list/slug', 'attr/value', '--target', 'lists'])), value);
    assert.equal(new URL(mock.calls[1].url).pathname, '/v2/lists/list%2Fslug/attributes/attr%2Fvalue');
    assert.equal(await run(['--quiet', 'attributes', 'get', 'people', 'name']), 'name');
    assert.match(await run(['--csv', 'attributes', 'get', 'people', 'name']), /^api_slug,title,type,/);
    assert.ok(mock.calls.every(call => call.method === 'GET'));
  } finally { mock.restore(); }
});

test('attributes --all follows short pages and includes archived definitions', async () => {
  const mock = installFetchMock(url => {
    const u = new URL(url); const offset = Number(u.searchParams.get('offset'));
    assert.equal(u.pathname, '/v2/lists/pipeline/attributes');
    assert.equal(u.searchParams.get('show_archived'), 'true');
    return { body: { data: offset < 2 ? [{ api_slug: `field${offset}`, id: { attribute_id: `attr${offset}` }, is_archived: true }] : [] } };
  });
  try {
    const output = JSON.parse(await run(['--json', 'attributes', 'list', 'pipeline', '--target', 'lists', '--all', '--limit', '50', '--show-archived']));
    assert.equal(output.length, 2);
    assert.deepEqual(mock.calls.map(call => new URL(call.url).searchParams.get('offset')), ['0', '1', '2']);
  } finally { mock.restore(); }
});

test('attribute options/statuses use their own IDs in quiet and CSV modes', async () => {
  for (const [command, field] of [['options', 'option_id'], ['statuses', 'status_id']]) {
    const payload = { id: { workspace_id: 'workspace', object_id: 'object', attribute_id: 'attribute', [field]: 'choice1' }, title: 'Choice, one', is_archived: true };
    const mock = installFetchMock(() => ({ body: { data: [payload] } }));
    try {
      const args = ['attributes', command, 'pipeline', 'stage', '--target', 'lists', '--show-archived'];
      assert.deepEqual(JSON.parse(await run(['--json', ...args])), [payload]);
      assert.equal(await run(['--quiet', ...args]), 'choice1');
      assert.equal(await run(['--csv', ...args]), 'id,title,is_archived\nchoice1,"Choice, one",true');
      assert.ok(mock.calls.every(call => call.url.endsWith(`/lists/pipeline/attributes/stage/${command}?show_archived=true`) && call.method === 'GET'));
    } finally { mock.restore(); }
  }
});

test('member and comment gets preserve raw JSON, encode IDs, and emit entity IDs', async () => {
  for (const [command, path, field] of [['members', 'workspace_members', 'workspace_member_id'], ['comments', 'comments', 'comment_id']]) {
    const payload = { id: { workspace_id: 'workspace', [field]: 'entity1' }, content_plaintext: 'Full comment', first_name: 'Name', extra: { untouched: true } };
    const mock = installFetchMock(() => ({ body: { data: payload } }));
    try {
      const args = [command, 'get', 'id/with?characters'];
      assert.deepEqual(JSON.parse(await run(['--json', ...args])), payload);
      assert.equal(await run(['--quiet', ...args]), 'entity1');
      assert.match(await run(['--csv', ...args]), /^id,/);
      assert.ok(mock.calls.every(call => new URL(call.url).pathname === `/v2/${path}/id%2Fwith%3Fcharacters` && call.method === 'GET'));
    } finally { mock.restore(); }
  }
});

test('read commands reject invalid target/pagination and surface permission failures', async () => {
  const mock = installFetchMock(() => ({ status: 403, body: { type: 'auth_error', message: 'Missing read scope' } }));
  try {
    await assert.rejects(run(['attributes', 'list', 'people', '--target', 'wrong']), /Allowed choices/);
    await assert.rejects(run(['attributes', 'list', 'people', '--limit', '-2']), /integer/);
    await assert.rejects(run(['attributes', 'list', 'people', '--offset', '1.5']), /integer/);
    assert.equal(mock.calls.length, 0);
    await assert.rejects(run(['members', 'get', 'member1']), /Missing read scope/);
    await assert.rejects(run(['comments', 'get', 'comment1']), /Missing read scope/);
  } finally { mock.restore(); }
});

test('choice reads default to 100 active choices and report output truncation', async () => {
  const values = [{ id: { option_id: 'archived' }, is_archived: true }, ...Array.from({ length: 101 }, (_, i) => ({ id: { option_id: `choice${i}` }, is_archived: false }))];
  const mock = installFetchMock(() => ({ body: { data: values } }));
  const original = console.error; const errors: string[] = []; console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    const output = JSON.parse(await run(['--json', 'attributes', 'options', 'people', 'stage']));
    assert.equal(output.length, 100); assert.ok(output.every((value: any) => !value.is_archived));
    assert.match(errors.join('\n'), /Showing 100 of 101/);
    const limited = JSON.parse(await run(['--json', 'attributes', 'options', 'people', 'stage', '--limit', '2']));
    assert.equal(limited.length, 2);
  } finally { console.error = original; mock.restore(); }
});
