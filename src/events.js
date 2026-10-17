/** 极简 Server-Sent Events 广播，供大屏与后台实时刷新。 */
export function createEventHub() {
  const clients = new Set();

  function subscribe(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  }

  function publish(type, data = {}) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  function closeAll() {
    for (const res of clients) res.end();
    clients.clear();
  }

  return { subscribe, publish, closeAll, get size() { return clients.size; } };
}
