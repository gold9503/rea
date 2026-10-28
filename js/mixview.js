// REA Studio — Mix window: channel strips, inserts, faders, pan, meters.
REA.MixView = (() => {
  const U = REA.util;
  const SLOTS = 5;
  const SCALE = [12, 6, 0, -6, -12, -20, -30, -40, -Infinity]
    .map((db) => `<span style="bottom:${(U.dbToFaderPos(db) * 100).toFixed(1)}%">${db === -Infinity ? '-∞' : (db > 0 ? '+' : '') + db}</span>`).join('');

  class MixView {
    constructor(app) {
      this.app = app;
      this.el = document.getElementById('strips');
      this.modal = document.getElementById('plugin-modal');
      this.modalBody = document.getElementById('plugin-body');
      this.modalTitle = document.getElementById('plugin-title');
      document.getElementById('plugin-close').onclick = () => this.closeEditor();
      this.modal.addEventListener('pointerdown', (e) => { if (e.target === this.modal) this.closeEditor(); });
    }

    render() {
      const app = this.app;
      this.el.innerHTML = '';
      app.project.tracks.forEach((tr) => this.el.appendChild(this.strip(tr, false)));
      const spacer = document.createElement('div');
      spacer.className = 'strip-spacer';
      this.el.appendChild(spacer);
      this.el.appendChild(this.strip(app.project.master, true));
    }

    strip(ch, isMaster) {
      const app = this.app;
      const el = document.createElement('div');
      el.className = 'strip' + (isMaster ? ' master' : '') + (!isMaster && ch.id === app.selectedTrack ? ' selected' : '');
      el.style.setProperty('--track-color', isMaster ? 'var(--accent)' : ch.color);
      while (ch.inserts.length < SLOTS) ch.inserts.push(null);

      const options = ['<option value="">— 없음 —</option>']
        .concat(Object.entries(REA.effects.defs).map(([k, d]) => `<option value="${k}">${d.title}</option>`)).join('');

      el.innerHTML = `
        <div class="strip-name" title="${isMaster ? 'Master' : ''}"></div>
        <div class="strip-section-label">INSERTS</div>
        <div class="inserts"></div>
        <div class="strip-section-label">PAN</div>
        <div class="pan-row">${isMaster ? '<span class="muted">stereo</span>' : `<input type="range" class="pan" min="-100" max="100" step="1" value="${Math.round((ch.pan || 0) * 100)}"><span class="pan-val">${U.fmtPan(ch.pan || 0)}</span>`}</div>
        <div class="fader-row">
          <canvas class="meter-v" width="14" height="200" data-${isMaster ? 'master="1"' : `track="${ch.id}"`}></canvas>
          <input type="range" class="fader" min="0" max="1000" step="1" value="${Math.round(U.dbToFaderPos(ch.volume) * 1000)}" title="더블클릭: 0 dB">
          <div class="fader-scale">${SCALE}</div>
        </div>
        <div class="db-val">${U.fmtDb(ch.volume)}</div>
        ${isMaster ? '<div class="strip-buttons"><span class="muted">MASTER</span></div>' : `
        <div class="strip-buttons">
          <button class="btn-rec ${ch.armed ? 'on' : ''}" title="녹음 대기">●</button>
          <button class="btn-solo ${ch.solo ? 'on' : ''}" title="솔로">S</button>
          <button class="btn-mute ${ch.mute ? 'on' : ''}" title="뮤트">M</button>
        </div>`}`;
      el.querySelector('.strip-name').textContent = isMaster ? 'Master' : ch.name;

      const ins = el.querySelector('.inserts');
      ch.inserts.forEach((slot, idx) => {
        const row = document.createElement('div');
        row.className = 'insert' + (slot && slot.bypass ? ' bypassed' : '') + (slot ? ' filled' : '');
        row.innerHTML = `<select>${options}</select><button class="ins-edit" title="편집">✎</button><button class="ins-byp" title="바이패스">⏻</button>`;
        const sel = row.querySelector('select');
        sel.value = slot ? slot.type : '';
        sel.addEventListener('change', () => {
          app.checkpoint();
          ch.inserts[idx] = sel.value ? { id: U.uid('fx'), type: sel.value, bypass: false, params: REA.effects.defaults(sel.value) } : null;
          app.changed({ mixer: true });
          if (sel.value) this.openEditor(ch, idx, isMaster);
        });
        row.querySelector('.ins-edit').onclick = () => { if (ch.inserts[idx]) this.openEditor(ch, idx, isMaster); };
        row.querySelector('.ins-byp').onclick = () => {
          if (!ch.inserts[idx]) return;
          app.checkpoint();
          ch.inserts[idx].bypass = !ch.inserts[idx].bypass;
          app.changed({ mixer: true });
        };
        ins.appendChild(row);
      });

      const fader = el.querySelector('.fader');
      const dbVal = el.querySelector('.db-val');
      fader.addEventListener('pointerdown', () => app.checkpoint());
      fader.addEventListener('keydown', (e) => { e.stopPropagation(); });
      fader.addEventListener('input', () => {
        ch.volume = U.faderPosToDb(fader.value / 1000);
        dbVal.textContent = U.fmtDb(ch.volume);
        app.liveParamChange(isMaster ? null : ch);
      });
      fader.addEventListener('dblclick', () => {
        app.checkpoint();
        ch.volume = 0;
        fader.value = Math.round(U.dbToFaderPos(0) * 1000);
        dbVal.textContent = U.fmtDb(0);
        app.liveParamChange(isMaster ? null : ch);
      });

      if (!isMaster) {
        const pan = el.querySelector('.pan');
        const panVal = el.querySelector('.pan-val');
        pan.addEventListener('pointerdown', () => app.checkpoint());
        pan.addEventListener('keydown', (e) => { e.stopPropagation(); });
        pan.addEventListener('input', () => {
          ch.pan = pan.value / 100;
          panVal.textContent = U.fmtPan(ch.pan);
          app.liveParamChange(ch);
        });
        pan.addEventListener('dblclick', () => {
          ch.pan = 0;
          pan.value = 0;
          panVal.textContent = 'C';
          app.liveParamChange(ch);
        });
        el.querySelector('.btn-rec').onclick = () => app.toggleTrackFlag(ch.id, 'armed');
        el.querySelector('.btn-solo').onclick = () => app.toggleTrackFlag(ch.id, 'solo');
        el.querySelector('.btn-mute').onclick = () => app.toggleTrackFlag(ch.id, 'mute');
        el.querySelector('.strip-name').addEventListener('pointerdown', () => {
          app.selectedTrack = ch.id;
          app.refreshSelection();
        });
      }
      return el;
    }

    refreshSelection() {
      const strips = this.el.querySelectorAll('.strip:not(.master)');
      this.app.project.tracks.forEach((tr, i) => strips[i] && strips[i].classList.toggle('selected', tr.id === this.app.selectedTrack));
    }

    // ---------- plugin editor ----------
    openEditor(ch, idx, isMaster) {
      const app = this.app;
      const slot = ch.inserts[idx];
      if (!slot) return;
      const def = REA.effects.defs[slot.type];
      this.modalTitle.textContent = `${isMaster ? 'Master' : ch.name} · ${def.title} (슬롯 ${String.fromCharCode(65 + idx)})`;
      this.modalBody.innerHTML = '';

      const byp = document.createElement('label');
      byp.className = 'param-bypass';
      byp.innerHTML = `<input type="checkbox" ${slot.bypass ? 'checked' : ''}> 바이패스`;
      byp.querySelector('input').addEventListener('change', (e) => {
        app.checkpoint();
        slot.bypass = e.target.checked;
        app.changed({ mixer: true });
      });
      this.modalBody.appendChild(byp);

      for (const p of def.params) {
        const row = document.createElement('div');
        row.className = 'param';
        const val = slot.params[p.key] ?? p.def;
        row.innerHTML = `<label>${p.label}</label><input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${val}"><span class="param-val"></span>`;
        const input = row.querySelector('input');
        const out = row.querySelector('.param-val');
        const show = () => { out.textContent = fmtParam(p, Number(input.value)); };
        show();
        input.addEventListener('pointerdown', () => app.checkpoint());
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('input', () => {
          slot.params[p.key] = Number(input.value);
          show();
          app.engine.sync();
          app.save();
        });
        input.addEventListener('dblclick', () => {
          slot.params[p.key] = p.def;
          input.value = p.def;
          show();
          app.engine.sync();
        });
        this.modalBody.appendChild(row);
      }

      const reset = document.createElement('button');
      reset.className = 'btn';
      reset.textContent = '기본값으로';
      reset.onclick = () => {
        app.checkpoint();
        slot.params = REA.effects.defaults(slot.type);
        app.engine.sync();
        this.openEditor(ch, idx, isMaster);
      };
      this.modalBody.appendChild(reset);
      this.modal.hidden = false;
    }

    closeEditor() {
      this.modal.hidden = true;
      this.app.render();
    }
  }

  function fmtParam(p, v) {
    if (p.key === 'invert') return v ? 'ON' : 'OFF';
    if (p.key === 'mix' || p.key === 'feedback') return Math.round(v * 100) + '%';
    if (p.unit === 'Hz' && v >= 1000) return (v / 1000).toFixed(2) + ' kHz';
    const digits = p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0;
    return v.toFixed(digits) + (p.unit ? ' ' + p.unit : '');
  }

  return MixView;
})();
