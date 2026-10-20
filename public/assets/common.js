/* 各页面共用的小工具（无构建、无框架）。 */
(function (global) {
  async function api(method, url, body, opts = {}) {
    const init = { method, headers: { 'X-VL': '1' }, credentials: 'same-origin' };
    if (body instanceof Blob) {
      init.headers['Content-Type'] = body.type;
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      throw Object.assign(new Error('网络异常，请检查连接后重试'), { status: 0 });
    }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    if (res.status === 401 && opts.redirectOn401 !== false && !location.pathname.startsWith('/admin/login')) {
      location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname + location.search);
      throw Object.assign(new Error('未登录'), { status: 401 });
    }
    if (!res.ok) throw Object.assign(new Error(data?.error || `请求失败（${res.status}）`), { status: res.status });
    return data;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let toastTimer;
  function toast(msg, type = 'info') {
    let el = $('#vl-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vl-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = `show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ''), 2600);
  }

  /**
   * 订阅后台事件流，断线由浏览器自动重连。
   * 浏览器对同一站点最多 6 条 HTTP/1.1 连接，每个后台/大屏标签页的事件流各占一条且不释放，
   * 标签页一多其他请求就会排队。优先经 SharedWorker 让所有标签页共用一条连接；
   * 不支持时退回每页一条，并在标签页隐藏 5 秒后断开。断线重连或重新可见时调用 onResync 补齐数据。
   */
  function subscribe(handlers, opts = {}) {
    if (typeof SharedWorker === 'function') {
      try {
        return subscribeShared(handlers, opts);
      } catch {
        /* 退回每页一条连接 */
      }
    }
    return subscribeDirect(handlers, opts);
  }

  function subscribeShared(handlers, { onOpen, onError, onResync } = {}) {
    const worker = new SharedWorker('/assets/sse-worker.js', { name: 'vl-sse' });
    let hadError = false;
    worker.port.onmessage = (e) => {
      const m = e.data;
      if (m.kind === 'event') {
        handlers[m.type]?.(m.data ? JSON.parse(m.data) : {});
      } else if (m.kind === 'open') {
        onOpen?.();
        if (hadError) onResync?.();
        hadError = false;
      } else if (m.kind === 'error') {
        hadError = true;
        onError?.();
      }
    };
    worker.port.start();
    addEventListener('pagehide', () => worker.port.postMessage('bye'));
    addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      worker.port.postMessage('hi');
      onResync?.();
    });
  }

  function subscribeDirect(handlers, { onOpen, onError, onResync } = {}) {
    let es = null;
    let hideTimer;
    function open() {
      es = new EventSource('/api/admin/stream');
      for (const [type, fn] of Object.entries(handlers)) {
        es.addEventListener(type, (e) => fn(e.data ? JSON.parse(e.data) : {}));
      }
      if (onOpen) es.onopen = onOpen;
      if (onError) es.onerror = onError;
    }
    document.addEventListener('visibilitychange', () => {
      clearTimeout(hideTimer);
      if (document.hidden) {
        hideTimer = setTimeout(() => {
          es?.close();
          es = null;
        }, 5000);
      } else if (!es) {
        open();
        onResync?.();
      }
    });
    // 在后台打开的标签页从未可见过，不会触发 visibilitychange，等首次可见时再连
    if (!document.hidden) open();
  }

  global.VL = { api, esc, $, $$, toast, subscribe };
})(window);
