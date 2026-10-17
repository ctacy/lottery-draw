(function () {
  const { api, esc, $, $$, toast, subscribe } = VL;
  const state = { tab: 'overview', prizes: [], pPage: 1 };

  // ---------- 通用对话框 ----------
  /** fields: [{ name, label, type, value, options, attrs }]；返回表单值或 null（取消）。 */
  function dialog(title, fields, okText = '确定') {
    const dlg = $('#dlg');
    $('#dlgTitle').textContent = title;
    $('#dlgOk').textContent = okText;
    $('#dlgBody').innerHTML = fields
      .map((f) => {
        const v = f.value ?? '';
        if (f.type === 'html') return f.html;
        if (f.type === 'checkbox') {
          return `<label class="check"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
        }
        if (f.type === 'textarea') {
          return `<label>${esc(f.label)}<textarea class="input" name="${f.name}" rows="${f.rows || 6}" ${f.attrs || ''}>${esc(v)}</textarea></label>`;
        }
        if (f.type === 'select') {
          return `<label>${esc(f.label)}<select class="input" name="${f.name}">${f.options
            .map(([val, text]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(text)}</option>`)
            .join('')}</select></label>`;
        }
        return `<label>${esc(f.label)}<input class="input" name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" ${f.attrs || ''}></label>`;
      })
      .join('');
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => {
      dlg.addEventListener(
        'close',
        () => {
          if (dlg.returnValue !== 'ok') return resolve(null);
          const out = {};
          for (const f of fields) {
            const el = $(`[name="${f.name}"]`, dlg);
            if (!el) continue;
            out[f.name] = f.type === 'checkbox' ? el.checked : el.value;
          }
          resolve(out);
        },
        { once: true }
      );
    });
  }

  async function guard(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r;
    } catch (e) {
      if (e.status !== 401) toast(e.message, 'error');
    }
  }

  // ---------- 导航 ----------
  function go(tab) {
    state.tab = tab;
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    $$('[data-panel]').forEach((s) => (s.hidden = s.dataset.panel !== tab));
    history.replaceState(null, '', '#' + tab);
    loaders[tab]?.();
  }
  $('#nav').addEventListener('click', (e) => e.target.dataset.tab && go(e.target.dataset.tab));

  // ---------- 概览 ----------
  async function loadOverview() {
    const o = await api('GET', '/api/admin/overview');
    $('#me').textContent = o.admin.username;
    const s = o.stats;
    const items = [
      ['已签到', s.checkedIn],
      ['名单总数', s.participants],
      ['当前可抽', s.pool],
      ['已中奖', s.winners],
      ['剩余奖品', `${s.prizeRemaining} / ${s.prizeTotal}`],
      ['在线大屏/后台', s.screens],
    ];
    $('#stats').innerHTML = items.map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
    $('#signinUrl').textContent = o.signinUrl;
    $('#openSignin').href = o.signinUrl;
    const qr = '/api/admin/qrcode.svg?text=' + encodeURIComponent(o.signinUrl);
    if ($('#qr').dataset.src !== qr) {
      $('#qr').src = qr;
      $('#qr').dataset.src = qr;
      $('#downloadQr').href = qr;
    }
    $('#lan').innerHTML = o.lan.map((l) => `<li>${esc(l.ifname)}: ${esc(l.address)}</li>`).join('') || '<li>未检测到</li>';
    const f = $('#settings');
    if (!f.contains(document.activeElement)) {
      for (const [k, v] of Object.entries(o.settings)) {
        const el = f.elements[k];
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = v;
        else el.value = v;
      }
    }
  }

  $('#settings').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      eventTitle: f.eventTitle.value,
      signinMode: f.signinMode.value,
      publicBaseUrl: f.publicBaseUrl.value,
      signinOpen: f.signinOpen.checked,
      collectDept: f.collectDept.checked,
      allowRepeatWin: f.allowRepeatWin.checked,
    };
    guard(() => api('PUT', '/api/admin/settings', body).then(loadOverview), '设置已保存');
  });

  // ---------- 奖项 ----------
  async function loadPrizes() {
    state.prizes = await api('GET', '/api/admin/prizes');
    $('#prizeRows').innerHTML =
      state.prizes
        .map(
          (p) => `<tr>
        <td>${p.sort}</td>
        <td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : '<span class="muted small">无</span>'}</td>
        <td><b>${esc(p.name)}</b><div class="muted small">${esc(p.description)}</div></td>
        <td>${p.level}</td><td>${p.quantity}</td><td>${p.won}</td>
        <td>${p.remaining ? `<span class="tag ok">${p.remaining}</span>` : '<span class="tag">已抽完</span>'}</td>
        <td class="ops">
          <button class="btn sm" data-act="img" data-id="${p.id}">上传图片</button>
          <button class="btn sm" data-act="edit" data-id="${p.id}">编辑</button>
          <button class="btn sm danger" data-act="del" data-id="${p.id}">删除</button>
        </td></tr>`
        )
        .join('') || '<tr><td colspan="8" class="muted">还没有奖项，点击「新增奖项」开始</td></tr>';
  }

  const prizeFields = (p = {}) => [
    { name: 'name', label: '奖项名称（如：一等奖 · iPhone）', value: p.name, attrs: 'required maxlength="60"' },
    { name: 'description', label: '奖品描述（选填）', value: p.description, attrs: 'maxlength="200"' },
    { name: 'quantity', label: '数量', type: 'number', value: p.quantity ?? 1, attrs: 'min="1" required' },
    { name: 'level', label: '等级（数字，1=一等奖，0=特等奖）', type: 'number', value: p.level ?? 1, attrs: 'min="0" max="99"' },
    { name: 'sort', label: '排序（越小越靠前）', type: 'number', value: p.sort ?? 0 },
    { name: 'image', label: '图片地址（选填，也可保存后上传）', value: p.image, attrs: 'maxlength="500"' },
  ];

  $('#addPrize').addEventListener('click', async () => {
    const v = await dialog('新增奖项', prizeFields({ sort: (state.prizes.at(-1)?.sort ?? 0) + 1 }));
    if (v) guard(() => api('POST', '/api/admin/prizes', v).then(loadPrizes), '已新增');
  });

  $('#prizeRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const p = state.prizes.find((x) => x.id === Number(btn.dataset.id));
    if (btn.dataset.act === 'edit') {
      const v = await dialog('编辑奖项', prizeFields(p));
      if (v) guard(() => api('PUT', `/api/admin/prizes/${p.id}`, v).then(loadPrizes), '已保存');
    } else if (btn.dataset.act === 'del') {
      if (confirm(`确定删除「${p.name}」？`)) guard(() => api('DELETE', `/api/admin/prizes/${p.id}`).then(loadPrizes), '已删除');
    } else if (btn.dataset.act === 'img') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/gif,image/webp';
      input.onchange = () => {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) return toast('图片不能超过 3MB', 'error');
        guard(() => api('POST', `/api/admin/prizes/${p.id}/image`, file).then(loadPrizes), '图片已上传');
      };
      input.click();
    }
  });

  // ---------- 参与者 ----------
  let pTimer;
  async function loadParticipants() {
    const q = new URLSearchParams({ q: $('#pq').value, status: $('#pstatus').value, page: state.pPage, size: 50 });
    const r = await api('GET', '/api/admin/participants?' + q);
    $('#participantRows').innerHTML =
      r.rows
        .map(
          (p) => `<tr>
        <td>${p.id}</td><td>${esc(p.name)}</td><td>${esc(p.phone)}</td><td>${esc(p.dept)}</td>
        <td><span class="tag">${{ scan: '扫码', import: '导入', manual: '手动' }[p.source] || esc(p.source)}</span></td>
        <td>${p.checked_in ? `<span class="tag ok" title="${esc(p.checked_in_at)}">已签到</span>` : '<span class="tag">未签到</span>'}</td>
        <td>${p.wins ? `<span class="tag warn">${p.wins} 次</span>` : ''}</td>
        <td>${p.eligible ? '' : '<span class="tag err">无资格</span>'}</td>
        <td class="ops">
          <button class="btn sm" data-act="edit" data-id="${p.id}">编辑</button>
          <button class="btn sm danger" data-act="del" data-id="${p.id}">删除</button>
        </td></tr>`
        )
        .join('') || '<tr><td colspan="9" class="muted">暂无数据</td></tr>';
    state.pRows = r.rows;
    const pages = Math.max(1, Math.ceil(r.total / r.size));
    $('#pager').innerHTML = `共 ${r.total} 人 · 第 ${r.page}/${pages} 页
      <button class="btn sm" data-p="${r.page - 1}" ${r.page <= 1 ? 'disabled' : ''}>上一页</button>
      <button class="btn sm" data-p="${r.page + 1}" ${r.page >= pages ? 'disabled' : ''}>下一页</button>`;
  }
  $('#pager').addEventListener('click', (e) => {
    if (e.target.dataset.p) {
      state.pPage = Number(e.target.dataset.p);
      guard(loadParticipants);
    }
  });
  $('#pq').addEventListener('input', () => {
    clearTimeout(pTimer);
    pTimer = setTimeout(() => ((state.pPage = 1), guard(loadParticipants)), 250);
  });
  $('#pstatus').addEventListener('change', () => ((state.pPage = 1), guard(loadParticipants)));

  $('#addParticipant').addEventListener('click', async () => {
    const v = await dialog('手动添加参与者', [
      { name: 'name', label: '姓名', attrs: 'required maxlength="30"' },
      { name: 'phone', label: '手机号', attrs: 'required maxlength="11" inputmode="numeric"' },
      { name: 'dept', label: '部门（选填）', attrs: 'maxlength="40"' },
      { name: 'checkedIn', label: '标记为已签到（可直接参与抽奖）', type: 'checkbox', value: true },
    ]);
    if (v) guard(() => api('POST', '/api/admin/participants', v).then(loadParticipants), '已添加');
  });

  $('#importBtn').addEventListener('click', async () => {
    const v = await dialog(
      '批量导入名单',
      [
        {
          type: 'html',
          html: `<p class="muted small">从 Excel 复制「姓名、手机号、部门」三列直接粘贴，或选择 CSV 文件。首行为表头时自动识别列；手机号已存在的行会跳过。</p>
            <p><input type="file" id="csvFile" accept=".csv,.txt,text/csv"></p>`,
        },
        { name: 'csv', label: '名单内容', type: 'textarea', rows: 10, attrs: 'placeholder="姓名,手机号,部门&#10;张三,13800000000,研发部"' },
        { name: 'checkedIn', label: '导入即视为已签到（不需要现场扫码时勾选）', type: 'checkbox' },
      ],
      '导入'
    );
    if (!v) return;
    const r = await guard(() => api('POST', '/api/admin/participants/import', v));
    if (!r) return;
    const head = `成功导入 ${r.added} 人，跳过 ${r.skipped.length} 行`;
    if (r.skipped.length) alert(head + '\n\n' + r.skipped.slice(0, 30).map((s) => `第 ${s.line} 行：${s.reason}`).join('\n'));
    else toast(head, 'ok');
    loadParticipants();
  });
  // 选择文件后读入文本框
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'csvFile' || !e.target.files[0]) return;
    const reader = new FileReader();
    reader.onload = () => ($('#dlg [name="csv"]').value = reader.result);
    reader.readAsText(e.target.files[0], 'utf-8');
  });

  $('#participantRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const p = state.pRows.find((x) => x.id === Number(btn.dataset.id));
    if (btn.dataset.act === 'edit') {
      const v = await dialog('编辑参与者', [
        { name: 'name', label: '姓名', value: p.name, attrs: 'required maxlength="30"' },
        { name: 'phone', label: '手机号', value: p.phone, attrs: 'required maxlength="11"' },
        { name: 'dept', label: '部门', value: p.dept, attrs: 'maxlength="40"' },
        { name: 'checkedIn', label: '已签到', type: 'checkbox', value: p.checked_in },
        { name: 'eligible', label: '有抽奖资格（取消后不会被抽中，如评委、工作人员）', type: 'checkbox', value: p.eligible },
      ]);
      if (v) guard(() => api('PUT', `/api/admin/participants/${p.id}`, v).then(loadParticipants), '已保存');
    } else if (btn.dataset.act === 'del') {
      if (confirm(`确定删除「${p.name}」？`)) guard(() => api('DELETE', `/api/admin/participants/${p.id}`).then(loadParticipants), '已删除');
    }
  });

  // ---------- 中奖 ----------
  let wTimer;
  async function loadWinners() {
    if (!state.prizes.length) state.prizes = await api('GET', '/api/admin/prizes');
    const sel = $('#wprize');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部奖项</option>' + state.prizes.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    sel.value = cur;
    const q = new URLSearchParams({ prizeId: sel.value, status: $('#wstatus').value, q: $('#wq').value });
    if (!sel.value) q.delete('prizeId');
    const [rows, draws] = await Promise.all([api('GET', '/api/admin/winners?' + q), api('GET', '/api/admin/draws')]);
    state.wRows = rows;
    $('#winnerRows').innerHTML =
      rows
        .map(
          (w) => `<tr>
        <td>${w.id}</td><td>${w.draw_id}</td><td>${esc(w.prize_name)}</td><td>${esc(w.name)}</td><td>${esc(w.phone)}</td><td>${esc(w.dept)}</td>
        <td class="small">${esc(w.created_at)}</td>
        <td>${w.status === 'valid' ? '<span class="tag ok">有效</span>' : `<span class="tag err" title="${esc(w.revoked_at)}">作废：${esc(w.revoke_reason)}</span>`}</td>
        <td class="ops">${w.status === 'valid' ? `<button class="btn sm danger" data-id="${w.id}">作废</button>` : ''}</td></tr>`
        )
        .join('') || '<tr><td colspan="9" class="muted">暂无记录</td></tr>';
    $('#drawRows').innerHTML =
      draws
        .map((d) => `<tr><td>${d.id}</td><td>${esc(d.prize_name)}</td><td>${d.requested}</td><td>${d.drawn}</td><td>${d.pool_size}</td><td>${esc(d.operator)}</td><td class="small">${esc(d.created_at)}</td></tr>`)
        .join('') || '<tr><td colspan="7" class="muted">暂无</td></tr>';
  }
  ['#wprize', '#wstatus'].forEach((s) => $(s).addEventListener('change', () => guard(loadWinners)));
  $('#wq').addEventListener('input', () => {
    clearTimeout(wTimer);
    wTimer = setTimeout(() => guard(loadWinners), 250);
  });
  $('#winnerRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const w = state.wRows.find((x) => x.id === Number(btn.dataset.id));
    const v = await dialog(`作废「${w.name}」的中奖记录`, [
      { type: 'html', html: '<p class="muted small">作废后名额退回该奖项，可在大屏重新抽取。记录保留，可追溯。</p>' },
      { name: 'reason', label: '原因', value: '未到场', attrs: 'maxlength="100"' },
      { name: 'disqualify', label: '同时取消此人后续抽奖资格', type: 'checkbox', value: true },
    ], '确认作废');
    if (v) guard(() => api('POST', `/api/admin/winners/${w.id}/revoke`, v).then(loadWinners), '已作废，名额已退回');
  });

  // ---------- 系统 ----------
  async function loadSystem() {
    const [admins, logs] = await Promise.all([api('GET', '/api/admin/admins'), api('GET', '/api/admin/audit?limit=200')]);
    const me = $('#me').textContent;
    $('#adminRows').innerHTML = admins
      .map((a) => `<tr><td>${esc(a.username)}</td><td class="muted small">${esc(a.created_at)}</td>
        <td class="ops">${a.username === me ? '<span class="tag">当前</span>' : `<button class="btn sm danger" data-id="${a.id}" data-name="${esc(a.username)}">删除</button>`}</td></tr>`)
      .join('');
    $('#auditRows').innerHTML = logs
      .map((l) => `<tr><td class="small">${esc(l.created_at)}</td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td><div class="detail" title="${esc(l.detail)}">${esc(l.detail)}</div></td></tr>`)
      .join('');
  }
  $('#adminRows').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && confirm(`删除管理员 ${b.dataset.name}？`)) guard(() => api('DELETE', `/api/admin/admins/${b.dataset.id}`).then(loadSystem), '已删除');
  });
  $('#addAdmin').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    guard(() => api('POST', '/api/admin/admins', { username: f.username.value.trim(), password: f.password.value }).then(() => (f.reset(), loadSystem())), '已添加');
  });
  $('#pwd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const r = await guard(() => api('PUT', '/api/admin/password', { oldPassword: f.oldPassword.value, newPassword: f.newPassword.value }));
    if (r) {
      alert('密码已修改，请重新登录');
      location.href = '/admin/login.html';
    }
  });
  $('#resetBtn').addEventListener('click', async () => {
    const scope = $('#resetScope');
    const label = scope.options[scope.selectedIndex].text;
    const confirmText = prompt(`即将执行：${label}\n此操作会先自动备份，但仍请谨慎。\n\n请输入「确认清空」继续：`);
    if (confirmText === null) return;
    const r = await guard(() => api('POST', '/api/admin/reset', { scope: scope.value, confirm: confirmText }));
    if (r) toast(`已重置${r.backup ? '，备份：' + r.backup : ''}`, 'ok');
  });

  $('#logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.href = '/admin/login.html';
  });

  const loaders = {
    overview: () => guard(loadOverview),
    prizes: () => guard(loadPrizes),
    participants: () => guard(loadParticipants),
    winners: () => guard(loadWinners),
    system: () => guard(loadSystem),
  };

  // 实时刷新：签到 / 抽奖时更新当前页
  let refreshTimer;
  const refresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loaders[state.tab]?.(), 400);
  };
  guard(loadOverview).then(() => {
    subscribe({ signin: refresh, draw: refresh, revoke: refresh, participants: refresh, prizes: refresh, reset: refresh, settings: refresh });
    const tab = location.hash.slice(1);
    if (loaders[tab] && tab !== 'overview') go(tab);
  });
})();
