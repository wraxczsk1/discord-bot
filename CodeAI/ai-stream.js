async function readOpenAICompatibleResponse(response, onDelta) {
  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try {
      const error = JSON.parse(body);
      detail = typeof error.error === 'string' ? error.error : error.error && error.error.message || body;
    } catch (parseError) {
      detail = body || `Neplatná chybová odpověď: ${parseError.message}`;
    }
    return { error: `Lokální Qwen: ${detail || `HTTP ${response.status}`}. Zkontroluj, že je model načtený a server má zapnuté OpenAI-compatible API.` };
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') || !response.body || typeof response.body.getReader !== 'function') {
    const result = await response.json();
    const answer = result.choices && result.choices[0] && result.choices[0].message
      ? result.choices[0].message.content
      : '';
    const text = Array.isArray(answer) ? answer.map(part => part.text || '').join('\n') : answer || '';
    if (text) onDelta(text);
    return { text: text || 'Qwen nevrátil textovou odpověď.' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const consumeLine = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    const event = JSON.parse(payload);
    const delta = event.choices && event.choices[0] && event.choices[0].delta
      ? event.choices[0].delta.content
      : '';
    const content = Array.isArray(delta) ? delta.map(part => part.text || '').join('') : delta;
    if (typeof content === 'string' && content) {
      text += content;
      onDelta(content);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
    if (done) {
      if (buffer) consumeLine(buffer);
      break;
    }
  }
  return { text: text || 'Qwen nevrátil textovou odpověď.' };
}

module.exports = { readOpenAICompatibleResponse };
