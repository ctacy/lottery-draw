/*
 * 同源所有标签页共用一条后台事件流（SharedWorker）。
 * 浏览器对同一站点最多 6 条 HTTP/1.1 连接，每个后台/大屏标签页各开一条 EventSource 会把其他请求堵住；
 * 由本 Worker 统一维持一条连接，再把事件转发给各标签页。
 */
// 须与服务端 hub.publish 的事件类型保持一致
const TYPES = ['signin', 'draw', 'revoke', 'prizes', 'participants', 'settings', 'reset', 'event', 'events'];
const ports = new Set();
let es = null;
let state = null; // 'open' | 'error'

function broadcast(msg) {
  for (const port of ports) port.postMessage(msg);
}

function ensure() {
  // 401 等致命错误后 EventSource 不再重连（readyState = CLOSED），有新标签页接入时重建
  if (es && es.readyState !== EventSource.CLOSED) return;
  es = new EventSource('/api/admin/stream');
  es.onopen = () => broadcast({ kind: (state = 'open') });
  es.onerror = () => broadcast({ kind: (state = 'error') });
  for (const type of TYPES) es.addEventListener(type, (e) => broadcast({ kind: 'event', type, data: e.data }));
}

self.onconnect = (e) => {
  const port = e.ports[0];
  port.onmessage = (m) => {
    if (m.data === 'bye') {
      ports.delete(port);
      if (!ports.size && es) {
        es.close();
        es = null;
        state = null;
      }
    } else if (m.data === 'hi') {
      // 从往返缓存（bfcache）恢复的页面重新接入
      ports.add(port);
      ensure();
      if (state) port.postMessage({ kind: state });
    }
  };
  port.start();
  ports.add(port);
  ensure();
  if (state) port.postMessage({ kind: state });
};
