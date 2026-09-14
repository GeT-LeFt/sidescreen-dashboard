/* Shared live controls for the small panel and every wide-panel page. */
(() => {
  'use strict';
  const definitions = {
    topmost: { label: '仪表盘置顶', endpoint: '/api/dashboard/topmost',
      hint: '同时切换两块副屏仪表盘的置顶状态',
      icon: '<path d="M8 3h8l-1 6 4 4v2H5v-2l4-4-1-6zM12 15v6"/>' },
    fence: { label: '鼠标围栏', endpoint: '/api/mouseguard',
      hint: '开启后，鼠标限制在工作显示器范围内；仍可触摸副屏按钮关闭',
      icon: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M9 8v10l3-3 3 5 2-1-3-5h4L9 8z"/>' }
  };
  const states = {}, pending = {}, versions = { topmost: 0, fence: 0 };
  function mount(parent, extraClass = '') {
    const group = document.createElement('div');
    group.className = 'screen-controls ' + extraClass;
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', '副屏控制');
    for (const [key, def] of Object.entries(definitions)) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'screen-toggle'; button.dataset.screenControl = key;
      button.setAttribute('aria-pressed', 'false'); button.disabled = true; button.title = def.hint;
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${def.icon}</svg><span class="sc-copy"><span class="sc-label">${def.label}</span><span class="sc-state">读取中</span></span>`;
      button.addEventListener('click', event => { event.stopPropagation(); toggle(key); });
      group.appendChild(button);
    }
    parent.appendChild(group);
  }
  const docks = document.querySelectorAll('#track .dock');
  if (docks.length) {
    docks.forEach(dock => mount(dock));
    const gameSide = document.getElementById('gameSide'); if (gameSide) mount(gameSide);
  } else {
    document.body.classList.add('sc-small'); mount(document.body, 'sc-small-footer');
  }
  const message = document.createElement('div');
  message.className = 'screen-controls-toast'; message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite'); document.body.appendChild(message);
  let toastTimer;
  function toast(text) {
    message.textContent = text; message.classList.add('visible'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => message.classList.remove('visible'), 4500);
  }
  async function request(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { cache:'no-store', signal:controller.signal,
        ...(body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || '操作失败');
      return data;
    } finally { clearTimeout(timer); }
  }
  function render(key, failed = false) {
    const state = states[key]; let on = false, label = '读取失败', warning = failed;
    if (state && !failed) {
      if (key === 'topmost') {
        on = state.available ? state.enabled : state.desired;
        label = state.mixed ? '部分置顶' : state.available ? (on ? '已开启' : '已关闭') : '未找到窗口';
        warning = !!state.mixed || !state.available;
      } else {
        on = !!state.running;
        label = on ? (state.state === 'yield' ? '已开启 · 暂让行' : state.state === 'lock' ? '已开启 · 游戏内' : '已开启') : state.enabled ? '未运行' : '已关闭';
        warning = !!state.enabled && !state.running;
      }
    }
    document.querySelectorAll(`[data-screen-control="${key}"]`).forEach(button => {
      button.disabled = !!pending[key] || !state;
      button.setAttribute('aria-pressed', String(!!on));
      button.classList.toggle('sc-warning', warning);
      const text = pending[key] ? '切换中…' : label;
      button.querySelector('.sc-state').textContent = text;
      button.setAttribute('aria-label', `${definitions[key].label}：${text}`);
    });
  }
  async function refresh(key) {
    if (pending[key]) return;
    const version = ++versions[key];
    try {
      const state = await request(definitions[key].endpoint);
      if (version !== versions[key] || pending[key]) return;
      states[key] = state; render(key);
    } catch { if (version === versions[key] && !pending[key]) render(key, true); }
  }
  async function toggle(key) {
    if (pending[key] || !states[key]) return;
    const old = states[key];
    const on = key === 'fence' ? !(old.running || old.enabled) : !(old.mixed || (old.available ? old.enabled : old.desired));
    ++versions[key]; pending[key] = true; render(key);
    try {
      const changed = await request(definitions[key].endpoint, { on });
      let state = changed;
      if (key === 'fence') {
        // The keeper heartbeat may lag its launch/stop request by a couple of seconds.
        for (let attempt = 0; attempt < 6; attempt++) {
          state = await request(definitions[key].endpoint);
          if (!!state.running === on) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      states[key] = state;
      const actual = key === 'fence' ? !!state.running : state.available ? state.enabled : state.desired;
      if (actual !== on || state.mixed) throw new Error('设置尚未生效，请重试');
      toast(`${definitions[key].label}${on ? '已开启' : '已关闭'}`);
    } catch (error) {
      toast(error.name === 'AbortError' ? '操作超时，请查看按钮状态后重试' : error.message);
    } finally {
      pending[key] = false; render(key); refresh(key);
    }
  }
  function refreshAll() { Object.keys(definitions).forEach(refresh); }
  refreshAll(); setInterval(refreshAll, 5000);
  window.addEventListener('focus', refreshAll);
})();
