import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { AttioClient } from '../src/client.ts';
import { prepareObjectHelp } from '../src/object-metadata.ts';
import { register as registerDeals } from '../src/commands/deals.ts';
import { register as registerUsers } from '../src/commands/users.ts';
import { register as registerWorkspaces } from '../src/commands/workspaces.ts';
import { register as registerRecords } from '../src/commands/records.ts';
import { register as registerConfig } from '../src/commands/config.ts';
import { register as registerAttributes } from '../src/commands/attributes.ts';
import { register as registerLists } from '../src/commands/lists.ts';
import { register as registerNotes } from '../src/commands/notes.ts';
import { register as registerThreads } from '../src/commands/threads.ts';
import { register as registerComments } from '../src/commands/comments.ts';
import { createProgram, installFetchMock } from './cli-test-helpers.ts';

const objects = [
  { api_slug: 'deals', singular_noun: 'Opportunity', plural_noun: 'Opportunities', id: { object_id: 'obj_deals' } },
  { api_slug: 'users', singular_noun: 'Lead', plural_noun: 'Leads', id: { object_id: 'obj_users' } },
  { api_slug: 'workspaces', singular_noun: 'Account', plural_noun: 'Accounts', id: { object_id: 'obj_workspaces' } },
];
const record = { id: { object_id: 'obj_deals', record_id: 'rec_1' }, values: { name: [{ value: 'Example' }] } };

function program(): Command {
  return createProgram([registerDeals, registerUsers, registerWorkspaces, registerRecords, registerConfig,
    registerAttributes, registerLists, registerNotes, registerThreads, registerComments]);
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const cli = program();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values) => { stdout.push(values.join(' ')); };
  console.error = (...values) => { stderr.push(values.join(' ')); };
  cli.configureOutput({ writeOut: value => { stdout.push(value); }, writeErr: value => { stderr.push(value); } });
  const argv = ['--api-key', 'test-key', ...args];
  try {
    await prepareObjectHelp(cli, argv);
    await cli.parseAsync(argv, { from: 'user' });
  } catch (error: any) {
    if (!['commander.helpDisplayed', 'commander.help'].includes(error?.code)) throw error;
  } finally {
    console.log = log;
    console.error = error;
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

test('root and nested help use renamed nouns, keeping command names and slugs', async () => {
  const mock = installFetchMock(() => ({ body: { data: objects } }));
  try {
    const root = await run(['--help']);
    assert.match(root.stdout, /deals.*Manage Opportunities \(API slug: deals\)/);
    assert.match(root.stdout, /users.*Manage Leads \(API slug: users\)/);
    assert.match(root.stdout, /workspaces.*Manage Accounts \(API slug: workspaces\)/);
    for (const args of [['deals', '--help'], ['help', 'deals'], ['deals']]) {
      const result = await run(args);
      assert.match(result.stdout + result.stderr, /List Opportunities/);
      assert.match(result.stdout + result.stderr, /Create Opportunity/);
      assert.match(result.stdout + result.stderr, /attio deals/);
    }
    assert.ok(mock.calls.every(call => call.url.endsWith('/objects') && call.method === 'GET'));
  } finally { mock.restore(); }
});

test('help respects key overrides without leaking names between workspaces', async () => {
  const original = globalThis.fetch;
  const authorizations: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const authorization = new Headers(init?.headers).get('Authorization')!;
    authorizations.push(authorization);
    const plural = authorization === 'Bearer first' ? 'Opportunities' : 'Projects';
    return new Response(JSON.stringify({ data: [{ ...objects[0], plural_noun: plural }] }));
  };
  try {
    const first = program();
    await prepareObjectHelp(first, ['deals', '--help', '--api-key=first']);
    const second = program();
    await prepareObjectHelp(second, ['--api-key', 'second', '--help']);
    assert.match(first.helpInformation(), /Opportunities/);
    assert.match(second.helpInformation(), /Projects/);
    assert.doesNotMatch(second.helpInformation(), /Opportunities/);
    assert.deepEqual(authorizations, ['Bearer first', 'Bearer second']);
    assert.equal(first.opts().apiKey, undefined);
  } finally { globalThis.fetch = original; }
});

