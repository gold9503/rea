// REA Studio — Edit window: ruler, track headers and the clip timeline.
REA.EditView = (() => {
  const U = REA.util;
  const HEADER_W = 210;
  const TRACK_H = 88;
  const RULER_H = 42;
  const EDGE = 7;
  const FADE_ZONE = 14;

  class EditView {
    constructor(app) {
      this.app = app;
      this.scroll = document.getElementById('edit-scroll');
      this.inner = document.getElementById('edit-inner');
      this.ruler = document.getElementById('ruler');
      this.lanes = document.getElementById('lanes');
      this.headers = document.getElementById('track-headers');
      this.drag = null;
      this.vw = 100;
      this.vh = 100;
      this.bind();
    }

    get pps() { return this.app.pps; }
    get sl() { return this.scroll.scrollLeft; }
    xAt(t) { return t * this.pps - this.sl; }
    timeAt(x) { return Math.max(0, (x + this.sl) / this.pps); }

    snap(t, force) {
      const app = this.app;
      if (!app.snap && !force) return t;
      const beat = 60 / app.project.bpm;
      const div = beat / app.gridDiv;
      return Math.max(0, Math.round(t / div) * div);
    }

    contentWidth() {
      const end = this.app.projectEnd();
      return Math.max(this.scroll.clientWidth, (end + 120) * this.pps);
    }

    layout() {
      const dpr = window.devicePixelRatio || 1;
      const tracks = this.app.project.tracks.length;
      this.vw = Math.max(50, this.scroll.clientWidth - HEADER_W);
      this.vh = Math.max(tracks * TRACK_H + TRACK_H, this.scroll.clientHeight - RULER_H);
      this.inner.style.width = (HEADER_W + this.contentWidth()) + 'px';
      for (const [c, w, h] of [[this.ruler, this.vw, RULER_H], [this.lanes, this.vw, this.vh]]) {
        c.style.width = w + 'px';
        c.style.height = h + 'px';
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
          c.width = Math.round(w * dpr);
          c.height = Math.round(h * dpr);
        }
      }
      this.headers.style.height = this.vh + 'px';
      this.draw();
    }

    // ---------- track headers ----------
    renderHeaders() {
      const app = this.app;
      this.headers.innerHTML = '';
      app.project.tracks.forEach((tr) => {
        const el = document.createElement('div');
        el.className = 'track-header' + (tr.id === app.selectedTrack ? ' selected' : '');
        el.style.height = TRACK_H + 'px';
        el.style.setProperty('--track-color', tr.color);
        el.innerHTML = `
          <div class="th-color"></div>
          <div class="th-main">
            <div class="th-row">
              <input class="th-name" value="" spellcheck="false" />
              <button class="th-del" title="트랙 삭제">✕</button>
            </div>
            <div class="th-row th-buttons">
              <button class="btn-rec ${tr.armed ? 'on' : ''}" title="녹음 대기 (Record arm)">●</button>
              <button class="btn-solo ${tr.solo ? 'on' : ''}" title="솔로">S</button>
              <button class="btn-mute ${tr.mute ? 'on' : ''}" title="뮤트">M</button>
              <span class="th-vol">${U.fmtDb(tr.volume)} dB</span>
            </div>
            <div class="th-row th-meter"><canvas class="meter-h" data-track="${tr.id}" width="160" height="6"></canvas></div>
          </div>`;
        const name = el.querySelector('.th-name');
        name.value = tr.name;
        name.addEventListener('change', () => { app.checkpoint(); tr.name = name.value || tr.name; app.changed({ mixer: true }); });
        name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
        el.querySelector('.th-del').onclick = () => app.deleteTrack(tr.id);
        el.querySelector('.btn-rec').onclick = () => app.toggleTrackFlag(tr.id, 'armed');
        el.querySelector('.btn-solo').onclick = () => app.toggleTrackFlag(tr.id, 'solo');
        el.querySelector('.btn-mute').onclick = () => app.toggleTrackFlag(tr.id, 'mute');
        el.addEventListener('pointerdown', () => { if (app.selectedTrack !== tr.id) { app.selectedTrack = tr.id; app.refreshSelection(); } });
        this.headers.appendChild(el);
      });
    }

    refreshHeaderSelection() {
      const els = this.headers.children;
      this.app.project.tracks.forEach((tr, i) => els[i] && els[i].classList.toggle('selected', tr.id === this.app.selectedTrack));
    }

    // ---------- hit testing ----------
    hit(x, y) {
      const tracks = this.app.project.tracks;
      const ti = Math.floor(y / TRACK_H);
      const track = tracks[ti] || null;
      const res = { ti, track, clip: null, zone: null, t: this.timeAt(x) };
      if (!track) return res;
      const top = ti * TRACK_H;
      for (let k = track.clips.length - 1; k >= 0; k--) {
        const c = track.clips[k];
        const x0 = this.xAt(c.start);
        const x1 = this.xAt(c.start + c.duration);
        if (x < x0 - 1 || x > x1 + 1) continue;
        res.clip = c;
        const yIn = y - top;
        const fi = x0 + c.fadeIn * this.pps;
        const fo = x1 - c.fadeOut * this.pps;
        if (yIn < FADE_ZONE + 2 && x <= Math.max(fi, x0 + 10) + 4 && x - x0 < (x1 - x0) / 2) res.zone = 'fadeIn';
        else if (yIn < FADE_ZONE + 2 && x >= Math.min(fo, x1 - 10) - 4 && x1 - x < (x1 - x0) / 2) res.zone = 'fadeOut';
        else if (x - x0 < EDGE) res.zone = 'left';
        else if (x1 - x < EDGE) res.zone = 'right';
        else res.zone = 'body';
        return res;
      }
      return res;
    }

    pos(e, el) {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    bind() {
      const app = this.app;
      this.scroll.addEventListener('scroll', () => this.draw());
      new ResizeObserver(() => this.layout()).observe(this.scroll);

      // Ctrl/⌘ + wheel zooms around the mouse.
      this.scroll.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const r = this.lanes.getBoundingClientRect();
        const x = e.clientX - r.left;
        app.zoom(e.deltaY < 0 ? 1.25 : 0.8, this.timeAt(x), x);
      }, { passive: false });

      this.lanes.addEventListener('pointerdown', (e) => this.onDown(e));
      this.lanes.addEventListener('pointermove', (e) => this.onMove(e));
      this.lanes.addEventListener('pointerup', (e) => this.onUp(e));
      this.lanes.addEventListener('dblclick', (e) => {
        const { x, y } = this.pos(e, this.lanes);
        const h = this.hit(x, y);
        if (h.clip) app.renameClip(h.clip);
      });

      this.ruler.addEventListener('pointerdown', (e) => {
        const { x, y } = this.pos(e, this.ruler);
        this.ruler.setPointerCapture(e.pointerId);
        this.drag = { kind: 'ruler', x0: x, t0: this.timeAt(x), y, moved: false };
      });
      this.ruler.addEventListener('pointermove', (e) => {
        if (!this.drag || this.drag.kind !== 'ruler') return;
        const { x } = this.pos(e, this.ruler);
        if (Math.abs(x - this.drag.x0) > 3) this.drag.moved = true;
        if (this.drag.moved) {
          const a = this.snap(this.drag.t0), b = this.snap(this.timeAt(x));
          app.setRange(Math.min(a, b), Math.max(a, b), null);
        }
      });
      this.ruler.addEventListener('pointerup', (e) => {
        const d = this.drag;
        this.drag = null;
        if (!d || d.kind !== 'ruler') return;
        if (!d.moved) {
          const m = d.y < 14 && app.project.markers.find((mk) => Math.abs(this.xAt(mk.time) - d.x0) < 8);
          app.locate(m ? m.time : this.snap(d.t0));
        } else {
          app.commitRange();
        }
      });

      // Drag & drop audio files onto the timeline.
      this.scroll.addEventListener('dragover', (e) => { e.preventDefault(); this.scroll.classList.add('dropping'); });
      this.scroll.addEventListener('dragleave', () => this.scroll.classList.remove('dropping'));
      this.scroll.addEventListener('drop', (e) => {
        e.preventDefault();
        this.scroll.classList.remove('dropping');
        const files = [...e.dataTransfer.files].filter((f) => /audio|video/.test(f.type) || /\.(wav|mp3|ogg|flac|m4a|aac|aif|aiff|webm)$/i.test(f.name));
        if (!files.length) return;
        const { x, y } = this.pos(e, this.lanes);
        const h = this.hit(Math.max(0, x), y);
        app.importFiles(files, h.track ? h.track.id : null, x >= 0 ? this.snap(h.t) : 0);
      });
    }

    onDown(e) {
      const app = this.app;
      const { x, y } = this.pos(e, this.lanes);
      const h = this.hit(x, y);
      this.lanes.setPointerCapture(e.pointerId);
      if (h.track && app.selectedTrack !== h.track.id) { app.selectedTrack = h.track.id; this.refreshHeaderSelection(); }

      if (app.tool === 'split') {
        if (h.clip) app.splitClip(h.track, h.clip, this.snap(h.t));
        return;
      }

      if (app.tool === 'select' || !h.clip) {
        if (app.tool === 'grab') app.selectedClips.clear();
        this.drag = { kind: 'range', t0: this.snap(h.t), ti0: Math.max(0, Math.min(h.ti, app.project.tracks.length - 1)), x0: x, moved: false };
        this.draw();
        return;
      }

      // Grabber on a clip
      const c = h.clip;
      if (e.shiftKey) {
        if (app.selectedClips.has(c.id)) app.selectedClips.delete(c.id); else app.selectedClips.add(c.id);
      } else if (!app.selectedClips.has(c.id)) {
        app.selectedClips.clear();
        app.selectedClips.add(c.id);
      }
      app.checkpoint();
      const orig = new Map();
      for (const tr of app.project.tracks) {
        for (const cl of tr.clips) {
          if (app.selectedClips.has(cl.id)) orig.set(cl.id, { start: cl.start, ti: app.project.tracks.indexOf(tr) });
        }
      }
      this.drag = {
        kind: h.zone, clip: c, track: h.track, ti0: h.ti, t0: h.t, x0: x, moved: false,
        orig, start: c.start, offset: c.offset, duration: c.duration, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
      };
      app.refreshSelection();
    }

    onMove(e) {
      const app = this.app;
      const { x, y } = this.pos(e, this.lanes);
      const d = this.drag;
      if (!d) { this.updateCursor(x, y); return; }
      if (Math.abs(x - d.x0) > 2) d.moved = true;
      const t = this.timeAt(x);
      const c = d.clip;
      const bufLen = c ? app.bufferDuration(c.bufferId) : 0;

      switch (d.kind) {
        case 'range': {
          if (!d.moved) return;
          const a = d.t0, b = this.snap(t);
          const ti1 = Math.max(0, Math.min(Math.floor(y / TRACK_H), app.project.tracks.length - 1));
          const ids = app.project.tracks.slice(Math.min(d.ti0, ti1), Math.max(d.ti0, ti1) + 1).map((tr) => tr.id);
          app.setRange(Math.min(a, b), Math.max(a, b), ids);
          break;
        }
        case 'body': {
          if (!d.moved) return;
          const o0 = d.orig.get(c.id);
          const newStart = this.snap(Math.max(0, o0.start + (t - d.t0)));
          let dt = newStart - o0.start;
          let minStart = Infinity;
          for (const o of d.orig.values()) minStart = Math.min(minStart, o.start);
          if (minStart + dt < 0) dt = -minStart;
          const tracks = app.project.tracks;
          let dTi = Math.floor(y / TRACK_H) - d.ti0;
          let lo = Infinity, hi = -Infinity;
          for (const o of d.orig.values()) { lo = Math.min(lo, o.ti); hi = Math.max(hi, o.ti); }
          dTi = Math.max(-lo, Math.min(tracks.length - 1 - hi, dTi));
          for (const [id, o] of d.orig) {
            const found = app.findClip(id);
            if (!found) continue;
            found.clip.start = o.start + dt;
            const target = tracks[o.ti + dTi];
            if (target !== found.track) {
              found.track.clips.splice(found.track.clips.indexOf(found.clip), 1);
              target.clips.push(found.clip);
            }
          }
          break;
        }
        case 'left': {
          const end = d.start + d.duration;
          const ns = Math.min(end - 0.01, Math.max(d.start - d.offset, this.snap(t), 0));
          c.start = ns;
          c.offset = d.offset + (ns - d.start);
          c.duration = end - ns;
          c.fadeIn = Math.min(c.fadeIn, c.duration - c.fadeOut);
          break;
        }
        case 'right': {
          const ne = Math.max(d.start + 0.01, Math.min(this.snap(t), d.start + (bufLen - d.offset)));
          c.duration = ne - d.start;
          c.fadeOut = Math.min(c.fadeOut, c.duration - c.fadeIn);
          break;
        }
        case 'fadeIn':
          c.fadeIn = U.clamp(t - c.start, 0, c.duration - c.fadeOut);
          break;
        case 'fadeOut':
          c.fadeOut = U.clamp(c.start + c.duration - t, 0, c.duration - c.fadeIn);
          break;
      }
      this.draw();
    }

    onUp() {
      const app = this.app;
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.kind === 'range') {
        if (!d.moved) {
          app.setRange(0, 0, null);
          app.locate(d.t0);
        } else {
          app.commitRange();
          app.locate(app.project.loop.start, true);
        }
        app.refreshSelection();
        return;
      }
      if (!d.moved && (d.kind === 'body')) {
        app.dropCheckpoint();
        return;
      }
      app.changed({ clips: true });
    }

    updateCursor(x, y) {
      const app = this.app;
      let cur = 'default';
      if (app.tool === 'select') cur = 'text';
      else if (app.tool === 'split') cur = 'crosshair';
      else {
        const h = this.hit(x, y);
        if (h.zone === 'left' || h.zone === 'right') cur = 'ew-resize';
        else if (h.zone === 'fadeIn' || h.zone === 'fadeOut') cur = 'nwse-resize';
        else if (h.zone === 'body') cur = 'grab';
        else cur = 'text';
      }
      this.lanes.style.cursor = cur;
    }

    // ---------- drawing ----------
    draw() {
      this.drawRuler();
      this.drawLanes();
    }

    gridStep() {
      const p = this.app.project;
      const beat = 60 / p.bpm;
      const bar = beat * p.beatsPerBar;
      let barsPerLabel = 1;
      while (bar * barsPerLabel * this.pps < 48) barsPerLabel *= 2;
      return { beat, bar, barsPerLabel };
    }

    drawRuler() {
      const app = this.app;
      const p = app.project;
      const dpr = window.devicePixelRatio || 1;
      const g = this.ruler.getContext('2d');
      const W = this.vw;
      const css = getComputedStyle(document.documentElement);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = css.getPropertyValue('--ruler-bg').trim();
      g.fillRect(0, 0, W, RULER_H);

      // loop/selection strip
      const L = p.loop;
      if (L.end > L.start) {
        g.fillStyle = L.enabled ? css.getPropertyValue('--loop-on').trim() : css.getPropertyValue('--loop-off').trim();
        g.fillRect(this.xAt(L.start), 0, (L.end - L.start) * this.pps, 13);
      }

      const { beat, bar, barsPerLabel } = this.gridStep();
      const t0 = this.timeAt(0), t1 = this.timeAt(W);
      g.font = '11px ui-monospace, Menlo, Consolas, monospace';
      g.textBaseline = 'middle';
      g.strokeStyle = css.getPropertyValue('--ruler-tick').trim();
      g.fillStyle = css.getPropertyValue('--ruler-text').trim();
      g.beginPath();
      for (let b = Math.floor(t0 / bar); b * bar <= t1; b++) {
        const x = Math.round(this.xAt(b * bar)) + 0.5;
        if (b % barsPerLabel === 0) {
          g.moveTo(x, 14); g.lineTo(x, 28);
          g.fillText(String(b + 1), x + 3, 21);
        } else {
          g.moveTo(x, 22); g.lineTo(x, 28);
        }
        if (beat * this.pps > 10) {
          for (let k = 1; k < p.beatsPerBar; k++) {
            const xb = Math.round(this.xAt(b * bar + k * beat)) + 0.5;
            g.moveTo(xb, 24); g.lineTo(xb, 28);
          }
        }
      }
      // minutes:seconds row
      let step = 1;
      for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) { step = s; if (s * this.pps >= 70) break; }
      for (let s = Math.floor(t0 / step) * step; s <= t1; s += step) {
        const x = Math.round(this.xAt(s)) + 0.5;
        g.moveTo(x, 34); g.lineTo(x, RULER_H);
        const m = Math.floor(s / 60);
        const sec = s - m * 60;
        g.fillText(m + ':' + (step < 1 ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0')), x + 3, 36);
      }
      g.stroke();
      g.fillStyle = css.getPropertyValue('--ruler-line').trim();
      g.fillRect(0, 28, W, 1);
      g.fillRect(0, RULER_H - 1, W, 1);

      // markers
      g.fillStyle = css.getPropertyValue('--marker').trim();
      for (const m of p.markers) {
        const x = this.xAt(m.time);
        if (x < -100 || x > W) continue;
        g.beginPath();
        g.moveTo(x, 1); g.lineTo(x + 7, 1); g.lineTo(x + 7, 8); g.lineTo(x, 13); g.closePath();
        g.fill();
        g.fillText(m.name, x + 10, 7);
      }

      // playhead
      const px = this.xAt(app.displayPos());
      g.fillStyle = css.getPropertyValue('--playhead').trim();
      g.beginPath();
      g.moveTo(px - 6, 14); g.lineTo(px + 6, 14); g.lineTo(px, 22); g.closePath();
      g.fill();
      g.fillRect(Math.round(px), 22, 1, RULER_H - 22);
    }

    drawLanes() {
      const app = this.app;
      const p = app.project;
      const dpr = window.devicePixelRatio || 1;
      const g = this.lanes.getContext('2d');
      const W = this.vw, H = this.vh;
      const css = getComputedStyle(document.documentElement);
      const v = (k) => css.getPropertyValue(k).trim();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = v('--lane-empty');
      g.fillRect(0, 0, W, H);

      p.tracks.forEach((tr, i) => {
        g.fillStyle = tr.id === app.selectedTrack ? v('--lane-sel') : (i % 2 ? v('--lane-b') : v('--lane-a'));
        g.fillRect(0, i * TRACK_H, W, TRACK_H);
        g.fillStyle = v('--lane-line');
        g.fillRect(0, (i + 1) * TRACK_H - 1, W, 1);
      });

      // grid
      const { beat, bar } = this.gridStep();
      const t0 = this.timeAt(0), t1 = this.timeAt(W);
      const lanesH = p.tracks.length * TRACK_H;
      for (let b = Math.floor(t0 / bar); b * bar <= t1; b++) {
        g.fillStyle = v('--grid-bar');
        if (bar * this.pps >= 6) g.fillRect(Math.round(this.xAt(b * bar)), 0, 1, lanesH);
        if (beat * this.pps >= 12) {
          g.fillStyle = v('--grid-beat');
          for (let k = 1; k < p.beatsPerBar; k++) g.fillRect(Math.round(this.xAt(b * bar + k * beat)), 0, 1, lanesH);
        }
      }

      // time selection
      const L = p.loop;
      if (L.end > L.start) {
        g.fillStyle = v('--selection');
        const x = this.xAt(L.start), w = (L.end - L.start) * this.pps;
        p.tracks.forEach((tr, i) => {
          if (!app.rangeTracks || app.rangeTracks.includes(tr.id)) g.fillRect(x, i * TRACK_H, w, TRACK_H - 1);
        });
      }

      // clips
      p.tracks.forEach((tr, i) => {
        for (const c of tr.clips) this.drawClip(g, tr, c, i * TRACK_H, W, v);
      });

      // live recording overlay
      if (app.engine.recording) {
        const s = app.engine.recordStartPos();
        const e = app.displayPos();
        p.tracks.forEach((tr, i) => {
          if (!tr.armed) return;
          g.fillStyle = v('--rec-fill');
          g.fillRect(this.xAt(s), i * TRACK_H + 2, (e - s) * this.pps, TRACK_H - 5);
        });
      }

      // markers
      g.fillStyle = v('--marker-line');
      for (const m of p.markers) g.fillRect(Math.round(this.xAt(m.time)), 0, 1, lanesH);

      // playhead
      g.fillStyle = v('--playhead');
      g.fillRect(Math.round(this.xAt(app.displayPos())), 0, 1, H);
    }

    drawClip(g, tr, c, top, W, v) {
      const app = this.app;
      const x0 = this.xAt(c.start);
      const x1 = this.xAt(c.start + c.duration);
      if (x1 < 0 || x0 > W) return;
      const y = top + 2, h = TRACK_H - 5;
      const sel = app.selectedClips.has(c.id);
      const w = Math.max(1, x1 - x0);

      g.save();
      g.beginPath();
      g.rect(x0, y, w, h);
      g.clip();
      g.fillStyle = tr.color + (sel ? 'aa' : '66');
      g.fillRect(x0, y, w, h);
      g.fillStyle = tr.color;
      g.fillRect(x0, y, w, 14);

      // waveform
      const b = app.buffers.get(c.bufferId);
      if (b && b.peaks) {
        const pk = b.peaks;
        const sr = b.buffer.sampleRate;
        const mid = y + 14 + (h - 14) / 2;
        const amp = ((h - 18) / 2) * Math.min(4, U.dbToGain(c.gain || 0));
        g.fillStyle = v('--wave');
        const px0 = Math.max(0, Math.floor(x0)), px1 = Math.min(W, Math.ceil(x1));
        for (let px = px0; px < px1; px++) {
          const ta = this.timeAt(px) - c.start + c.offset;
          const tb = this.timeAt(px + 1) - c.start + c.offset;
          let i0 = Math.floor((ta * sr) / pk.spp);
          const i1 = Math.max(i0 + 1, Math.ceil((tb * sr) / pk.spp));
          let lo = 0, hi = 0;
          for (; i0 < i1 && i0 < pk.min.length; i0++) {
            if (i0 < 0) continue;
            if (pk.min[i0] < lo) lo = pk.min[i0];
            if (pk.max[i0] > hi) hi = pk.max[i0];
          }
          const top2 = mid - Math.min(1, hi) * amp;
          const bot = mid - Math.max(-1, lo) * amp;
          g.fillRect(px, top2, 1, Math.max(1, bot - top2));
        }
      }

      // fades
      g.fillStyle = v('--fade-fill');
      g.strokeStyle = v('--fade-line');
      g.lineWidth = 1;
      if (c.fadeIn > 0) {
        const fx = x0 + c.fadeIn * this.pps;
        g.beginPath(); g.moveTo(x0, y + 14); g.lineTo(fx, y + 14); g.lineTo(x0, y + h); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(x0, y + h); g.lineTo(fx, y + 14); g.stroke();
      }
      if (c.fadeOut > 0) {
        const fx = x1 - c.fadeOut * this.pps;
        g.beginPath(); g.moveTo(x1, y + 14); g.lineTo(fx, y + 14); g.lineTo(x1, y + h); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(fx, y + 14); g.lineTo(x1, y + h); g.stroke();
      }

      // label
      g.fillStyle = v('--clip-text');
      g.font = '11px system-ui, sans-serif';
      g.textBaseline = 'middle';
      const label = c.name + (c.gain ? `  (${U.fmtDb(c.gain)} dB)` : '');
      g.fillText(label, Math.max(x0, 0) + 5, y + 7);
      g.restore();

      g.strokeStyle = sel ? v('--clip-sel') : 'rgba(0,0,0,.5)';
      g.lineWidth = sel ? 2 : 1;
      g.strokeRect(x0 + 0.5, y + 0.5, w - 1, h - 1);
    }
  }

  EditView.HEADER_W = HEADER_W;
  EditView.TRACK_H = TRACK_H;
  return EditView;
})();
