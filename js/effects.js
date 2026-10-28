// REA Studio — insert effects built on Web Audio nodes.
// Every effect returns { input, output, set(params), dispose() }.
REA.effects = (() => {
  const U = REA.util;

  function wetDry(ctx) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    input.connect(dry);
    dry.connect(output);
    wet.connect(output);
    return { input, output, dry, wet, setMix(m) { dry.gain.value = 1 - m; wet.gain.value = m; } };
  }

  function disposeAll(nodes) {
    for (const n of nodes) { try { n.disconnect(); } catch (e) { /* already disconnected */ } }
  }

  function makeImpulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const ir = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return ir;
  }

  const defs = {
    eq: {
      name: 'EQ-4',
      title: '4-Band EQ',
      params: [
        { key: 'hpf', label: 'High-pass', min: 20, max: 1000, step: 1, def: 20, unit: 'Hz' },
        { key: 'lowFreq', label: 'Low freq', min: 40, max: 500, step: 1, def: 120, unit: 'Hz' },
        { key: 'lowGain', label: 'Low gain', min: -18, max: 18, step: 0.1, def: 0, unit: 'dB' },
        { key: 'midFreq', label: 'Mid freq', min: 200, max: 8000, step: 1, def: 1000, unit: 'Hz' },
        { key: 'midGain', label: 'Mid gain', min: -18, max: 18, step: 0.1, def: 0, unit: 'dB' },
        { key: 'midQ', label: 'Mid Q', min: 0.1, max: 10, step: 0.1, def: 1, unit: '' },
        { key: 'highFreq', label: 'High freq', min: 2000, max: 16000, step: 10, def: 8000, unit: 'Hz' },
        { key: 'highGain', label: 'High gain', min: -18, max: 18, step: 0.1, def: 0, unit: 'dB' },
      ],
      create(ctx) {
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.707;
        const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf';
        const mid = ctx.createBiquadFilter(); mid.type = 'peaking';
        const hi = ctx.createBiquadFilter(); hi.type = 'highshelf';
        hp.connect(lo); lo.connect(mid); mid.connect(hi);
        return {
          input: hp, output: hi,
          set(p) {
            hp.frequency.value = p.hpf;
            lo.frequency.value = p.lowFreq; lo.gain.value = p.lowGain;
            mid.frequency.value = p.midFreq; mid.gain.value = p.midGain; mid.Q.value = p.midQ;
            hi.frequency.value = p.highFreq; hi.gain.value = p.highGain;
          },
          dispose() { disposeAll([hp, lo, mid, hi]); },
        };
      },
    },

    comp: {
      name: 'COMP',
      title: 'Compressor',
      params: [
        { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 0.5, def: -18, unit: 'dB' },
        { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, def: 4, unit: ':1' },
        { key: 'knee', label: 'Knee', min: 0, max: 40, step: 1, def: 6, unit: 'dB' },
        { key: 'attack', label: 'Attack', min: 0.1, max: 200, step: 0.1, def: 10, unit: 'ms' },
        { key: 'release', label: 'Release', min: 10, max: 1000, step: 1, def: 150, unit: 'ms' },
        { key: 'makeup', label: 'Makeup', min: 0, max: 24, step: 0.1, def: 0, unit: 'dB' },
      ],
      create(ctx) {
        const comp = ctx.createDynamicsCompressor();
        const makeup = ctx.createGain();
        comp.connect(makeup);
        return {
          input: comp, output: makeup,
          set(p) {
            comp.threshold.value = p.threshold;
            comp.ratio.value = p.ratio;
            comp.knee.value = p.knee;
            comp.attack.value = p.attack / 1000;
            comp.release.value = p.release / 1000;
            makeup.gain.value = U.dbToGain(p.makeup);
          },
          dispose() { disposeAll([comp, makeup]); },
        };
      },
    },

    delay: {
      name: 'DLY',
      title: 'Echo Delay',
      params: [
        { key: 'time', label: 'Time', min: 10, max: 2000, step: 1, def: 350, unit: 'ms' },
        { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, def: 0.35, unit: '' },
        { key: 'tone', label: 'Tone', min: 500, max: 16000, step: 10, def: 6000, unit: 'Hz' },
        { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.3, unit: '' },
      ],
      create(ctx) {
        const wd = wetDry(ctx);
        const delay = ctx.createDelay(2.5);
        const fb = ctx.createGain();
        const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
        wd.input.connect(delay);
        delay.connect(tone);
        tone.connect(fb);
        fb.connect(delay);
        tone.connect(wd.wet);
        return {
          input: wd.input, output: wd.output,
          set(p) {
            delay.delayTime.value = p.time / 1000;
            fb.gain.value = p.feedback;
            tone.frequency.value = p.tone;
            wd.setMix(p.mix);
          },
          dispose() { disposeAll([wd.input, wd.output, wd.dry, wd.wet, delay, fb, tone]); },
        };
      },
    },

    reverb: {
      name: 'VERB',
      title: 'Room Reverb',
      params: [
        { key: 'size', label: 'Decay', min: 0.2, max: 8, step: 0.1, def: 2, unit: 's' },
        { key: 'shape', label: 'Density', min: 1, max: 8, step: 0.1, def: 3, unit: '' },
        { key: 'predelay', label: 'Pre-delay', min: 0, max: 200, step: 1, def: 15, unit: 'ms' },
        { key: 'damp', label: 'Damping', min: 1000, max: 18000, step: 100, def: 7000, unit: 'Hz' },
        { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.25, unit: '' },
      ],
      create(ctx) {
        const wd = wetDry(ctx);
        const pre = ctx.createDelay(0.5);
        const conv = ctx.createConvolver();
        const damp = ctx.createBiquadFilter(); damp.type = 'lowpass';
        wd.input.connect(pre);
        pre.connect(conv);
        conv.connect(damp);
        damp.connect(wd.wet);
        let irKey = '';
        return {
          input: wd.input, output: wd.output,
          set(p) {
            const key = p.size + ':' + p.shape;
            if (key !== irKey) { conv.buffer = makeImpulse(ctx, p.size, p.shape); irKey = key; }
            pre.delayTime.value = p.predelay / 1000;
            damp.frequency.value = p.damp;
            wd.setMix(p.mix);
          },
          dispose() { disposeAll([wd.input, wd.output, wd.dry, wd.wet, pre, conv, damp]); },
        };
      },
    },

    gain: {
      name: 'TRIM',
      title: 'Trim / Phase',
      params: [
        { key: 'gain', label: 'Gain', min: -24, max: 24, step: 0.1, def: 0, unit: 'dB' },
        { key: 'invert', label: 'Phase invert', min: 0, max: 1, step: 1, def: 0, unit: '' },
      ],
      create(ctx) {
        const g = ctx.createGain();
        return {
          input: g, output: g,
          set(p) { g.gain.value = U.dbToGain(p.gain) * (p.invert ? -1 : 1); },
          dispose() { disposeAll([g]); },
        };
      },
    },
  };

  function defaults(type) {
    const out = {};
    for (const p of defs[type].params) out[p.key] = p.def;
    return out;
  }

  function create(ctx, type, params) {
    const fx = defs[type].create(ctx);
    fx.set(Object.assign(defaults(type), params));
    const set = fx.set;
    fx.set = (p) => set(Object.assign(defaults(type), p));
    return fx;
  }

  return { defs, defaults, create };
})();
