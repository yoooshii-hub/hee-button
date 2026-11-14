// ランキング発表の演出。合計表示ページと参加者のスマホで同じ時刻表を使い、表示を連動させる。
const RankingShow = (() => {
  const DRUM_MS = 3500; // ドラムロールの長さ
  const STEP_MS = 1300; // 下位から1行ずつ登場する間隔
  const PAUSE_MS = 1200; // 1位の前のため
  const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const label = (r) => (r.presenter ? r.presenter : `セッション ${r.no}`);

  // 各行が登場する時刻（演出開始からのミリ秒）
  function schedule(rows) {
    const winners = rows.filter((r) => r.rank === 1).length;
    const times = new Array(rows.length);
    let k = 0;
    for (let i = rows.length - 1; i >= winners; i--) times[i] = DRUM_MS + STEP_MS * k++;
    const winAt = DRUM_MS + STEP_MS * k + (k ? PAUSE_MS : 0);
    for (let i = 0; i < winners; i++) times[i] = winAt;
    return { times, winAt, end: winAt + 4500 };
  }

  function rowHtml(r, max) {
    const pct = max ? Math.round((r.hee / max) * 100) : 0;
    return `
      <li class="rk-row rk-rank${Math.min(r.rank, 4)}">
        <span class="rk-pos">${MEDALS[r.rank] || `<b>${r.rank}</b>位`}</span>
        <span class="rk-name">${esc(label(r))}${r.tie ? '<em class="rk-tie">同率</em>' : ''}</span>
        <span class="rk-bar"><i style="width:${pct}%"></i></span>
        <span class="rk-num"><b>${r.hee.toLocaleString()}</b> へぇ</span>
      </li>`;
  }

  // 紙吹雪
  function confetti(host) {
    const canvas = document.createElement('canvas');
    canvas.className = 'rk-confetti';
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = host.clientWidth * dpr;
      canvas.height = host.clientHeight * dpr;
    };
    resize();
    const colors = ['#ff2d2d', '#e7bd2c', '#3f86ec', '#ffffff', '#2bb0a0', '#ff8fb0'];
    const parts = Array.from({ length: 180 }, () => ({
      x: Math.random() * canvas.width,
      y: -Math.random() * canvas.height * 0.6,
      w: (6 + Math.random() * 8) * dpr,
      h: (8 + Math.random() * 10) * dpr,
      vy: (2 + Math.random() * 3) * dpr,
      vx: (Math.random() - 0.5) * 2 * dpr,
      a: Math.random() * Math.PI,
      va: (Math.random() - 0.5) * 0.3,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    const start = performance.now();
    (function frame(now) {
      if (!canvas.isConnected) return;
      const t = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx + Math.sin((t / 400) + p.a) * 0.6 * dpr;
        p.y += p.vy;
        p.a += p.va;
        if (t < 3500 && p.y > canvas.height) p.y = -20;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.a * 2)));
        ctx.restore();
      }
      if (t < 7000) requestAnimationFrame(frame);
      else canvas.remove();
    })(start);
  }

  // host に演出を描く。playAt はこの端末の時計での演出開始時刻。戻り値で途中停止できる
  function play(host, rows, playAt, { sound = false } = {}) {
    const timers = [];
    const max = Math.max(0, ...rows.map((r) => r.hee));
    host.innerHTML = rows.length
      ? `<div class="rk-drum">結果発表</div><ol class="rk-list">${rows.map((r) => rowHtml(r, max)).join('')}</ol>`
      : '<p class="rk-empty">保存済みのセッションがありません</p>';
    if (!rows.length) return () => {};

    const items = [...host.querySelectorAll('.rk-row')];
    const drum = host.querySelector('.rk-drum');
    const { times, winAt } = schedule(rows);
    const elapsed = Date.now() - playAt;
    const at = (ms, fn) => {
      if (ms <= elapsed) fn(false);
      else timers.push(setTimeout(() => fn(true), ms - elapsed));
    };

    if (elapsed < DRUM_MS) {
      drum.classList.add('on');
      if (sound && elapsed < 300) HeeSound.drumroll(DRUM_MS / 1000);
    }
    at(DRUM_MS, () => drum.classList.remove('on'));
    items.forEach((el, i) => {
      el.classList.add('rk-hidden');
      at(times[i], (live) => {
        el.classList.remove('rk-hidden');
        if (live) {
          el.classList.add('rk-enter');
          if (sound && times[i] !== winAt) HeeSound.tick();
        }
      });
    });
    at(winAt, (live) => {
      if (!live) return;
      if (sound) HeeSound.fanfare();
      confetti(host);
    });
    return () => timers.forEach(clearTimeout);
  }

  return { play, schedule, label, DRUM_MS };
})();
