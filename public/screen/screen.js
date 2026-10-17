(function () {
  const { api, esc, $, toast, subscribe } = VL;
  const MAX_TAGS = 160;

  const state = {
    mode: 'wall', // wall | draw
    phase: 'idle', // idle | rolling | drawing | result
    pool: [],
    prizes: [],
    prizeIdx: 0,
    checkedIn: 0,
    myDraws: new Set(),
  };

  // ---------- 3D 名字球（JS 投影，标签始终正对观众） ----------
  const sphere = {
    el: $('#sphere'),
    tags: [],
    ax: 0.3,
    ay: 0,
    speed: 0.004,
    target: 0.004,
    radius: 0,
    build(names) {
      this.el.innerHTML = '';
      const list = names.length > MAX_TAGS ? shuffle(names.slice()).slice(0, MAX_TAGS) : names;
      const n = list.length;
      this.tags = list.map((name, i) => {
        // Fibonacci 球面均匀分布
        const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = i * Math.PI * (3 - Math.sqrt(5));
        const el = document.createElement('div');
        el.className = 'tag';
        el.textContent = name;
        this.el.appendChild(el);
        return { el, x: Math.cos(theta) * r, y, z: Math.sin(theta) * r, w: 0, h: 0 };
      });
      requestAnimationFrame(() => this.tags.forEach((t) => ((t.w = t.el.offsetWidth), (t.h = t.el.offsetHeight))));
    },
    frame() {
      this.speed += (this.target - this.speed) * 0.05;
      this.ay += this.speed;
      const R = Math.min(innerWidth, innerHeight) * (state.mode === 'wall' ? 0.36 : 0.3);
      const cy = Math.cos(this.ay), sy = Math.sin(this.ay), cx = Math.cos(this.ax), sx = Math.sin(this.ax);
      for (const t of this.tags) {
        const x1 = t.x * cy - t.z * sy;
        const z1 = t.x * sy + t.z * cy;
        const y2 = t.y * cx - z1 * sx;
        const z2 = t.y * sx + z1 * cx;
        const scale = 0.55 + (z2 + 1) * 0.35;
        t.el.style.transform = `translate(${x1 * R - t.w / 2}px, ${y2 * R - t.h / 2}px) scale(${scale.toFixed(3)})`;
        t.el.style.opacity = (0.15 + (z2 + 1) * 0.42).toFixed(2);
        t.el.style.zIndex = Math.round((z2 + 1) * 100);
      }
      requestAnimationFrame(() => this.frame());
    },
  };

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- 数据 ----------
  async function loadAll() {
    const [o, pool, prizes] = await Promise.all([
      api('GET', '/api/admin/overview'),
      api('GET', '/api/admin/pool'),
      api('GET', '/api/admin/prizes'),
    ]);
    document.title = `${o.settings.eventTitle} · 大屏`;
    $('#title').textContent = o.settings.eventTitle;
    state.checkedIn = o.stats.checkedIn;
    $('#count').textContent = state.checkedIn;
    const qr = '/api/admin/qrcode.svg?text=' + encodeURIComponent(o.signinUrl);
    if ($('#qr').dataset.src !== qr) $('#qr').src = $('#qr').dataset.src = qr;

    state.pool = pool;
    $('#poolInfo').textContent = state.mode === 'draw' ? `· 当前可抽 ${pool.length} 人` : '';
    if (state.phase !== 'rolling') sphere.build(pool.map((p) => p.name));

    const curId = state.prizes[state.prizeIdx]?.id;
    state.prizes = prizes;
    const keep = prizes.findIndex((p) => p.id === curId);
    state.prizeIdx = keep >= 0 ? keep : Math.max(0, prizes.findIndex((p) => p.remaining > 0));
    renderPrize();
  }

  const currentPrize = () => state.prizes[state.prizeIdx];

  async function renderPrize() {
    const p = currentPrize();
    if (!p) {
      $('#prizeName').textContent = '请先在后台设置奖项';
      $('#prizeDesc').textContent = $('#prizeLeft').textContent = '';
      $('#prizeImg').hidden = true;
      $('#wonList').innerHTML = '';
      return;
    }
    $('#prizeName').textContent = p.name;
    $('#prizeDesc').textContent = p.description;
    $('#prizeLeft').textContent = p.remaining > 0 ? `共 ${p.quantity} 名 · 剩余 ${p.remaining} 名` : `共 ${p.quantity} 名 · 已抽完`;
    $('#prizeImg').hidden = !p.image;
    if (p.image) $('#prizeImg').src = p.image;
    const input = $('#drawCount');
    input.max = Math.max(1, p.remaining);
    if (Number(input.value) > p.remaining) input.value = Math.max(1, p.remaining);
    $('#go').disabled = p.remaining <= 0 && state.phase === 'idle';

    const won = await api('GET', `/api/admin/winners?prizeId=${p.id}&masked=1`).catch(() => []);
    $('#wonList').innerHTML = won.length
      ? '已中奖：' + won.slice().reverse().map((w) => `<span>${esc(w.name)}</span>`).join('')
      : '';
  }

  // ---------- 模式与抽奖流程 ----------
  function setMode(mode) {
    if (state.phase !== 'idle') return;
    state.mode = mode;
    document.body.classList.toggle('mode-wall', mode === 'wall');
    $('#wall').hidden = mode !== 'wall';
    $('#stage').hidden = mode !== 'draw';
    $('#poolInfo').textContent = mode === 'draw' ? `· 当前可抽 ${state.pool.length} 人` : '';
    sphere.target = 0.004;
  }

  let rollTimer;
  function startRolling() {
    const p = currentPrize();
    if (!p) return toast('请先在后台设置奖项', 'error');
    if (p.remaining <= 0) return toast('该奖项已抽完，请切换奖项', 'error');
    if (!state.pool.length) return toast('当前没有可抽奖的人（需已签到且未中奖）', 'error');
    state.phase = 'rolling';
    sphere.target = 0.09;
    $('#go').textContent = '停 !';
    $('#go').classList.add('stop');
    let last;
    rollTimer = setInterval(() => {
      const p2 = state.pool[Math.floor(Math.random() * state.pool.length)];
      $('#rolling').textContent = p2.name;
      if (last) last.classList.remove('hot');
      last = sphere.tags[Math.floor(Math.random() * sphere.tags.length)]?.el;
      last?.classList.add('hot');
    }, 60);
  }

  async function stopAndDraw() {
    const p = currentPrize();
    state.phase = 'drawing';
    $('#go').disabled = true;
    const count = Math.max(1, Math.min(Number($('#drawCount').value) || 1, p.remaining));
    let result;
    try {
      result = await api('POST', '/api/admin/draw', { prizeId: p.id, count });
      state.myDraws.add(result.drawId);
    } catch (e) {
      toast(e.message, 'error');
      endRolling();
      state.phase = 'idle';
      $('#go').disabled = false;
      return loadAll();
    }
    // 结果已在服务端落库；此处减速做揭晓动画
    sphere.target = 0.004;
    setTimeout(() => {
      endRolling();
      showResult(result);
    }, 900);
  }

  function endRolling() {
    clearInterval(rollTimer);
    $('#rolling').textContent = '';
    sphere.tags.forEach((t) => t.el.classList.remove('hot'));
    $('#go').textContent = '开始抽奖';
    $('#go').classList.remove('stop');
  }

  function showResult(r) {
    state.phase = 'result';
    $('#resultTitle').textContent = `${r.prize.name} · ${r.winners.length} 位`;
    const n = r.winners.length;
    const fs = n <= 1 ? 14 : n <= 3 ? 9 : n <= 6 ? 7 : n <= 12 ? 5 : n <= 24 ? 3.6 : 2.8;
    $('#resultGrid').style.setProperty('--fs', fs + 'vh');
    $('#resultGrid').innerHTML = r.winners
      .map((w, i) => `<div class="winner" style="animation-delay:${Math.min(i * 0.12, 3)}s"><div class="n">${esc(w.name)}</div><div class="d">${esc(w.dept || w.phone)}</div></div>`)
      .join('');
    $('#result').hidden = false;
    confetti();
  }

  function closeResult() {
    $('#result').hidden = true;
    state.phase = 'idle';
    $('#go').disabled = false;
    loadAll().catch((e) => toast(e.message, 'error'));
  }

  function onGo() {
    if (state.mode !== 'draw') return setMode('draw');
    if (state.phase === 'idle') startRolling();
    else if (state.phase === 'rolling') stopAndDraw();
    else if (state.phase === 'result') closeResult();
  }

  function switchPrize(delta) {
    if (state.phase !== 'idle' || !state.prizes.length) return;
    state.prizeIdx = (state.prizeIdx + delta + state.prizes.length) % state.prizes.length;
    $('#drawCount').value = 1;
    renderPrize();
  }

  function bumpCount(delta) {
    const input = $('#drawCount');
    const max = Math.max(1, currentPrize()?.remaining || 1);
    input.value = Math.min(max, Math.max(1, (Number(input.value) || 1) + delta));
  }

  $('#go').addEventListener('click', onGo);
  $('#prev').addEventListener('click', () => switchPrize(-1));
  $('#next').addEventListener('click', () => switchPrize(1));
  $('#minus').addEventListener('click', () => bumpCount(-1));
  $('#plus').addEventListener('click', () => bumpCount(1));
  $('#all').addEventListener('click', () => ($('#drawCount').value = Math.max(1, currentPrize()?.remaining || 1)));
  $('#result').addEventListener('click', () => state.phase === 'result' && closeResult());

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.code !== 'Space' && e.code !== 'Enter') return;
    if (e.repeat) return;
    switch (e.code) {
      case 'Space':
      case 'Enter':
        e.preventDefault();
        e.target.blur?.();
        onGo();
        break;
      case 'ArrowLeft': switchPrize(-1); break;
      case 'ArrowRight': switchPrize(1); break;
      case 'ArrowUp': e.preventDefault(); bumpCount(1); break;
      case 'ArrowDown': e.preventDefault(); bumpCount(-1); break;
      case 'KeyQ': setMode(state.mode === 'wall' ? 'draw' : 'wall'); break;
      case 'KeyF':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
        break;
      case 'Escape':
        if (state.phase === 'result') closeResult();
        break;
    }
  });

  // ---------- 彩带 ----------
  const cv = $('#fx');
  const ctx = cv.getContext('2d');
  let bits = [];
  function resize() {
    cv.width = innerWidth * devicePixelRatio;
    cv.height = innerHeight * devicePixelRatio;
  }
  addEventListener('resize', resize);
  resize();
  function confetti() {
    const colors = ['#ffd77a', '#ffb300', '#fff', '#ff5a5f', '#ffe9b0'];
    for (let i = 0; i < 220; i++) {
      bits.push({
        x: cv.width * (0.2 + Math.random() * 0.6),
        y: cv.height * 0.35,
        vx: (Math.random() - 0.5) * 26 * devicePixelRatio,
        vy: (-Math.random() * 22 - 6) * devicePixelRatio,
        s: (4 + Math.random() * 6) * devicePixelRatio,
        r: Math.random() * 6,
        c: colors[i % colors.length],
        life: 160 + Math.random() * 80,
      });
    }
  }
  (function fx() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    bits = bits.filter((b) => b.life-- > 0 && b.y < cv.height + 40);
    for (const b of bits) {
      b.vy += 0.5 * devicePixelRatio;
      b.vx *= 0.985;
      b.x += b.vx;
      b.y += b.vy;
      b.r += 0.15;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.r);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
      ctx.restore();
    }
    requestAnimationFrame(fx);
  })();

  // ---------- 实时事件 ----------
  let reloadTimer;
  const reload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => state.phase === 'idle' && loadAll().catch(() => {}), 500);
  };

  function onSignin(d) {
    state.checkedIn = d.total;
    $('#count').textContent = d.total;
    const row = document.createElement('div');
    row.innerHTML = `<b>${esc(d.name)}</b> ${d.dept ? esc(d.dept) + ' · ' : ''}签到成功`;
    $('#feed').prepend(row);
    while ($('#feed').children.length > 12) $('#feed').lastChild.remove();
    if (state.phase === 'idle' && !state.pool.some((p) => p.id === d.id)) {
      state.pool.push({ id: d.id, name: d.name, dept: d.dept });
      if (sphere.tags.length < MAX_TAGS) sphere.build(state.pool.map((p) => p.name));
      $('#poolInfo').textContent = state.mode === 'draw' ? `· 当前可抽 ${state.pool.length} 人` : '';
    }
  }

  function connect() {
    const es = subscribe({
      signin: onSignin,
      draw: (d) => !state.myDraws.has(d.drawId) && reload(),
      revoke: reload,
      prizes: reload,
      participants: reload,
      settings: reload,
      reset: reload,
    });
    es.onopen = () => {
      $('#conn').textContent = '';
      $('#conn').classList.remove('off');
    };
    es.onerror = () => {
      $('#conn').textContent = '● 实时连接断开，重连中…';
      $('#conn').classList.add('off');
    };
  }

  setMode('wall');
  loadAll()
    .then(() => {
      sphere.frame();
      connect();
    })
    .catch((e) => e.status !== 401 && toast(e.message, 'error'));
})();
