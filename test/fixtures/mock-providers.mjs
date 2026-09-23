import http from 'node:http';

/**
 * A stand-in for every chat API, so tests never touch the network.
 * Anthropic's first call answers 429 with retry-after, which is how the
 * "wait for the reset" path gets exercised.
 */
export function startMockProviders({ anthropicLimitOnce = false, retryAfter = 3 } = {}) {
  const calls = [];
  const webhooks = [];
  let anthropicCalls = 0;

  const sse = (res, chunks) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.end();
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      const json = body ? JSON.parse(body) : null;
      if (req.method === 'POST' && !p.startsWith('/webhook')) calls.push({ path: p, body: json });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

      // ----- webhook sink -----
      if (p === '/webhook') { webhooks.push(json); return send(200, { ok: true }); }

      // ----- Anthropic -----
      if (p === '/anthropic/v1/models') return send(200, { data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }], has_more: false });
      if (p === '/anthropic/v1/messages') {
        anthropicCalls++;
        if (anthropicLimitOnce && anthropicCalls === 1) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfter) });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }));
        }
        const text = `claude reply to: ${lastText(json.messages)}`;
        return sse(res, [
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
          { type: 'message_stop' },
        ]);
      }

      // ----- OpenAI -----
      if (p === '/openai/models') return send(200, { data: [{ id: 'gpt-test' }] });
      if (p === '/openai/chat/completions') {
        if (json.reasoning_effort === 'bogus') return send(400, { error: { message: "Unsupported value for 'reasoning_effort'" } });
        const text = `openai reply to: ${lastText(json.messages)}`;
        return sse(res, [
          { choices: [{ delta: { content: text } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } },
        ]);
      }

      // ----- Gemini -----
      if (p === '/gemini/models') return send(200, { models: [{ name: 'models/gemini-test', displayName: 'Gemini Test', supportedGenerationMethods: ['generateContent'] }] });
      if (p.startsWith('/gemini/models/') && p.endsWith(':streamGenerateContent')) {
        const text = `gemini reply to: ${lastGeminiText(json.contents)}`;
        return sse(res, [
          { candidates: [{ content: { parts: [{ text }] } }] },
          { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 } },
        ]);
      }
      // ----- Ollama (native API, newline-delimited JSON) -----
      if (p === '/ollama/api/tags') {
        return send(200, { models: [
          { name: 'llama-test:latest', model: 'llama-test:latest', size: 2e9, modified_at: '2026-09-01T10:00:00Z', details: { parameter_size: '3B', quantization_level: 'Q4_K_M' } },
          { name: 'no-think:latest', model: 'no-think:latest', size: 1e9, modified_at: '2026-08-01T10:00:00Z', details: {} },
        ] });
      }
      if (p === '/ollama/api/chat') {
        if (json.think !== undefined && json.model.startsWith('no-think')) return send(400, { error: `"${json.model}" does not support thinking` });
        if (json.model === 'missing') return send(404, { error: "model 'missing' not found" });
        const last = json.messages[json.messages.length - 1];
        const text = `ollama reply to: ${last.content}${last.images?.length ? ` (+${last.images.length} image)` : ''}`;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const half = Math.ceil(text.length / 2);
        res.write(JSON.stringify({ model: json.model, message: { role: 'assistant', content: text.slice(0, half) }, done: false }) + '\n');
        res.write(JSON.stringify({ model: json.model, message: { role: 'assistant', content: text.slice(half) }, done: false }) + '\n');
        res.write(JSON.stringify({ model: json.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 5 }) + '\n');
        return res.end();
      }
      if (p === '/ollama/api/pull') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', completed: 50, total: 100 }) + '\n');
        res.write(JSON.stringify({ status: 'success' }) + '\n');
        return res.end();
      }
      send(404, { error: `no mock route for ${p}` });
    });
  });

  const lastText = messages => {
    const last = messages[messages.length - 1];
    const c = last.content;
    return typeof c === 'string' ? c : c.filter(b => b.type === 'text').map(b => b.text).join(' ');
  };
  const lastGeminiText = contents => (contents[contents.length - 1].parts || []).filter(p => p.text).map(p => p.text).join(' ');

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        base: `http://127.0.0.1:${port}`,
        calls,
        webhooks,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}
