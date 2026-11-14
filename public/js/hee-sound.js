// 効果音。public/sounds/hee.mp3 を置けば最初のボタンはその音源を使い、無ければ Web Audio で合成する。
const HeeSound = (() => {
  let ctx = null;
  let buffer = null;
  let triedFile = false;

  // iPhone のマナースイッチがオンでも鳴るよう「再生」用のオーディオとして扱ってもらう（Safari 16.4+）
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) {}

  function ensureContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state !== 'running') ctx.resume();
    if (!triedFile) {
      triedFile = true;
      fetch('/sounds/hee.mp3')
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then((data) => ctx.decodeAudioData(data))
        .then((b) => (buffer = b))
        .catch(() => {});
    }
    return ctx;
  }

  // iPhone はタップの操作中に無音を一度鳴らすと、以後の音が出るようになる
  function unlock() {
    const ac = ensureContext();
    const src = ac.createBufferSource();
    src.buffer = ac.createBuffer(1, 1, 22050);
    src.connect(ac.destination);
    src.start(0);
  }

  function noise(ac, seconds) {
    const b = ac.createBuffer(1, Math.max(1, ac.sampleRate * seconds), ac.sampleRate);
    const ch = b.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    return b;
  }

  function envGain(ac, t, peak, attack, release) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    return g;
  }

  // 低めの男声「へぇ〜」を、のこぎり波 + /e/ のフォルマントで近似する
  function voiceHee(ac, out, pitch = 1) {
    const t = ac.currentTime;
    const dur = 0.55;

    const n = ac.createBufferSource();
    n.buffer = noise(ac, 0.08);
    const nf = ac.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1800;
    nf.Q.value = 0.8;
    n.connect(nf).connect(envGain(ac, t, 0.25, 0.02, 0.06)).connect(out);
    n.start(t);

    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    const v0 = t + 0.04;
    osc.frequency.setValueAtTime(150 * pitch, v0);
    osc.frequency.linearRampToValueAtTime(165 * pitch, v0 + 0.12);
    osc.frequency.exponentialRampToValueAtTime(118 * pitch, v0 + dur);
    const vib = ac.createOscillator();
    vib.frequency.value = 5.5;
    const vibGain = ac.createGain();
    vibGain.gain.value = 2.5;
    vib.connect(vibGain).connect(osc.frequency);

    const vg = ac.createGain();
    vg.gain.setValueAtTime(0.0001, v0);
    vg.gain.exponentialRampToValueAtTime(1, v0 + 0.05);
    vg.gain.setValueAtTime(1, v0 + dur * 0.6);
    vg.gain.exponentialRampToValueAtTime(0.0001, v0 + dur);

    for (const [freq, q, gain] of [[480, 6, 1.0], [1850, 10, 0.55], [2550, 12, 0.3]]) {
      const f = ac.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ac.createGain();
      g.gain.value = gain * 2.2;
      osc.connect(f).connect(g).connect(vg);
    }
    vg.connect(out);
    osc.start(v0);
    vib.start(v0);
    osc.stop(v0 + dur + 0.05);
    vib.stop(v0 + dur + 0.05);
  }

  // 2つ目以降のボタン用の、音色の違う短い効果音
  function chime(ac, out, notes, type) {
    const t = ac.currentTime;
    notes.forEach((f, i) => {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = envGain(ac, t + i * 0.08, 0.35, 0.01, 0.3);
      o.connect(g).connect(out);
      o.start(t + i * 0.08);
      o.stop(t + i * 0.08 + 0.35);
    });
  }

  const BUTTON_SOUNDS = [
    (ac, out) => (buffer ? playBuffer(ac, out) : voiceHee(ac, out)),
    (ac, out) => chime(ac, out, [784, 1047], 'triangle'),
    (ac, out) => chime(ac, out, [523, 659, 784], 'square'),
    (ac, out) => voiceHee(ac, out, 1.6),
  ];

  function playBuffer(ac, out) {
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    src.start();
  }

  function withOut(fn) {
    try {
      const ac = ensureContext();
      const out = ac.createGain();
      out.gain.value = 0.9;
      out.connect(ac.destination);
      fn(ac, out);
    } catch (e) {
      /* 音が鳴らない環境ではそのまま続行 */
    }
  }

  // スネアのロール。seconds 秒かけてだんだん大きくなる
  function drumroll(seconds) {
    withOut((ac, out) => {
      const t0 = ac.currentTime;
      const hits = Math.floor(seconds * 22);
      const buf = noise(ac, 0.06);
      for (let i = 0; i < hits; i++) {
        const t = t0 + i / 22 + (Math.random() - 0.5) * 0.008;
        const src = ac.createBufferSource();
        src.buffer = buf;
        const f = ac.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 2200;
        f.Q.value = 0.7;
        const vol = 0.08 + 0.32 * (i / hits);
        src.connect(f).connect(envGain(ac, t, vol, 0.003, 0.05)).connect(out);
        src.start(t);
      }
    });
  }

  // 1位発表のシンバル＋ファンファーレ
  function fanfare() {
    withOut((ac, out) => {
      const t = ac.currentTime;
      const src = ac.createBufferSource();
      src.buffer = noise(ac, 1.6);
      const f = ac.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 5000;
      src.connect(f).connect(envGain(ac, t, 0.5, 0.005, 1.5)).connect(out);
      src.start(t);
      [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.38]].forEach(([freq, d]) => {
        const o = ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq;
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2400;
        o.connect(lp).connect(envGain(ac, t + d, 0.22, 0.02, d === 0.38 ? 1.2 : 0.25)).connect(out);
        o.start(t + d);
        o.stop(t + d + 1.4);
      });
    });
  }

  // 1行登場するときの小さな音
  function tick() {
    withOut((ac, out) => chime(ac, out, [880], 'triangle'));
  }

  return {
    unlock,
    get unlocked() {
      return !!ctx && ctx.state === 'running';
    },
    play(i = 0) {
      withOut((ac, out) => (BUTTON_SOUNDS[i] || BUTTON_SOUNDS[0])(ac, out));
    },
    drumroll,
    fanfare,
    tick,
  };
})();
