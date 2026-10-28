// REA Studio — shared helpers
window.REA = window.REA || {};

REA.util = (() => {
  let counter = 0;

  function uid(prefix = 'id') {
    counter = (counter + 1) % 1e6;
    return prefix + '_' + Date.now().toString(36) + '_' + counter.toString(36) + Math.random().toString(36).slice(2, 6);
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Volumes are stored in dB; -60 dB and below is treated as silence.
  function dbToGain(db) {
    if (db <= -60) return 0;
    return Math.pow(10, db / 20);
  }

  function gainToDb(g) {
    if (g <= 0.001) return -Infinity;
    return 20 * Math.log10(g);
  }

  // Fader travel: gain = 4 * t^3 → 0 dB sits at about 63% of travel, +12 dB at the top.
  function faderPosToDb(t) {
    if (t <= 0) return -Infinity;
    return Math.max(-60, gainToDb(4 * t * t * t));
  }

  function dbToFaderPos(db) {
    if (db === -Infinity || db <= -60) return 0;
    return Math.cbrt(dbToGain(db) / 4);
  }

  function fmtDb(db) {
    if (db === -Infinity || db <= -60) return '-∞';
    return (db > 0 ? '+' : '') + db.toFixed(1);
  }

  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m + ':' + s.toFixed(3).padStart(6, '0');
  }

  // Bars|Beats|Ticks with 960 ticks per quarter note (1-based bars and beats).
  function fmtBars(sec, bpm, beatsPerBar) {
    const beatLen = 60 / bpm;
    const totalBeats = Math.max(0, sec) / beatLen;
    const bar = Math.floor(totalBeats / beatsPerBar) + 1;
    const beat = Math.floor(totalBeats % beatsPerBar) + 1;
    const ticks = Math.floor((totalBeats - Math.floor(totalBeats)) * 960);
    return bar + '|' + beat + '|' + String(ticks).padStart(3, '0');
  }

  function fmtPan(p) {
    const v = Math.round(p * 100);
    if (v === 0) return 'C';
    return (v < 0 ? 'L' : 'R') + Math.abs(v);
  }

  // Interleaved PCM WAV encoder. bitDepth: 16 | 24 | 32 (float)
  function encodeWav(channels, sampleRate, bitDepth = 16) {
    const numCh = channels.length;
    const len = channels[0].length;
    const bytes = bitDepth / 8;
    const dataSize = len * numCh * bytes;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + dataSize, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, bitDepth === 32 ? 3 : 1, true);
    v.setUint16(22, numCh, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * numCh * bytes, true);
    v.setUint16(32, numCh * bytes, true);
    v.setUint16(34, bitDepth, true);
    str(36, 'data');
    v.setUint32(40, dataSize, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = clamp(channels[c][i], -1, 1);
        if (bitDepth === 32) {
          v.setFloat32(o, s, true);
        } else if (bitDepth === 24) {
          const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
          v.setUint8(o, x & 0xff);
          v.setUint8(o + 1, (x >> 8) & 0xff);
          v.setUint8(o + 2, (x >> 16) & 0xff);
        } else {
          v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
        }
        o += bytes;
      }
    }
    return buf;
  }

  function audioBufferChannels(buffer) {
    const out = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
    return out;
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function dataURLToArrayBuffer(url) {
    const res = await fetch(url);
    return res.arrayBuffer();
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Min/max peaks per block of `spp` samples, all channels folded together.
  function computePeaks(buffer, spp = 256) {
    const n = Math.ceil(buffer.length / spp);
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) {
        let lo = c ? min[i] : 1, hi = c ? max[i] : -1;
        const end = Math.min(d.length, (i + 1) * spp);
        for (let j = i * spp; j < end; j++) {
          const s = d[j];
          if (s < lo) lo = s;
          if (s > hi) hi = s;
        }
        min[i] = lo;
        max[i] = hi;
      }
    }
    return { spp, min, max };
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  return {
    uid, clamp, dbToGain, gainToDb, faderPosToDb, dbToFaderPos, fmtDb, fmtTime, fmtBars, fmtPan,
    encodeWav, audioBufferChannels, blobToDataURL, dataURLToArrayBuffer, download, computePeaks,
    debounce, baseName,
  };
})();
