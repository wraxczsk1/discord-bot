const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeConsecutiveMessages } = require('../chat-utils');

test('merges consecutive user turns after a failed request without reordering chat', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    { role: 'user', content: 'retry question' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'follow-up' }
  ];

  assert.deepEqual(mergeConsecutiveMessages(messages), [
    {
      role: 'user',
      content: [{ type: 'text', text: 'first question' }, { type: 'text', text: 'retry question' }]
    },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'follow-up' }
  ]);
});

test('preserves image and text blocks while merging repeated roles', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data' } };
  assert.deepEqual(mergeConsecutiveMessages([
    { role: 'user', content: [image] },
    { role: 'user', content: [{ type: 'text', text: 'describe this' }] }
  ]), [
    { role: 'user', content: [image, { type: 'text', text: 'describe this' }] }
  ]);
});
