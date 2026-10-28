// REA Studio — application state, actions, transport UI and keyboard shortcuts.
(() => {
  const U = REA.util;
  const COLORS = ['#4f9dde', '#e0794f', '#5cc28a', '#c96bd6', '#e3c14b', '#4fc7c7', '#e05a7a', '#8f9be8'];
  const FILE_FORMAT = 'rea-studio-project';

  function newProject() {
    return {
      version: 1,
      name: 'Untitled Session',
      bpm: 120,
      beatsPerBar: 4,
      tracks: [],
      master: { volume: 0, pan: 0, inserts: [] },
      loop: { enabled: false, start: 0, end: 0 },
      markers: [],
    };
  }

  class App {
    constructor() {
      this.project = newProject();
      this.buffers = new Map();
      this.engine = new REA.Engine(this);
      this.playhead = 0;
      this.pps = 40;
      this.tool = 'grab';
      this.snap = true;
      this.gridDiv = 1;
      this.clickEnabled = false;
      this.selectedClips = new Set();
      this.selectedTrack = null;
      this.rangeTracks = null;
      this.clipboard = null;
      this.undoStack = [];
      this.redoStack = [];
      this.counterMode = 'bars';
      this.view = 'edit';
      this.persisted = new Set();
      this.saveSoon = U.debounce(() => this.persist(), 800);
      this.edit = new REA.EditView(this);
      this.mix = new REA.MixView(this);
      this.bindUI();
      this.bindKeys();
      this.render();
      this.restore();
      requestAnimationFrame(() => this.frame());
    }

    // ---------- helpers ----------
    status(msg, isError) {
      const el = document.getElementById('status');
      el.textContent = msg;
      el.classList.toggle('error', !!isError);
      clearTimeout(this.statusTimer);
      this.statusTimer = setTimeout(() => { el.textContent = ''; }, 6000);
    }

    projectEnd() {
      let end = 0;
      for (const tr of this.project.tracks) for (const c of tr.clips) end = Math.max(end, c.start + c.duration);
      return end;
    }

    bufferDuration(id) {
      const b = this.buffers.get(id);
      return b ? b.buffer.duration : 0;
    }

    findClip(id) {
      for (const track of this.project.tracks) {
        const clip = track.clips.find((c) => c.id === id);
        if (clip) return { track, clip };
      }
      return null;
    }

    selectedClipList() {
      const out = [];
      for (const track of this.project.tracks) for (const clip of track.clips) if (this.selectedClips.has(clip.id)) out.push({ track, clip });
      return out;
    }

    displayPos() {
      return this.engine.playing ? this.engine.position() : this.playhead;
    }

    hasRange() {
      const L = this.project.loop;
      return L.end - L.start > 0.001;
    }

    // ---------- history ----------
    checkpoint() {
      this.undoStack.push(JSON.stringify(this.project));
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }

    dropCheckpoint() {
      this.undoStack.pop();
    }

    undo() {
      if (!this.undoStack.length) { this.status('더 이상 실행 취소할 작업이 없습니다'); return; }
      this.redoStack.push(JSON.stringify(this.project));
      this.project = JSON.parse(this.undoStack.pop());
      this.afterRestore();
      this.status('실행 취소');
    }

    redo() {
      if (!this.redoStack.length) return;
      this.undoStack.push(JSON.stringify(this.project));
      this.project = JSON.parse(this.redoStack.pop());
      this.afterRestore();
      this.status('다시 실행');
    }

    afterRestore() {
      const ids = new Set();
      this.project.tracks.forEach((tr) => tr.clips.forEach((c) => ids.add(c.id)));
      for (const id of [...this.selectedClips]) if (!ids.has(id)) this.selectedClips.delete(id);
      if (!this.project.tracks.some((t) => t.id === this.selectedTrack)) this.selectedTrack = this.project.tracks[0] ? this.project.tracks[0].id : null;
      this.changed({ clips: true });
    }

    // Called after any model mutation.
    changed(opts = {}) {
      this.engine.sync();
      this.render();
      this.save();
      if (opts.clips && this.engine.playing && !this.engine.recording) this.engine.play(this.engine.position());
    }

    liveParamChange() {
      this.engine.sync();
      this.edit.renderHeaders();
      this.save();
    }

    save() { this.saveSoon(); }

    render() {
      this.edit.renderHeaders();
      this.edit.layout();
      this.mix.render();
      this.updateTransportUI();
      document.getElementById('empty-hint').hidden = this.project.tracks.length > 0;
      const name = document.getElementById('project-name');
      if (document.activeElement !== name) name.value = this.project.name;
      document.getElementById('bpm').value = this.project.bpm;
      document.getElementById('meter').value = this.project.beatsPerBar;
    }

    refreshSelection() {
      this.edit.refreshHeaderSelection();
      this.mix.refreshSelection();
      this.edit.draw();
    }

    // ---------- tracks ----------
    makeTrack(name) {
      const n = this.project.tracks.length;
      return {
        id: U.uid('trk'),
        name: name || `Audio ${n + 1}`,
        color: COLORS[n % COLORS.length],
        volume: 0,
        pan: 0,
        mute: false,
        solo: false,
        armed: false,
        inserts: [],
        clips: [],
      };
    }

    addTrack(name) {
      this.checkpoint();
      const tr = this.makeTrack(name);
      this.project.tracks.push(tr);
      this.selectedTrack = tr.id;
      this.changed();
      return tr;
    }

    deleteTrack(id) {
      const tr = this.project.tracks.find((t) => t.id === id);
      if (!tr) return;
      if (tr.clips.length && !confirm(`"${tr.name}" 트랙과 클립 ${tr.clips.length}개를 삭제할까요?`)) return;
      this.checkpoint();
      this.project.tracks = this.project.tracks.filter((t) => t.id !== id);
      tr.clips.forEach((c) => this.selectedClips.delete(c.id));
      if (this.selectedTrack === id) this.selectedTrack = this.project.tracks[0] ? this.project.tracks[0].id : null;
      this.changed({ clips: true });
    }

    toggleTrackFlag(id, flag) {
      const tr = this.project.tracks.find((t) => t.id === id);
      if (!tr) return;
      if (flag === 'armed' && this.engine.recording) { this.status('녹음 중에는 녹음 대기를 바꿀 수 없습니다'); return; }
      this.checkpoint();
      tr[flag] = !tr[flag];
      this.changed();
    }

    // ---------- audio & clips ----------
    addBuffer(name, buffer, id) {
      id = id || U.uid('aud');
      this.buffers.set(id, { name, buffer, peaks: U.computePeaks(buffer) });
      return id;
    }

    makeClip(bufferId, start, name) {
      const b = this.buffers.get(bufferId);
      return { id: U.uid('clp'), bufferId, name, start, offset: 0, duration: b.buffer.duration, fadeIn: 0, fadeOut: 0, gain: 0 };
    }

    async importFiles(files, trackId, at = 0) {
      const ctx = this.engine.init();
      this.checkpoint();
      let target = trackId ? this.project.tracks.find((t) => t.id === trackId) : null;
      let ok = 0;
      for (const f of files) {
        this.status(`가져오는 중: ${f.name}…`);
        try {
          const data = await f.arrayBuffer();
          const buffer = await ctx.decodeAudioData(data);
          const id = this.addBuffer(U.baseName(f.name), buffer);
          if (!target) {
            target = this.makeTrack(U.baseName(f.name));
            this.project.tracks.push(target);
          }
          const clip = this.makeClip(id, at, U.baseName(f.name));
          target.clips.push(clip);
          this.selectedTrack = target.id;
          target = null;
          ok++;
        } catch (e) {
          this.status(`"${f.name}"을(를) 디코딩할 수 없습니다: ${e.message || e}`, true);
        }
      }
      if (!ok) { this.dropCheckpoint(); return; }
      this.changed({ clips: true });
      this.status(`${ok}개 파일을 가져왔습니다`);
    }

    onRecorded(buffer, startPos, trackIds) {
      this.checkpoint();
      const take = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
      const id = this.addBuffer('Rec ' + take, buffer);
      for (const tid of trackIds) {
        const tr = this.project.tracks.find((t) => t.id === tid);
        if (!tr) continue;
        const clip = this.makeClip(id, Math.max(0, startPos), `${tr.name}_${take}`);
        if (startPos < 0) { clip.offset = -startPos; clip.duration = Math.max(0.01, clip.duration + startPos); }
        tr.clips.push(clip);
      }
      this.changed({ clips: true });
      this.status(`녹음 완료: ${buffer.duration.toFixed(2)}초`);
    }

    renameClip(clip) {
      const name = prompt('클립 이름', clip.name);
      if (name === null || !name.trim()) return;
      this.checkpoint();
      clip.name = name.trim();
      this.changed();
    }

    splitInternal(track, clip, t) {
      if (t <= clip.start + 0.001 || t >= clip.start + clip.duration - 0.001) return null;
      const right = Object.assign({}, clip, {
        id: U.uid('clp'),
        start: t,
        offset: clip.offset + (t - clip.start),
        duration: clip.start + clip.duration - t,
        fadeIn: 0,
        fadeOut: Math.min(clip.fadeOut, clip.start + clip.duration - t),
      });
      clip.duration = t - clip.start;
      clip.fadeOut = 0;
      clip.fadeIn = Math.min(clip.fadeIn, clip.duration);
      track.clips.push(right);
      return right;
    }

    splitClip(track, clip, t) {
      this.checkpoint();
      if (!this.splitInternal(track, clip, t)) { this.dropCheckpoint(); return; }
      this.changed({ clips: true });
    }

    targetTracks() {
      if (this.hasRange() && this.rangeTracks) return this.project.tracks.filter((t) => this.rangeTracks.includes(t.id));
      const sel = this.selectedClipList();
      if (sel.length) return [...new Set(sel.map((s) => s.track))];
      const tr = this.project.tracks.find((t) => t.id === this.selectedTrack);
      return tr ? [tr] : [];
    }

    // Split at the playhead, or at both edges of the time selection.
    separate() {
      const points = this.hasRange() ? [this.project.loop.start, this.project.loop.end] : [this.playhead];
      const onlySelected = !this.hasRange() && this.selectedClips.size > 0;
      this.checkpoint();
      let n = 0;
      for (const tr of this.targetTracks()) {
        for (const t of points) {
          for (const c of [...tr.clips]) {
            if (onlySelected && !this.selectedClips.has(c.id)) continue;
            const r = this.splitInternal(tr, c, t);
            if (r) { n++; if (this.selectedClips.has(c.id)) this.selectedClips.add(r.id); }
          }
        }
      }
      if (!n) { this.dropCheckpoint(); this.status('분할할 클립이 없습니다 (재생 위치에 클립이 있어야 합니다)'); return; }
      this.changed({ clips: true });
    }

    deleteSelection() {
      if (this.selectedClips.size) {
        this.checkpoint();
        for (const tr of this.project.tracks) tr.clips = tr.clips.filter((c) => !this.selectedClips.has(c.id));
        this.selectedClips.clear();
        this.changed({ clips: true });
        return;
      }
      if (this.hasRange()) {
        const { start, end } = this.project.loop;
        this.checkpoint();
        let n = 0;
        for (const tr of this.targetTracks()) {
          for (const t of [start, end]) for (const c of [...tr.clips]) this.splitInternal(tr, c, t);
          const before = tr.clips.length;
          tr.clips = tr.clips.filter((c) => !(c.start >= start - 1e-6 && c.start + c.duration <= end + 1e-6));
          n += before - tr.clips.length;
        }
        if (!n) { this.dropCheckpoint(); return; }
        this.changed({ clips: true });
      }
    }

    copy() {
      const sel = this.selectedClipList();
      if (!sel.length) { this.status('복사할 클립을 선택하세요'); return false; }
      const tracks = this.project.tracks;
      const t0 = Math.min(...sel.map((s) => s.clip.start));
      const i0 = Math.min(...sel.map((s) => tracks.indexOf(s.track)));
      this.clipboard = sel.map((s) => ({ dTrack: tracks.indexOf(s.track) - i0, dt: s.clip.start - t0, clip: JSON.parse(JSON.stringify(s.clip)) }));
      this.status(`클립 ${sel.length}개 복사됨`);
      return true;
    }

    cut() {
      if (this.copy()) this.deleteSelection();
    }

    paste() {
      if (!this.clipboard) return;
      const tracks = this.project.tracks;
      let base = tracks.findIndex((t) => t.id === this.selectedTrack);
      if (base < 0) base = 0;
      if (!tracks.length) return;
      this.checkpoint();
      this.selectedClips.clear();
      for (const item of this.clipboard) {
        const tr = tracks[Math.min(tracks.length - 1, base + item.dTrack)];
        const c = Object.assign({}, item.clip, { id: U.uid('clp'), start: this.playhead + item.dt });
        tr.clips.push(c);
        this.selectedClips.add(c.id);
      }
      this.changed({ clips: true });
    }

    duplicate() {
      const sel = this.selectedClipList();
      if (!sel.length) return;
      const t0 = Math.min(...sel.map((s) => s.clip.start));
      const t1 = Math.max(...sel.map((s) => s.clip.start + s.clip.duration));
      this.checkpoint();
      this.selectedClips.clear();
      for (const s of sel) {
        const c = Object.assign({}, s.clip, { id: U.uid('clp'), start: s.clip.start + (t1 - t0) });
        s.track.clips.push(c);
        this.selectedClips.add(c.id);
      }
      this.changed({ clips: true });
    }

    selectAll() {
      this.selectedClips.clear();
      this.project.tracks.forEach((tr) => tr.clips.forEach((c) => this.selectedClips.add(c.id)));
      this.edit.draw();
    }

    clipGain(delta) {
      const sel = this.selectedClipList();
      if (!sel.length) return;
      this.checkpoint();
      for (const s of sel) s.clip.gain = U.clamp((s.clip.gain || 0) + delta, -36, 24);
      this.changed({ clips: true });
    }

    quickFades() {
      const sel = this.selectedClipList();
      if (!sel.length) return;
      this.checkpoint();
      for (const s of sel) {
        const f = Math.min(0.01, s.clip.duration / 4);
        s.clip.fadeIn = Math.max(s.clip.fadeIn, f);
        s.clip.fadeOut = Math.max(s.clip.fadeOut, f);
      }
      this.changed({ clips: true });
    }

    addMarker() {
      this.checkpoint();
      const t = this.displayPos();
      this.project.markers.push({ id: U.uid('mk'), time: t, name: `M${this.project.markers.length + 1}` });
      this.project.markers.sort((a, b) => a.time - b.time);
      this.changed();
    }

    // ---------- transport ----------
    locate(t, keepRange) {
      this.playhead = Math.max(0, t);
      if (this.engine.playing && !this.engine.recording) this.engine.play(this.playhead);
      if (!keepRange) this.edit.draw();
      this.updateCounter();
    }

    setRange(a, b, ids) {
      this.project.loop.start = a;
      this.project.loop.end = b;
      if (ids) this.rangeTracks = ids;
      if (b - a <= 0.001 && ids === null) this.rangeTracks = null;
      this.edit.draw();
    }

    commitRange() {
      this.save();
      if (this.engine.playing && this.project.loop.enabled) this.engine.play(this.engine.position());
    }

    async togglePlay() {
      if (this.engine.playing) await this.stop();
      else this.play();
    }

    play() {
      this.engine.play(this.playhead);
      this.updateTransportUI();
    }

    async stop() {
      const wasRecording = this.engine.recording;
      const pos = await this.engine.stop();
      this.playhead = wasRecording ? this.playhead : pos;
      this.updateTransportUI();
      this.edit.draw();
    }

    async record() {
      if (this.engine.recording) { await this.stop(); return; }
      if (this.engine.playing) await this.engine.stop();
      if (!this.project.tracks.some((t) => t.armed)) {
        this.status('녹음할 트랙의 ● (녹음 대기) 버튼을 먼저 켜세요', true);
        return;
      }
      try {
        await this.engine.startRecording(this.playhead);
        this.status('● 녹음 중… (Space 또는 ■ 로 정지)');
      } catch (e) {
        this.engine.recording = false;
        this.status('녹음을 시작할 수 없습니다: ' + (e.message || e), true);
      }
      this.updateTransportUI();
    }

    toggleLoop() {
      this.project.loop.enabled = !this.project.loop.enabled;
      if (this.project.loop.enabled && !this.hasRange()) this.status('루프 구간을 지정하려면 눈금자나 선택 도구로 드래그하세요');
      if (this.engine.playing && !this.engine.recording) this.engine.play(this.engine.position());
      this.updateTransportUI();
      this.edit.draw();
      this.save();
    }

    toggleClick() {
      this.clickEnabled = !this.clickEnabled;
      this.updateTransportUI();
    }

    nudgePlayhead(beats) {
      this.locate(this.playhead + beats * 60 / this.project.bpm);
    }

    zoom(factor, anchorT, anchorX) {
      if (anchorT === undefined) {
        anchorX = this.edit.xAt(this.displayPos());
        if (anchorX < 0 || anchorX > this.edit.vw) anchorX = this.edit.vw / 2;
        anchorT = this.edit.timeAt(anchorX);
      }
      this.pps = U.clamp(this.pps * factor, 2, 3000);
      this.edit.layout();
      this.edit.scroll.scrollLeft = Math.max(0, anchorT * this.pps - anchorX);
      this.edit.draw();
    }

    zoomFit() {
      const end = this.projectEnd() || 30;
      this.pps = U.clamp((this.edit.vw - 40) / end, 2, 3000);
      this.edit.layout();
      this.edit.scroll.scrollLeft = 0;
      this.edit.draw();
    }

    setView(v) {
      this.view = v;
      document.getElementById('edit-view').hidden = v !== 'edit';
      document.getElementById('mix-view').hidden = v !== 'mix';
      document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
      if (v === 'edit') this.edit.layout(); else this.mix.render();
    }

    setTool(t) {
      this.tool = t;
      document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    }

    // ---------- files ----------
    async bounce() {
      const end = this.projectEnd();
      if (!end) { this.status('바운스할 오디오가 없습니다', true); return; }
      const modal = document.getElementById('bounce-modal');
      const useRange = this.hasRange();
      document.getElementById('bounce-range').textContent = useRange
        ? `선택 구간 ${U.fmtTime(this.project.loop.start)} – ${U.fmtTime(this.project.loop.end)}`
        : `세션 전체 0:00.000 – ${U.fmtTime(end)}`;
      modal.hidden = false;
      const go = await new Promise((resolve) => {
        document.getElementById('bounce-go').onclick = () => resolve(true);
        document.getElementById('bounce-cancel').onclick = () => resolve(false);
      });
      modal.hidden = true;
      if (!go) return;
      const bits = Number(document.getElementById('bounce-bits').value);
      const start = useRange ? this.project.loop.start : 0;
      const stop = useRange ? this.project.loop.end : end + Number(document.getElementById('bounce-tail').value || 0);
      this.status('바운스 중… (오프라인 렌더링)');
      try {
        const out = await this.engine.bounce(start, stop);
        const wav = U.encodeWav(U.audioBufferChannels(out), out.sampleRate, bits);
        U.download(new Blob([wav], { type: 'audio/wav' }), `${this.project.name || 'mix'}.wav`);
        this.status(`바운스 완료: ${(stop - start).toFixed(2)}초, ${out.sampleRate} Hz / ${bits === 32 ? '32-bit float' : bits + '-bit'}`);
      } catch (e) {
        this.status('바운스 실패: ' + (e.message || e), true);
      }
    }

    usedBufferIds() {
      const ids = new Set();
      this.project.tracks.forEach((tr) => tr.clips.forEach((c) => ids.add(c.bufferId)));
      return ids;
    }

    async saveFile() {
      this.status('프로젝트 파일 만드는 중…');
      const audio = {};
      for (const id of this.usedBufferIds()) {
        const b = this.buffers.get(id);
        if (!b) continue;
        const wav = U.encodeWav(U.audioBufferChannels(b.buffer), b.buffer.sampleRate, 24);
        audio[id] = { name: b.name, wav: await U.blobToDataURL(new Blob([wav], { type: 'audio/wav' })) };
      }
      const data = { format: FILE_FORMAT, version: 1, project: this.project, audio };
      U.download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${this.project.name || 'session'}.reaproj`);
      this.status('프로젝트를 저장했습니다 (.reaproj)');
    }

    async openFile(file) {
      try {
        const data = JSON.parse(await file.text());
        if (data.format !== FILE_FORMAT) throw new Error('REA Studio 프로젝트 파일이 아닙니다');
        if (this.engine.playing) await this.stop();
        const ctx = this.engine.init();
        this.status('프로젝트 여는 중…');
        const buffers = new Map();
        for (const [id, a] of Object.entries(data.audio || {})) {
          const buf = await ctx.decodeAudioData(await U.dataURLToArrayBuffer(a.wav));
          buffers.set(id, { name: a.name, buf });
        }
        this.buffers.clear();
        for (const [id, b] of buffers) this.addBuffer(b.name, b.buf, id);
        this.loadProject(data.project);
        this.status(`"${this.project.name}" 프로젝트를 열었습니다`);
      } catch (e) {
        this.status('열기 실패: ' + (e.message || e), true);
      }
    }

    loadProject(p) {
      this.project = Object.assign(newProject(), p);
      this.project.loop = Object.assign({ enabled: false, start: 0, end: 0 }, p.loop);
      this.undoStack = [];
      this.redoStack = [];
      this.selectedClips.clear();
      this.selectedTrack = this.project.tracks[0] ? this.project.tracks[0].id : null;
      this.playhead = 0;
      this.persisted.clear();
      this.changed();
      this.zoomFit();
    }

    async newSession() {
      if ((this.project.tracks.length) && !confirm('현재 세션을 닫고 새 세션을 만들까요? (저장하지 않은 내용은 사라집니다)')) return;
      if (this.engine.playing) await this.stop();
      this.buffers.clear();
      try { await REA.storage.clear(); } catch (e) { /* storage unavailable */ }
      this.loadProject(newProject());
      this.pps = 40;
      this.edit.layout();
      this.status('새 세션');
    }

    async persist() {
      try {
        const used = this.usedBufferIds();
        for (const id of used) {
          if (this.persisted.has(id)) continue;
          const b = this.buffers.get(id);
          if (!b) continue;
          await REA.storage.saveAudio(id, b.name, b.buffer);
          this.persisted.add(id);
        }
        await REA.storage.saveSession(this.project);
        // keep audio that undo/redo could bring back
        const keep = new Set(used);
        for (const s of this.undoStack.concat(this.redoStack)) for (const m of s.matchAll(/"bufferId":"([^"]+)"/g)) keep.add(m[1]);
        await REA.storage.pruneAudio(keep);
        for (const id of this.persisted) if (!keep.has(id)) this.persisted.delete(id);
        document.getElementById('info').textContent = '자동 저장됨 ' + new Date().toLocaleTimeString();
      } catch (e) {
        document.getElementById('info').textContent = '자동 저장 불가 (브라우저 저장소 사용 불가)';
      }
    }

    async restore() {
      try {
        const p = await REA.storage.loadSession();
        if (!p) return;
        const ids = new Set();
        (p.tracks || []).forEach((tr) => tr.clips.forEach((c) => ids.add(c.bufferId)));
        for (const id of ids) {
          const a = await REA.storage.loadAudio(id);
          if (a) { this.addBuffer(a.name, a.buffer, id); this.persisted.add(id); }
        }
        this.loadProject(p);
        this.status(`이전 세션 "${this.project.name}"을(를) 복원했습니다`);
      } catch (e) {
        /* nothing to restore */
      }
    }

    // ---------- UI ----------
    updateTransportUI() {
      const e = this.engine;
      const set = (id, on) => document.getElementById(id).classList.toggle('on', on);
      set('btn-play', e.playing && !e.recording);
      set('btn-record', e.recording);
      set('btn-loop', this.project.loop.enabled);
      set('btn-click', this.clickEnabled);
      set('btn-snap', this.snap);
      document.getElementById('btn-record').classList.toggle('armed', this.project.tracks.some((t) => t.armed));
      this.updateCounter();
    }

    updateCounter() {
      const t = this.displayPos();
      const bars = U.fmtBars(t, this.project.bpm, this.project.beatsPerBar);
      const time = U.fmtTime(t);
      document.getElementById('counter').textContent = this.counterMode === 'bars' ? bars : time;
      document.getElementById('counter-sub').textContent = this.counterMode === 'bars' ? time : bars;
    }

    frame() {
      const e = this.engine;
      if (e.playing) {
        this.updateCounter();
        if (this.view === 'edit') {
          const x = this.edit.xAt(e.position());
          if (!this.edit.drag && (x > this.edit.vw - 20 || x < 0)) this.edit.scroll.scrollLeft = Math.max(0, e.position() * this.pps - 40);
          this.edit.draw();
        }
      }
      if (e.ctx) this.drawMeters();
      requestAnimationFrame(() => this.frame());
    }

    drawMeters() {
      const css = getComputedStyle(document.documentElement);
      const colors = [css.getPropertyValue('--meter-low').trim(), css.getPropertyValue('--meter-mid').trim(), css.getPropertyValue('--meter-high').trim()];
      const levels = new Map();
      const lvl = (id) => {
        if (!levels.has(id)) levels.set(id, id === '__master' ? this.engine.masterLevel() : this.engine.trackLevel(id));
        return levels.get(id);
      };
      const toPos = (l) => {
        const db = U.gainToDb(l);
        return db === -Infinity ? 0 : U.clamp((db + 60) / 66, 0, 1);
      };
      const colorFor = (l) => (l >= 1 ? colors[2] : l > 0.5 ? colors[1] : colors[0]);
      document.querySelectorAll('canvas.meter-h').forEach((c) => {
        const l = lvl(c.dataset.track);
        const g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        g.fillStyle = colorFor(l);
        g.fillRect(0, 0, c.width * toPos(l), c.height);
      });
      if (this.view !== 'mix') return;
      document.querySelectorAll('canvas.meter-v').forEach((c) => {
        const l = lvl(c.dataset.master ? '__master' : c.dataset.track);
        const g = c.getContext('2d');
        const h = c.height * toPos(l);
        g.clearRect(0, 0, c.width, c.height);
        g.fillStyle = colorFor(l);
        g.fillRect(0, c.height - h, c.width, h);
        if (l >= 1) { g.fillStyle = colors[2]; g.fillRect(0, 0, c.width, 4); }
      });
    }

    bindUI() {
      const acts = {
        new: () => this.newSession(),
        open: () => document.getElementById('file-project').click(),
        save: () => this.saveFile(),
        import: () => document.getElementById('file-audio').click(),
        addTrack: () => this.addTrack(),
        bounce: () => this.bounce(),
        undo: () => this.undo(),
        redo: () => this.redo(),
        help: () => { document.getElementById('help-modal').hidden = false; },
        rtz: () => this.locate(0),
        end: () => this.locate(this.projectEnd()),
        rew: () => this.nudgePlayhead(-this.project.beatsPerBar),
        ffw: () => this.nudgePlayhead(this.project.beatsPerBar),
        play: () => this.togglePlay(),
        stop: () => (this.engine.playing ? this.stop() : this.locate(0)),
        record: () => this.record(),
        loop: () => this.toggleLoop(),
        click: () => this.toggleClick(),
        zoomIn: () => this.zoom(1.5),
        zoomOut: () => this.zoom(1 / 1.5),
        zoomFit: () => this.zoomFit(),
        split: () => this.separate(),
        marker: () => this.addMarker(),
      };
      document.querySelectorAll('[data-act]').forEach((b) => {
        b.addEventListener('click', () => { acts[b.dataset.act](); b.blur(); });
      });
      document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => { this.setTool(b.dataset.tool); b.blur(); }));
      document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { this.setView(b.dataset.view); b.blur(); }));
      document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { b.closest('.modal').hidden = true; }));

      document.getElementById('btn-snap').onclick = (e) => { this.snap = !this.snap; this.updateTransportUI(); e.target.blur(); };
      document.getElementById('grid-div').onchange = (e) => { this.gridDiv = Number(e.target.value); };
      document.getElementById('counter-box').onclick = () => { this.counterMode = this.counterMode === 'bars' ? 'time' : 'bars'; this.updateCounter(); };

      const bpm = document.getElementById('bpm');
      bpm.addEventListener('change', () => {
        const v = U.clamp(Number(bpm.value) || 120, 20, 300);
        this.checkpoint();
        this.project.bpm = v;
        this.changed();
      });
      const meter = document.getElementById('meter');
      meter.addEventListener('change', () => {
        this.checkpoint();
        this.project.beatsPerBar = Number(meter.value);
        this.changed();
      });
      const name = document.getElementById('project-name');
      name.addEventListener('change', () => { this.checkpoint(); this.project.name = name.value.trim() || 'Untitled Session'; this.save(); });

      document.getElementById('file-audio').addEventListener('change', (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        if (files.length) this.importFiles(files, null, this.playhead);
      });
      document.getElementById('file-project').addEventListener('change', (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (f) this.openFile(f);
      });

      window.addEventListener('beforeunload', () => { this.persist(); });
    }

    bindKeys() {
      window.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') {
          if (e.key === 'Escape') e.target.blur();
          return;
        }
        if (e.key === 'Escape') { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); return; }
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key.toLowerCase();
        let handled = true;
        if (k === ' ' || e.code === 'Space') this.togglePlay();
        else if (mod && k === 'z' && e.shiftKey) this.redo();
        else if (mod && k === 'z') this.undo();
        else if (mod && k === 'y') this.redo();
        else if (mod && k === 'c') this.copy();
        else if (mod && k === 'x') this.cut();
        else if (mod && k === 'v') this.paste();
        else if (mod && k === 'd') this.duplicate();
        else if (mod && k === 'a') this.selectAll();
        else if (mod && k === 'e') this.separate();
        else if (mod && k === 's') this.saveFile();
        else if (mod && k === 'o') document.getElementById('file-project').click();
        else if (mod && k === 'i') document.getElementById('file-audio').click();
        else if (mod && e.shiftKey && k === 'n') this.addTrack();
        else if (mod && e.shiftKey && k === 'b') this.bounce();
        else if (mod) handled = false;
        else if (e.altKey && e.key === 'ArrowUp') this.clipGain(1);
        else if (e.altKey && e.key === 'ArrowDown') this.clipGain(-1);
        else if (k === 'r' || e.key === 'F12') this.record();
        else if (k === 'b') this.separate();
        else if (k === 'l') this.toggleLoop();
        else if (k === 'k') this.toggleClick();
        else if (k === 'm') this.addMarker();
        else if (k === 'f') this.quickFades();
        else if (k === 'g') { this.snap = !this.snap; this.updateTransportUI(); }
        else if (k === '1') this.setTool('grab');
        else if (k === '2') this.setTool('select');
        else if (k === '3') this.setTool('split');
        else if (k === '=') this.setView(this.view === 'edit' ? 'mix' : 'edit');
        else if (k === '+' || e.code === 'NumpadAdd' || k === ']') this.zoom(1.5);
        else if (k === '-' || e.code === 'NumpadSubtract' || k === '[') this.zoom(1 / 1.5);
        else if (k === 'z') this.zoomFit();
        else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
        else if (e.key === 'Home' || e.key === 'Enter') this.locate(0);
        else if (e.key === 'End') this.locate(this.projectEnd());
        else if (e.key === 'ArrowLeft') this.nudgePlayhead(-1);
        else if (e.key === 'ArrowRight') this.nudgePlayhead(1);
        else if (e.key === '?') document.getElementById('help-modal').hidden = false;
        else handled = false;
        if (handled) e.preventDefault();
      });
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    REA.app = new App();
  });
})();
