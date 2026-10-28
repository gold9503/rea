// REA Studio — audio engine: mixer graph, transport, metronome, recording, bounce.
REA.Engine = (() => {
  const U = REA.util;

  const RECORDER_WORKLET = `
class ReaRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.chunks = null;
    this.frames = 0;
    this.first = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.chunks = null; this.frames = 0; }
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.chunks || !this.frames) return;
    const out = this.chunks.map((list) => {
      const a = new Float32Array(this.frames);
      let o = 0;
      for (const c of list) { a.set(c, o); o += c.length; }
      return a;
    });
    this.port.postMessage({ frame: this.first, ch: out }, out.map((a) => a.buffer));
    this.chunks = null;
    this.frames = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.on && inp && inp.length) {
      if (!this.chunks) { this.chunks = inp.map(() => []); this.first = currentFrame; }
      inp.forEach((c, i) => this.chunks[i] && this.chunks[i].push(c.slice(0)));
      this.frames += inp[0].length;
      if (this.frames >= 8192) this.flush();
    }
    return true;
  }
}
registerProcessor('rea-recorder', ReaRecorder);
`;

  // A channel strip: input → [inserts] → post → fader → panner → dest (+ analyser tap)
  function createStrip(ctx, dest) {
    const input = ctx.createGain();
    const post = ctx.createGain();
    const fader = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    input.connect(post);
    post.connect(fader);
    fader.connect(panner);
    panner.connect(dest);
    panner.connect(analyser);
    return { input, post, fader, panner, analyser, plugins: [], sig: '', level: 0, buf: new Float32Array(1024) };
  }

  function syncStrip(ctx, strip, chan, gain, live) {
    const active = (chan.inserts || []).filter((i) => i && i.type && !i.bypass);
    const sig = active.map((i) => i.id + ':' + i.type).join('|');
    if (sig !== strip.sig) {
      strip.input.disconnect();
      strip.plugins.forEach((p) => p.dispose());
      strip.plugins = active.map((i) => REA.effects.create(ctx, i.type, i.params));
      let prev = strip.input;
      for (const p of strip.plugins) { prev.connect(p.input); prev = p.output; }
      prev.connect(strip.post);
      strip.sig = sig;
    } else {
      strip.plugins.forEach((p, k) => p.set(active[k].params));
    }
    if (live) {
      strip.fader.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
      strip.panner.pan.setTargetAtTime(chan.pan || 0, ctx.currentTime, 0.01);
    } else {
      strip.fader.gain.value = gain;
      strip.panner.pan.value = chan.pan || 0;
    }
  }

  function destroyStrip(strip) {
    [strip.input, strip.post, strip.fader, strip.panner, strip.analyser].forEach((n) => n.disconnect());
    strip.plugins.forEach((p) => p.dispose());
  }

  function trackGain(track, anySolo) {
    if (track.mute || (anySolo && !track.solo)) return 0;
    return U.dbToGain(track.volume);
  }

  // Clip gain envelope (clip gain × fades) at timeline time t.
  function clipEnvAt(c, t) {
    let v = 1;
    const rel = t - c.start;
    const toEnd = c.start + c.duration - t;
    if (c.fadeIn > 0 && rel < c.fadeIn) v = Math.min(v, rel / c.fadeIn);
    if (c.fadeOut > 0 && toEnd < c.fadeOut) v = Math.min(v, toEnd / c.fadeOut);
    return U.dbToGain(c.gain || 0) * Math.max(0, v);
  }

  // Schedule every clip overlapping [from, until) so that timeline time `from` plays at ctx time `when0`.
  function scheduleClips(ctx, project, buffers, inputFor, from, when0, until) {
    const out = [];
    const T = (t) => when0 + (t - from);
    for (const tr of project.tracks) {
      const dest = inputFor(tr.id);
      if (!dest) continue;
      for (const c of tr.clips) {
        const b = buffers.get(c.bufferId);
        if (!b) continue;
        const end = Math.min(c.start + c.duration, until);
        if (end <= from || c.start >= until) continue;
        const s = Math.max(c.start, from);
        const src = ctx.createBufferSource();
        src.buffer = b.buffer;
        const g = ctx.createGain();
        src.connect(g);
        g.connect(dest);
        const pts = [c.start + c.fadeIn, c.start + c.duration - c.fadeOut, end]
          .filter((t) => t > s && t <= end)
          .sort((a, b2) => a - b2);
        g.gain.setValueAtTime(clipEnvAt(c, s), T(s));
        for (const t of pts) g.gain.linearRampToValueAtTime(clipEnvAt(c, t), T(t));
        src.start(T(s), c.offset + (s - c.start), end - s);
        out.push({ src, g });
      }
    }
    return out;
  }

  class Engine {
    constructor(app) {
      this.app = app;
      this.ctx = null;
      this.strips = new Map();
      this.master = null;
      this.live = new Set();
      this.segs = [];
      this.playing = false;
      this.recording = false;
      this.rec = null;
      this.timer = null;
      this.metroFrom = 0;
      this.micStream = null;
      this.workletReady = null;
    }

    init() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = createStrip(ctx, ctx.destination);
      this.clickBus = ctx.createGain();
      this.clickBus.gain.value = 0.6;
      this.clickBus.connect(ctx.destination);
      return ctx;
    }

    async resume() {
      this.init();
      if (this.ctx.state !== 'running') await this.ctx.resume();
    }

    get sampleRate() { return this.init().sampleRate; }

    // Bring the live graph in line with the project (tracks, inserts, faders, pans, mute/solo).
    sync() {
      const ctx = this.init();
      const p = this.app.project;
      const anySolo = p.tracks.some((t) => t.solo);
      const ids = new Set();
      for (const tr of p.tracks) {
        ids.add(tr.id);
        let s = this.strips.get(tr.id);
        if (!s) { s = createStrip(ctx, this.master.input); this.strips.set(tr.id, s); }
        syncStrip(ctx, s, tr, trackGain(tr, anySolo), true);
      }
      for (const [id, s] of this.strips) {
        if (!ids.has(id)) { destroyStrip(s); this.strips.delete(id); }
      }
      syncStrip(ctx, this.master, p.master, U.dbToGain(p.master.volume), true);
    }

    activeLoop() {
      const L = this.app.project.loop;
      if (this.recording || !L.enabled || !(L.end - L.start > 0.05)) return null;
      return L;
    }

    play(from) {
      const ctx = this.init();
      if (ctx.state !== 'running') ctx.resume();
      this.stopSources();
      this.sync();
      const loop = this.activeLoop();
      if (loop && (from < loop.start || from >= loop.end)) from = loop.start;
      const when0 = ctx.currentTime + 0.05;
      this.segs = [];
      this.addSeg(when0, from, loop ? loop.end : Infinity);
      this.metroFrom = when0;
      this.playing = true;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), 25);
    }

    addSeg(ctx0, pos0, posEnd) {
      const srcs = scheduleClips(this.ctx, this.app.project, this.app.buffers,
        (id) => this.strips.get(id) && this.strips.get(id).input, pos0, ctx0, posEnd);
      for (const s of srcs) {
        this.live.add(s);
        s.src.onended = () => { this.live.delete(s); s.g.disconnect(); };
      }
      this.segs.push({ ctx0, pos0, posEnd });
    }

    tick() {
      if (!this.playing) return;
      const now = this.ctx.currentTime;
      const last = this.segs[this.segs.length - 1];
      if (last.posEnd !== Infinity) {
        const endCtx = last.ctx0 + (last.posEnd - last.pos0);
        if (endCtx - now < 0.25) {
          const loop = this.activeLoop();
          if (loop) this.addSeg(endCtx, loop.start, loop.end);
          else this.addSeg(endCtx, last.posEnd, Infinity);
        }
      }
      while (this.segs.length > 1 && this.segs[1].ctx0 <= now) this.segs.shift();
      this.metroTick();
    }

    position() {
      if (!this.playing || !this.segs.length) return this.app.playhead;
      const now = this.ctx.currentTime;
      let seg = this.segs[0];
      for (const s of this.segs) if (s.ctx0 <= now) seg = s;
      return Math.min(seg.pos0 + Math.max(0, now - seg.ctx0), seg.posEnd);
    }

    stopSources() {
      for (const s of this.live) {
        s.src.onended = null;
        try { s.src.stop(); } catch (e) { /* not started */ }
        s.g.disconnect();
      }
      this.live.clear();
    }

    async stop() {
      const pos = this.position();
      clearInterval(this.timer);
      this.timer = null;
      this.stopSources();
      this.playing = false;
      this.segs = [];
      if (this.recording) await this.finishRecording();
      return pos;
    }

    // ---- metronome ----
    metroTick() {
      const p = this.app.project;
      if (!this.app.clickEnabled) { this.metroFrom = this.ctx.currentTime + 0.15; return; }
      const ahead = this.ctx.currentTime + 0.15;
      const beat = 60 / p.bpm;
      for (const seg of this.segs) {
        const segEndCtx = seg.posEnd === Infinity ? Infinity : seg.ctx0 + (seg.posEnd - seg.pos0);
        const fromCtx = Math.max(this.metroFrom, seg.ctx0);
        const toCtx = Math.min(ahead, segEndCtx);
        if (toCtx <= fromCtx) continue;
        const fromPos = seg.pos0 + (fromCtx - seg.ctx0);
        for (let k = Math.ceil(fromPos / beat - 1e-9); ; k++) {
          const ct = seg.ctx0 + (k * beat - seg.pos0);
          if (ct >= toCtx) break;
          if (ct >= fromCtx) this.click(ct, k % p.beatsPerBar === 0);
        }
      }
      this.metroFrom = ahead;
    }

    click(when, accent) {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = accent ? 1760 : 1100;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.5, when + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      o.connect(g);
      g.connect(this.clickBus);
      o.start(when);
      o.stop(when + 0.06);
      o.onended = () => g.disconnect();
    }

    // ---- metering ----
    levelOf(strip) {
      if (!strip) return 0;
      strip.analyser.getFloatTimeDomainData(strip.buf);
      let peak = 0;
      for (let i = 0; i < strip.buf.length; i++) {
        const a = Math.abs(strip.buf[i]);
        if (a > peak) peak = a;
      }
      strip.level = Math.max(peak, strip.level * 0.88);
      return strip.level;
    }

    trackLevel(id) { return this.ctx ? this.levelOf(this.strips.get(id)) : 0; }
    masterLevel() { return this.ctx ? this.levelOf(this.master) : 0; }

    // ---- recording ----
    async startRecording(from) {
      await this.resume();
      const ctx = this.ctx;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('이 브라우저는 마이크 입력을 지원하지 않습니다 (HTTPS 또는 localhost 필요).');
      }
      if (!this.micStream) {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      }
      if (!this.workletReady) {
        const url = URL.createObjectURL(new Blob([RECORDER_WORKLET], { type: 'application/javascript' }));
        this.workletReady = ctx.audioWorklet.addModule(url);
      }
      await this.workletReady;
      const src = ctx.createMediaStreamSource(this.micStream);
      const node = new AudioWorkletNode(ctx, 'rea-recorder', { numberOfInputs: 1, numberOfOutputs: 1 });
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      const chunks = [];
      let resolveDone;
      const done = new Promise((r) => { resolveDone = r; });
      node.port.onmessage = (e) => { if (e.data.done) resolveDone(); else chunks.push(e.data); };
      this.recording = true;
      this.play(from);
      this.rec = { src, node, sink, chunks, done, seg: this.segs[0], trackIds: this.app.project.tracks.filter((t) => t.armed).map((t) => t.id) };
      node.port.postMessage('start');
    }

    recordStartPos() {
      return this.rec ? this.rec.seg.pos0 : 0;
    }

    async finishRecording() {
      const rec = this.rec;
      this.recording = false;
      this.rec = null;
      if (!rec) return;
      rec.node.port.postMessage('stop');
      await Promise.race([rec.done, new Promise((r) => setTimeout(r, 500))]);
      rec.src.disconnect();
      rec.node.disconnect();
      rec.sink.disconnect();
      const sr = this.ctx.sampleRate;
      const startFrame = Math.ceil(rec.seg.ctx0 * sr);
      const chunks = rec.chunks.filter((c) => c.frame + c.ch[0].length > startFrame);
      if (!chunks.length) return;
      const first = chunks[0].frame;
      const numCh = Math.max(...chunks.map((c) => c.ch.length));
      const total = chunks.reduce((n, c) => n + c.ch[0].length, 0);
      const buffer = new AudioBuffer({ length: total, numberOfChannels: numCh, sampleRate: sr });
      let o = 0;
      for (const c of chunks) {
        for (let ch = 0; ch < numCh; ch++) buffer.getChannelData(ch).set(c.ch[Math.min(ch, c.ch.length - 1)], o);
        o += c.ch[0].length;
      }
      const latency = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
      const startPos = rec.seg.pos0 + (first / sr - rec.seg.ctx0) - latency;
      this.app.onRecorded(buffer, startPos, rec.trackIds);
    }

    // ---- offline mixdown ----
    async bounce(start, end) {
      const p = this.app.project;
      const sr = this.sampleRate;
      const len = Math.max(1, Math.ceil((end - start) * sr));
      const oc = new OfflineAudioContext(2, len, sr);
      const master = createStrip(oc, oc.destination);
      syncStrip(oc, master, p.master, U.dbToGain(p.master.volume), false);
      const anySolo = p.tracks.some((t) => t.solo);
      const strips = new Map();
      for (const tr of p.tracks) {
        const s = createStrip(oc, master.input);
        syncStrip(oc, s, tr, trackGain(tr, anySolo), false);
        strips.set(tr.id, s);
      }
      scheduleClips(oc, p, this.app.buffers, (id) => strips.get(id).input, start, 0, end);
      return oc.startRendering();
    }
  }

  Engine.clipEnvAt = clipEnvAt;
  return Engine;
})();
