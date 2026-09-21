import assert from 'node:assert/strict';
import test from 'node:test';
import { register as registerConfig } from '../src/commands/config.ts';
import { register as registerRecords } from '../src/commands/records.ts';
import { createProgram, installFetchMock } from './cli-test-helpers.ts';

async function output(args: string[]): Promise<string> {
  const cli = createProgram([registerConfig, registerRecords]);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...values) => { lines.push(values.join(' ')); };
  try {
    await cli.parseAsync(['--api-key', 'test-key', ...args], { from: 'user' });
    return lines.join('\n');
  } finally {
    console.log = log;
  }
}

for (const compact of [false, true]) {
  test(`${compact ? 'compact' : 'full'} guide uses live slugs and requires explicit authorization`, async () => {
    const mock = installFetchMock(() => ({ body: { data: [
      { api_slug: 'users', singular_noun: 'Lead', plural_noun: 'Leads' },
      { api_slug: 'custom_pipeline', singular_noun: 'Deal', plural_noun: 'Pipeline' },
    ] } }));
    try {
      const text = await output(['config', 'claude-md', ...(compact ? ['--compact'] : [])]);
      assert.match(text, /\| Leads \| Lead \| `users` \|/);
      assert.match(text, /\| Pipeline \| Deal \| `custom_pipeline` \|/);
      assert.match(text, /Always use API slugs in commands, API paths, filters, and record references/);
      assert.match(text, /writes require explicit user authorization/);
      assert.match(text, /only after the user explicitly authorizes the exact target and scope/);
      assert.match(text, /attio records search <query>.*--object <api-slug>/);
      assert.doesNotMatch(text, /Always pass `--yes`|search <object> <query>/);
      assert.equal(mock.calls.length, 1);
      assert.ok(mock.calls.every(call => call.method === 'GET' && call.url.endsWith('/objects')));
      if (compact) {
        assert.match(text, /attio <group> <command> --help/);
        assert.match(text, /attio config claude-md --compact/);
      }
    } finally { mock.restore(); }
  });
}

test('guide search example parses with query first and repeatable API-slug options', async () => {
  const mock = installFetchMock(() => ({ body: { data: [] } }));
  try {
    await output(['--json', 'records', 'search', 'Example query', '--object', 'users', '--object', 'custom_pipeline']);
    assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].url.endsWith('/objects/records/search'));
    assert.equal(mock.calls[0].method, 'POST');
    assert.equal(mock.calls[0].body.query, 'Example query');
    assert.deepEqual(mock.calls[0].body.objects, ['users', 'custom_pipeline']);
  } finally { mock.restore(); }
});

test('compact guide remains usable offline without inventing display-name mappings', async () => {
  const mock = installFetchMock(() => { throw new Error('Offline'); });
  try {
    const text = await output(['config', 'claude-md', '--compact']);
    assert.match(text, /Always use API slugs/);
    assert.match(text, /attio objects list/);
    assert.match(text, /attio <group> <command> --help/);
    assert.doesNotMatch(text, /\| Display name \|/);
  } finally { mock.restore(); }
});
