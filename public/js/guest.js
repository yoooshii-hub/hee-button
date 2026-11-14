(() => {
  const $ = (id) => document.getElementById(id);
  const slug = location.pathname.split('/').pop();
  const bigButton = $('hee');
  const socket = io();

  let st = null; // サーバーから届いた状態
  let mine = [0];
  let offset = 0; // サーバー時計 - この端末の時計
  let soundOn = true;
  let stopShow = () => {};
  let showKey = '';

  // 同じブラウザなら、リロードしたり閉じたりしても回数を引き継ぐための端末 id
  const store = {
    get(k) {
      try { return localStorage.getItem(k); } catch (e) { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch (e) {}
    },
  };
  let gid = store.get('hee-gid');
  soundOn = store.get('hee-sound') !== 'off';

  const MESSAGES = {
    ready: 'まもなく始まります',
    waiting: '次の投票までお待ちください',
    open: 'ボタンを押して「へぇ」を送ろう！',
    ended: 'イベントは終了しました',
  };
  const TOASTS = {
    saved: ['集計が保存されました', '選択が解除されました'],
    reset: ['リセットされました', '選択が解除されました'],
    restored: ['前のセッションに戻りました', 'あなたの選択も元に戻りました'],
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function canPress() {
    return socket.connected && st && st.status === 'live' && st.accepting;
  }

  function bump(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  function renderCounts(animateOpt) {
    $('count').textContent = (mine[0] || 0).toLocaleString();
    if (animateOpt === 0) bump($('count'));
    document.querySelectorAll('.extra-btn').forEach((b) => {
      b.querySelector('small').textContent = (mine[+b.dataset.opt] || 0).toLocaleString();
    });
  }

  function renderExtras() {
    const extras = st.options.slice(1);
    const key = extras.join('\n');
    if ($('extras').dataset.key === key) return;
    $('extras').dataset.key = key;
    $('extras').innerHTML = extras
      .map((o, i) => `<button class="extra-btn" type="button" data-opt="${i + 1}" disabled>${esc(o)}<small>0</small></button>`)
      .join('');
    document.querySelectorAll('.extra-btn').forEach(bind);
  }

  function render() {
    const ok = canPress();
    bigButton.disabled = !ok;
    document.querySelectorAll('.extra-btn').forEach((b) => (b.disabled = !ok));
    if (!st) return;
    $('title').textContent = st.title;
    $('splash-title').textContent = st.title;
    document.title = `へぇボタン - ${st.title}`;
    $('presenter').textContent = st.presenter ? `発表：${st.presenter}` : '';
    $('total-label').textContent = st.options[0];
    $('total').textContent = (st.shown[0] || 0).toLocaleString();
    bigButton.setAttribute('aria-label', st.options[0]);
    let msg = MESSAGES.open;
    if (!socket.connected) msg = '再接続しています…';
    else if (st.status === 'ready') msg = MESSAGES.ready;
    else if (st.status === 'ended') msg = MESSAGES.ended;
    else if (!st.accepting) msg = MESSAGES.waiting;
    $('msg').textContent = msg;
    $('msg').className = `status-msg ${ok ? 'open' : ''}`;
    renderCounts();
    renderRanking();
  }

  // イベント終了後の最終ランキング。合計表示ページと同じ時刻表で演出する
  function renderRanking() {
    const show = st.status === 'ended' && st.view === 'ranking' && Array.isArray(st.ranking);
    $('ranking').hidden = !show;
    if (!show) {
      stopShow();
      showKey = '';
      return;
    }
    const k = JSON.stringify([st.playAt, st.ranking]);
    if (k === showKey) return;
    showKey = k;
    stopShow();
    stopShow = RankingShow.play($('rank-host'), st.ranking, st.playAt - offset, { sound: soundOn && HeeSound.unlocked });
  }

  function toast(reason) {
    const t = TOASTS[reason];
    if (!t) return;
    document.querySelectorAll('.toast').forEach((x) => x.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `${t[0]}<small>${t[1]}</small>`;
    document.body.appendChild(el);
    if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
    setTimeout(() => el.remove(), 3500);
  }

  function apply(s) {
    offset = s.serverNow - Date.now();
    if (st && s.round !== st.round) toast(s.reason);
    st = s;
    mine = [...s.mine];
    renderExtras();
    render();
  }

  function join() {
    socket.emit('join-guest', { slug, gid }, (res) => {
      if (res.error) {
        $('title').textContent = 'イベントが見つかりません';
        $('splash-title').textContent = 'イベントが見つかりません';
        $('msg').textContent = 'URLをご確認ください';
        st = null;
        render();
        return;
      }
      gid = res.gid;
      store.set('hee-gid', gid);
      apply(res.state);
    });
  }

  socket.on('connect', join);
  socket.on('disconnect', render);
  socket.on('state', apply);
  socket.on('tally', (t) => {
    if (!st || t.round !== st.round) return;
    st.shown = t.shown;
    $('total').textContent = (t.shown[0] || 0).toLocaleString();
  });
  socket.on('deleted', () => {
    st = null;
    render();
    $('title').textContent = 'このイベントは終了しました';
    $('msg').textContent = 'ご参加ありがとうございました';
  });

  function effects(opt, btn) {
    if (soundOn) HeeSound.play(opt);
    if (navigator.vibrate) navigator.vibrate(opt ? [10, 30, 10] : 15);
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 90);
    if (opt) return;

    const stage = $('stage');
    const ripple = document.createElement('div');
    ripple.className = 'ripple';
    stage.appendChild(ripple);
    setTimeout(() => ripple.remove(), 520);

    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.textContent = st.options[0];
    pop.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 160)}px`);
    stage.appendChild(pop);
    setTimeout(() => pop.remove(), 720);
  }

  function press(btn, e) {
    if (e) e.preventDefault();
    if (btn.disabled || !canPress()) return;
    const opt = +btn.dataset.opt;
    effects(opt, btn);
    mine[opt] = (mine[opt] || 0) + 1; // 即座に反映し、サーバーで数えられなかった分だけ戻す
    renderCounts(opt);
    const round = st.round;
    socket.timeout(5000).emit('vote', { round, opt }, (err, res) => {
      if (err || !res.ok) {
        if (st && st.round === round) {
          mine[opt] = Math.max(0, mine[opt] - 1);
          renderCounts();
        }
        if (res && res.state) apply(res.state);
      }
    });
  }

  // タップの遅延をなくすため pointerdown で反応する
  function bind(btn) {
    btn.addEventListener('pointerdown', (e) => press(btn, e));
    btn.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) press(btn, e);
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  bind(bigButton);

  // iPhone ではタップ操作の中で音を有効にする必要があるので、最初に一度タップしてもらう
  $('go').addEventListener('click', () => {
    HeeSound.unlock();
    $('splash').hidden = true;
  });
  document.addEventListener('touchend', () => {
    if (!HeeSound.unlocked) HeeSound.unlock();
  });

  function renderSound() {
    $('sound').textContent = soundOn ? '🔊 音あり' : '🔇 音なし';
  }
  renderSound();
  $('sound').onclick = () => {
    soundOn = !soundOn;
    store.set('hee-sound', soundOn ? 'on' : 'off');
    if (soundOn) HeeSound.unlock();
    renderSound();
  };
})();
