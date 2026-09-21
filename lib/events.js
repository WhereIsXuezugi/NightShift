// Server-sent events hub: pushes job updates and live output to open browser tabs.
export class Events {
  constructor() {
    this.clients = new Set();
    setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 25000).unref();
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  send(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(msg);
  }
}

// Push a notification to your phone/desktop. Works with ntfy.sh (or any self-hosted
// ntfy), Discord webhooks, Slack webhooks, and anything that accepts a plain POST.
export async function notify(url, title, body) {
  if (!url) return { ok: false, skipped: true };
  try {
    let res;
    if (/discord(app)?\.com\/api\/webhooks/.test(url)) {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }),
      });
    } else if (/hooks\.slack\.com/.test(url)) {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `*${title}*\n${body}`.slice(0, 3000) }),
      });
    } else {
      // ntfy-style: plain text body, title in a header (header must be latin-1 safe)
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', Title: title.replace(/[^\x20-\x7E]/g, '') },
        body: body.slice(0, 4000),
      });
    }
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.warn('[notify] failed:', e.message);
    return { ok: false, error: e.message };
  }
}
