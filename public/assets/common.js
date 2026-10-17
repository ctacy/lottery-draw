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

  /** 订阅后台事件流，断线由浏览器自动重连。 */
  function subscribe(handlers) {
    const es = new EventSource('/api/admin/stream');
    for (const [type, fn] of Object.entries(handlers)) {
      es.addEventListener(type, (e) => fn(e.data ? JSON.parse(e.data) : {}));
    }
    return es;
  }

  global.VL = { api, esc, $, $$, toast, subscribe };
})(window);
