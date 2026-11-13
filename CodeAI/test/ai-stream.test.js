const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readOpenAICompatibleResponse } = require('../ai-stream');

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

test('streams partial Qwen output as SSE chunks arrive', async () => {
  const updates = [];
  const result = await readOpenAICompatibleResponse(streamResponse([
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n'
  ]), text => updates.push(text));

  assert.equal(result.text, 'Hello world');
  assert.deepEqual(updates, ['Hello', ' world']);
});

test('supports local servers that return a regular JSON response', async () => {
  const updates = [];
  const response = new Response(JSON.stringify({ choices: [{ message: { content: 'Finished answer' } }] }), {
    headers: { 'content-type': 'application/json' }
  });
  const result = await readOpenAICompatibleResponse(response, text => updates.push(text));

  assert.equal(result.text, 'Finished answer');
  assert.deepEqual(updates, ['Finished answer']);
});

test('returns a readable local server error', async () => {
  const response = new Response(JSON.stringify({ error: { message: 'Model is not loaded' } }), {
    status: 503,
    headers: { 'content-type': 'application/json' }
  });
  const result = await readOpenAICompatibleResponse(response, () => {});

  assert.match(result.error, /Model is not loaded/);
});
