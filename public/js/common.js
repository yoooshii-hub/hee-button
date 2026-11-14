async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !options.allow401) {
    location.href = '/';
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(data.error || 'エラーが発生しました');
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { ready: '準備中', live: '開催中', ended: '終了' };

function topbar(user) {
  return `
    <header class="topbar">
      <a class="brand" href="/room">へぇ<span>ボタン</span></a>
      <div class="row">
        <span class="muted" style="color:#c9c6e6">${escapeHtml(user.username)} さん</span>
        <button class="btn ghost" onclick="api('/api/logout',{method:'POST',body:{}}).then(()=>location.href='/')">ログアウト</button>
      </div>
    </header>`;
}
