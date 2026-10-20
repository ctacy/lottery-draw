(function () {
  const { api, esc, $, toast } = VL;
  const show = (id) => ['loading', 'closed', 'form', 'done'].forEach((k) => ($('#' + k).hidden = k !== id));
  let pollTimer;
  // 活动码来自二维码 /m/?e=xxx；旧二维码不带活动码时由服务端按唯一进行中的活动处理
  const code = new URLSearchParams(location.search).get('e');
  let q = code ? `?e=${encodeURIComponent(code)}` : '';

  function renderDone(me) {
    $('#doneName').textContent = me.name;
    $('#doneMeta').textContent = [me.dept, me.phone].filter(Boolean).join(' · ');
    $('#wins').innerHTML = me.wins
      .map(
        (w) => `<div class="win"><b>恭喜中奖：${esc(w.prizeName)}</b>请到领奖处凭本页面领奖
          ${w.image ? `<br><img src="${esc(w.image)}" alt="">` : ''}</div>`
      )
      .join('');
    show('done');
    // 签到后低频轮询，中奖时手机端也能看到
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, 30000);
  }

  async function refresh() {
    if (document.hidden) {
      pollTimer = setTimeout(refresh, 30000);
      return;
    }
    try {
      renderDone(await api('GET', '/api/public/me' + q));
    } catch {
      pollTimer = setTimeout(refresh, 30000);
    }
  }

  async function init() {
    let ev;
    try {
      ev = await api('GET', '/api/public/event' + q);
    } catch (e) {
      $('#loading').textContent = e.message + '，请下拉刷新';
      return;
    }
    // 旧链接解析出活动后固定活动码，之后新开其他活动也不影响本页轮询
    if (!code) {
      q = `?e=${encodeURIComponent(ev.code)}`;
      history.replaceState(null, '', location.pathname + q);
    }
    document.title = `${ev.eventTitle} · 签到`;
    $('#title').textContent = ev.eventTitle;
    $('#deptRow').hidden = !ev.collectDept;
    $('#modeTip').hidden = ev.signinMode !== 'whitelist';

    try {
      return renderDone(await api('GET', '/api/public/me' + q));
    } catch {
      /* 未签到 */
    }
    if (ev.archived) {
      $('#closedTitle').textContent = '活动已结束';
      $('#closedTip').textContent = '感谢参与';
    }
    show(ev.signinOpen ? 'form' : 'closed');
  }

  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#name').value.trim();
    const phone = $('#phone').value.trim();
    if (!name) return toast('请填写姓名', 'error');
    if (!/^1[3-9]\d{9}$/.test(phone)) return toast('请输入正确的 11 位手机号', 'error');
    const btn = $('#submit');
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const me = await api('POST', '/api/public/signin' + q, { name, phone, dept: $('#dept').value.trim() });
      toast('签到成功', 'ok');
      renderDone(me);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '签到';
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('#done').hidden) refresh();
  });

  init();
})();
