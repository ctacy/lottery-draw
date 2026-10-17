(function () {
  const { api, $, toast } = VL;
  const next = new URLSearchParams(location.search).get('next');
  // 只允许站内相对路径，防开放重定向
  const target = next && /^\/(?!\/)/.test(next) ? next : '/admin/';

  api('GET', '/api/auth/me', undefined, { redirectOn401: false }).then(() => location.replace(target), () => {});

  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/auth/login', { username: $('#username').value.trim(), password: $('#password').value }, { redirectOn401: false });
      location.replace(target);
    } catch (err) {
      toast(err.message, 'error');
      $('#password').select();
    }
  });
})();