test('table records use workspace labels but CRUD routes retain standard slugs', async () => {
  const mock = installFetchMock((url) => ({
    body: { data: url.endsWith('/objects') ? objects : url.endsWith('/query') ? [record] : record },
  }));
  try {
    for (const [slug, plural, singular] of [['deals', 'Opportunities', 'Opportunity'], ['users', 'Leads', 'Lead'], ['workspaces', 'Accounts', 'Account']]) {
      assert.match((await run([slug, 'list', '--table'])).stdout, new RegExp(`${plural} \\(${slug}\\)`));
      for (const args of [['get', 'rec_1'], ['create', '--set', 'name=Example'], ['update', 'rec_1', '--set', 'name=Example'], ['assert', '--match', 'name', '--set', 'name=Example']]) {
        assert.match((await run([slug, ...args, '--table'])).stdout, new RegExp(`${singular} \\(${slug}\\)`));
      }
      await run([slug, 'delete', 'rec_1', '--yes']);
      const requests = mock.calls.filter(call => call.url.includes(`/objects/${slug}/records`));
      for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
        assert.ok(requests.some(call => call.method === method), `${slug} ${method}`);
      }
    }
    assert.ok(mock.calls.every(call => !/objects\/(Opportunities|Opportunity|Leads|Lead|Accounts|Account)/i.test(call.url)));
  } finally { mock.restore(); }
});

test('JSON, CSV and quiet output avoid metadata and preserve payloads', async () => {
  const mock = installFetchMock(() => ({ body: { data: [record] } }));
  try {
    assert.deepEqual(JSON.parse((await run(['deals', 'list', '--json'])).stdout), [record]);
    assert.equal((await run(['deals', 'list', '--quiet'])).stdout, 'rec_1');
    assert.doesNotMatch((await run(['deals', 'list', '--csv'])).stdout, /Opportunit/);
    assert.equal(mock.calls.length, 3);
    assert.ok(mock.calls.every(call => call.url.endsWith('/objects/deals/records/query')));
  } finally { mock.restore(); }
});

test('search displays object names, sends slug scopes, and reuses discovery', async () => {
  const mock = installFetchMock(url => ({ body: { data: url.endsWith('/objects') ? objects : [record] } }));
  try {
    assert.match((await run(['records', 'search', 'Example', '--table'])).stdout, /Opportunities \(deals\)/);
    assert.equal(mock.calls.filter(call => call.url.endsWith('/objects')).length, 1);
    assert.deepEqual(mock.calls.find(call => call.method === 'POST')?.body.objects, ['deals', 'users', 'workspaces']);
    mock.calls.length = 0;
    await run(['users', 'search', 'Example', '--json']);
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(mock.calls[0].body.objects, ['users']);
  } finally { mock.restore(); }
});

test('delete confirmation names the renamed object and cancellation sends no DELETE', async () => {
  const mock = installFetchMock(() => ({ body: { data: objects } }));
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    const result = await run(['users', 'delete', 'rec_1']);
    assert.match(result.stderr, /Delete record rec_1 from Leads \(users\)\?/);
    assert.match(result.stderr, /Aborted/);
    assert.ok(mock.calls.every(call => call.method === 'GET'));
  } finally {
    mock.restore();
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
  }
});

test('generated agent guide pairs current display names with immutable API slugs', async () => {
  const mock = installFetchMock(() => ({ body: { data: objects } }));
  try {
    const { stdout } = await run(['config', 'claude-md']);
    assert.match(stdout, /\| Opportunities \| Opportunity \| `deals` \|/);
    assert.match(stdout, /\| Leads \| Lead \| `users` \|/);
    assert.match(stdout, /attio deals list/);
    assert.match(stdout, /Always use API slugs/);
    assert.equal(mock.calls.length, 1);
  } finally { mock.restore(); }
});

for (const status of [403, 429, 500]) {
  test(`metadata ${status} falls back without retries or blocking record output`, async () => {
    const mock = installFetchMock(url => url.endsWith('/objects')
      ? { status, headers: { 'retry-after': '60' }, body: { message: 'Unavailable' } }
      : { body: { data: [record] } });
    try {
      const help = await run(['deals', '--help']);
      assert.match(help.stdout, /List deals/);
      const table = await run(['deals', 'list', '--table']);
      assert.match(table.stdout, /^deals\n/);
      assert.match(table.stdout, /rec_1/);
      assert.equal(mock.calls.filter(call => call.url.endsWith('/objects')).length, 2);
    } finally { mock.restore(); }
  });
}

