import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { prompt } from '../src/prompt.js';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', chunk => written.push(chunk.toString()));
  return { input, output, written };
}

test('resolves with the typed answer instead of rejecting on close', async () => {
  const { input, output } = streams();
  const answer = prompt('key: ', { input, output });
  input.write('secret-key\n');
  assert.equal(await answer, 'secret-key');
});

test('rejects when the stream closes without an answer', async () => {
  const { input, output } = streams();
  const answer = prompt('key: ', { input, output });
  input.end();
  await assert.rejects(answer, /cancelled/);
});

test('masked prompts echo the query but not the answer', async () => {
  const { input, output, written } = streams();
  const answer = prompt('key: ', { input, output, mask: true });
  input.write('secret-key\n');
  assert.equal(await answer, 'secret-key');

  const echoed = written.join('');
  assert.ok(echoed.includes('key: '), 'prompt should still be visible');
  assert.ok(!echoed.includes('secret-key'), 'answer must not be echoed');
});

test('unmasked prompts echo the answer', async () => {
  const { input, output, written } = streams();
  const answer = prompt('name: ', { input, output });
  input.write('acme\n');
  await answer;
  assert.ok(written.join('').includes('acme'));
});
