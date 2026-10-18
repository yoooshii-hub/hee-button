// 「へぇ」音。public/sounds/hee.mp3 を置けばその音源を使い、無ければ Web Audio で合成する。
const HeeSound = (() => {
  let ctx = null;
  let buffer = null;
  let triedFile = false;

  function ensureContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
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

  function playFile(ac) {
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(ac.destination);
    src.start();
  }

  // 低めの男声「へぇ〜」を、のこぎり波 + /e/ のフォルマントで近似する
  function playSynth(ac) {
    const t = ac.currentTime;
    const dur = 0.55;
    const out = ac.createGain();
    out.gain.value = 0.9;
    out.connect(ac.destination);

    // 「h」: 短い帯域ノイズ
    const noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.08, ac.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    const noise = ac.createBufferSource();
    noise.buffer = noiseBuf;
    const nf = ac.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1800;
    nf.Q.value = 0.8;
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    noise.connect(nf).connect(ng).connect(out);
    noise.start(t);

    // 「えぇ〜」: 声帯音 → フォルマント
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    const v0 = t + 0.04;
    osc.frequency.setValueAtTime(150, v0);
    osc.frequency.linearRampToValueAtTime(165, v0 + 0.12);
    osc.frequency.exponentialRampToValueAtTime(118, v0 + dur);
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

  return {
    unlock: ensureContext,
    play() {
      try {
        const ac = ensureContext();
        buffer ? playFile(ac) : playSynth(ac);
      } catch (e) {
        /* 音が鳴らない環境ではそのまま続行 */
      }
    },
  };
})();