test('offline and malformed metadata keep help usable', async () => {
  const mock = installFetchMock(() => { throw new Error('Offline'); });
  try { assert.match((await run(['users', '--help'])).stdout, /List users/); }
  finally { mock.restore(); }
  const malformed = installFetchMock(() => ({ body: { data: [null, { api_slug: 'deals' }] } }));
  try { assert.match((await run(['deals', '--help'])).stdout, /List deals/); }
  finally { malformed.restore(); }
});

test('name discovery strips terminal controls and escapes Markdown table cells', async () => {
  const mock = installFetchMock(() => ({ body: { data: [{ ...objects[0], plural_noun: '\u001b[31mSales | `Pipeline`\nNorth\u001b[0m' }] } }));
  try {
    const help = await run(['--help']);
    assert.doesNotMatch(help.stdout, /\u001b\[31m/);
    const snippet = await run(['config', 'claude-md']);
    assert.match(snippet.stdout, /Sales \\\| &#96;Pipeline&#96; North/);
  } finally { mock.restore(); }
});

test('request timeout remains active until response body finishes', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    },
  }));
  try {
    await assert.rejects(new AttioClient('test-key').get('/objects', { timeoutMs: 20, maxRetries: 0 }), /Request timed out/);
  } finally { globalThis.fetch = original; }
});

test('related tables display object names while request filters and note payloads retain slugs', async () => {
  const item = { id: { note_id: 'note_1', list_id: 'list_1', thread_id: 'thread_1' }, parent_object: 'users', record: { object: 'users' }, title: 'Example' };
  const mock = installFetchMock((url, method) => ({ body: {
    data: url.endsWith('/objects') ? objects
      : /\/attributes|\/lists$|\/notes\?|\/threads\?/.test(url) ? [item] : item,
  } }));
  try {
    for (const args of [
      ['attributes', 'list', 'users'], ['lists', 'list'], ['lists', 'get', 'list_1'],
      ['notes', 'list', '--object', 'users'], ['notes', 'get', 'note_1'],
      ['notes', 'create', '--object', 'users', '--record', 'rec_1', '--title', 'Example', '--content', 'Text'],
      ['threads', 'list', '--object', 'users', '--record', 'rec_1'], ['threads', 'get', 'thread_1'],
      ['comments', 'list', '--object', 'users', '--record', 'rec_1'],
    ]) {
      assert.match((await run([...args, '--table'])).stdout, /Lead[s]? \(users\)/);
    }
    assert.equal(mock.calls.find(call => call.method === 'POST')?.body.data.parent_object, 'users');
    assert.ok(mock.calls.some(call => call.url.includes('parent_object=users')));
    assert.ok(mock.calls.some(call => call.url.includes('object=users')));
    mock.calls.length = 0;
    const raw = await run(['notes', 'get', 'note_1', '--json']);
    assert.equal(JSON.parse(raw.stdout).parent_object, 'users');
    assert.equal(mock.calls.length, 1);
  } finally { mock.restore(); }
});

test('list tables support multiple parent object slugs without changing JSON', async () => {
  const list = { id: { list_id: 'list_1' }, parent_object: ['deals', 'users'] };
  const mock = installFetchMock(url => ({ body: { data: url.endsWith('/objects') ? objects : [list] } }));
  try {
    const table = await run(['lists', 'list', '--table']);
    assert.match(table.stdout, /Opportunities \(deals\)/);
    assert.match(table.stdout, /Leads \(users\)/);
    assert.deepEqual(JSON.parse((await run(['lists', 'list', '--json'])).stdout), [list]);
  } finally { mock.restore(); }
});

test('version and literal help arguments do not trigger metadata requests', async () => {
  const mock = installFetchMock(() => ({ body: { data: objects } }));
  try {
    const cli = program().version('0.3.1');
    await prepareObjectHelp(cli, ['--version']);
    await prepareObjectHelp(cli, ['records', 'search', '--', '--help']);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});
