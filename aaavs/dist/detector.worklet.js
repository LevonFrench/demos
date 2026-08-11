// src/worklets/detector.worklet.ts
var FEATURE_FLOATS = 16;
var RING_FRAMES = 256;
var HEADER_INTS = 4;
var HEADER_BYTES = HEADER_INTS * 4;
var CTL_WRITE_COUNT = 0;
var F_TIME = 0;
var F_FLUX = 1;
var F_THRESH = 2;
var F_LEVEL = 3;
var F_CREST = 4;
var F_PAN = 5;
var F_WIDTH = 6;
var F_CENTROID = 7;
var F_FLATNESS = 8;
var F_BAND_SUB = 9;
var F_ONSET_STRENGTH = 14;
var F_ONSET_CLASS = 15;
var FFT_N = 512;
var BINS = FFT_N / 2;
var DETECT_WINDOW = 1.1;
var DETECT_WARMUP = 0.25;
var DETECT_K = 1.6;
var DETECT_FLOOR = 4e-3;
var DETECT_HZ = 8e3;
var MIN_GAP = 0.09;
var MIN_DB = -100;
var MAX_DB = -30;
var DB_RANGE = MAX_DB - MIN_DB;
var WHITEN_DECAY_PER_SEC = 0.9418;
var WHITEN_FLOOR = 0.02;
var BAND_EDGES = [
  [20, 80],
  // sub
  [80, 250],
  // low
  [250, 2e3],
  // mid
  [2e3, 8e3],
  // high
  [8e3, 2e4]
  // air
];
var BAND_GAINS = [1.6, 1.5, 2.2, 3, 3];
var CLASS_KICK = 1;
var CLASS_SNARE = 2;
var CLASS_HAT = 3;
var CLASS_TONAL = 4;
var CLASS_NAMES = ["", "kick", "snare", "hat", "tonal"];
var FLUX_EMPTY = -1e9;
var DetectorProcessor = class extends AudioWorkletProcessor {
  // --- shared output ------------------------------------------------------
  ctl;
  frames;
  writeCount = 0;
  // --- rolling input windows ---------------------------------------------
  // Circular, FFT_N long, one per channel. `histPos` is the next slot to
  // write, which is also the OLDEST sample — the window is read from there.
  histL = new Float32Array(FFT_N);
  histR = new Float32Array(FFT_N);
  histPos = 0;
  primed = 0;
  // --- FFT scratch (allocated once, reused forever) -----------------------
  re = new Float32Array(FFT_N);
  im = new Float32Array(FFT_N);
  rev = new Uint16Array(FFT_N);
  twCos = new Float32Array(FFT_N / 2);
  twSin = new Float32Array(FFT_N / 2);
  window = new Float32Array(FFT_N);
  windowGain;
  // --- detector state -----------------------------------------------------
  spec = new Float32Array(BINS);
  prevSpec = new Float32Array(BINS);
  whiten = new Float32Array(BINS).fill(1);
  /**
   * Flux history, TIME-stamped. Never a frame count — §3.2.
   *
   * Empty slots hold FLUX_EMPTY, not 0. A zero timestamp is a LIVE timestamp
   * for the first second of a context's life, so a zero-filled ring reads as
   * 421 real samples of flux 0: mean and variance both collapse, the threshold
   * lands on ~0, and every quantum until the ring fills reports an onset. That
   * is a burst of a dozen phantom hits on the first note of a track, which is
   * exactly where it is most visible.
   */
  fluxT;
  fluxV;
  fluxRing;
  /** Samples the window must hold before an onset is allowed to fire. */
  fluxWarmup;
  fi = 0;
  lastOnset = -1;
  topBin;
  loTopBin;
  hiBotBin;
  bandBins;
  /** Reused onset payload. postMessage structured-clones it, so one is enough. */
  onsetMsg = {
    type: "onset",
    time: 0,
    strength: 0,
    klass: "kick",
    pan: 0
  };
  constructor(options) {
    super();
    const opts = options.processorOptions;
    const ring = opts?.ring;
    if (ring) {
      this.ctl = new Int32Array(ring, 0, HEADER_INTS);
      this.frames = new Float32Array(ring, HEADER_BYTES, RING_FRAMES * FEATURE_FLOATS);
    } else {
      this.ctl = null;
      this.frames = null;
    }
    let gain = 0;
    for (let i = 0; i < FFT_N; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_N);
      this.window[i] = w;
      gain += w;
    }
    this.windowGain = gain;
    let bits = 0;
    while (1 << bits < FFT_N) bits++;
    for (let i = 0; i < FFT_N; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= (i >>> b & 1) << bits - 1 - b;
      this.rev[i] = r;
    }
    for (let k = 0; k < FFT_N / 2; k++) {
      this.twCos[k] = Math.cos(2 * Math.PI * k / FFT_N);
      this.twSin[k] = Math.sin(2 * Math.PI * k / FFT_N);
    }
    this.fluxRing = Math.ceil(DETECT_WINDOW * sampleRate / 128) + 8;
    this.fluxT = new Float32Array(this.fluxRing).fill(FLUX_EMPTY);
    this.fluxV = new Float32Array(this.fluxRing);
    this.fluxWarmup = Math.ceil(DETECT_WARMUP * sampleRate / 128);
    const nyq = sampleRate / 2;
    const binOf = (hz) => Math.min(BINS - 1, Math.max(0, Math.round(hz / nyq * BINS)));
    this.topBin = Math.min(BINS, Math.ceil(DETECT_HZ / nyq * BINS));
    this.loTopBin = Math.max(1, Math.round(250 / nyq * BINS));
    this.hiBotBin = Math.round(5e3 / nyq * BINS);
    this.bandBins = new Int32Array(BAND_EDGES.length * 2);
    for (let b = 0; b < BAND_EDGES.length; b++) {
      const edge = BAND_EDGES[b];
      this.bandBins[b * 2] = binOf(edge[0]);
      this.bandBins[b * 2 + 1] = binOf(edge[1]);
    }
    this.port.onmessage = (e) => {
      if (e.data?.type === "reset") this.reset();
    };
  }
  reset() {
    this.histL.fill(0);
    this.histR.fill(0);
    this.histPos = 0;
    this.primed = 0;
    this.spec.fill(0);
    this.prevSpec.fill(0);
    this.whiten.fill(1);
    this.fluxT.fill(FLUX_EMPTY);
    this.fluxV.fill(0);
    this.fi = 0;
    this.lastOnset = -1;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const chL = input[0];
    if (!chL || chL.length === 0) return true;
    const chR = input[1] ?? chL;
    const n = chL.length;
    for (let i = 0; i < n; i++) {
      this.histL[this.histPos] = chL[i];
      this.histR[this.histPos] = chR[i];
      this.histPos = (this.histPos + 1) % FFT_N;
    }
    if (this.primed < FFT_N) {
      this.primed += n;
      if (this.primed < FFT_N) return true;
    }
    this.analyse(currentTime);
    return true;
  }
  /** One 512-point frame, hopped by one quantum. 4x overlap at 128/512. */
  analyse(t) {
    const { histL, histR, re, im, window } = this;
    const start = this.histPos;
    let peak = 0, mSq = 0, sSq = 0, sumL = 0, sumR = 0;
    for (let i = 0; i < FFT_N; i++) {
      const j = (start + i) % FFT_N;
      const l = histL[j], r = histR[j];
      const m = (l + r) * 0.5, s = (l - r) * 0.5;
      mSq += m * m;
      sSq += s * s;
      sumL += l * l;
      sumR += r * r;
      const a = m < 0 ? -m : m;
      if (a > peak) peak = a;
      re[i] = m * window[i];
      im[i] = 0;
    }
    const rms = Math.sqrt(mSq / FFT_N);
    const level = clamp(rms * 4);
    const crest = peak / (rms > 1e-5 ? rms : 1e-5);
    const mN = Math.sqrt(mSq), sN = Math.sqrt(sSq);
    const width = sN / Math.max(mN + sN, 1e-6);
    const rmsL = Math.sqrt(sumL / FFT_N), rmsR = Math.sqrt(sumR / FFT_N);
    const pan = rmsL + rmsR > 1e-5 ? clampSigned((rmsL - rmsR) / (rmsL + rmsR)) : 0;
    this.fft();
    const scale = 2 / this.windowGain;
    for (let i = 0; i < BINS; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * scale;
      const db = 20 * Math.log10(mag + 1e-12);
      this.spec[i] = clamp((db - MIN_DB) / DB_RANGE);
    }
    const dt = 128 / sampleRate;
    const whitenDecay = Math.pow(WHITEN_DECAY_PER_SEC, dt);
    const top = this.topBin;
    let flux = 0, wsum = 0;
    let cNum = 0, cDen = 0, lg = 0, ln = 0;
    let loE = 0, midE = 0, hiE = 0;
    for (let i = 0; i < top; i++) {
      const cur = this.spec[i];
      this.whiten[i] = Math.max(cur, this.whiten[i] * whitenDecay, WHITEN_FLOOR);
      const w1 = this.whiten[i];
      const norm = cur / w1;
      const prev = this.prevSpec[i] / w1;
      const w = 1 + 3 * Math.exp(-i / 5);
      const d = norm - prev;
      if (d > 0) flux += d * w;
      wsum += w;
      this.prevSpec[i] = cur;
      cNum += cur * i;
      cDen += cur;
      lg += Math.log(cur + 1e-6);
      ln += cur;
      const pos = d > 0 ? d : 0;
      if (i < this.loTopBin) loE += pos;
      else if (i >= this.hiBotBin) hiE += pos;
      else midE += pos;
    }
    flux /= wsum;
    this.fluxT[this.fi] = t;
    this.fluxV[this.fi] = flux;
    this.fi = (this.fi + 1) % this.fluxRing;
    let cnt = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < this.fluxRing; i++) {
      if (t - this.fluxT[i] > DETECT_WINDOW) continue;
      const v = this.fluxV[i];
      s1 += v;
      s2 += v * v;
      cnt++;
    }
    const mean = cnt ? s1 / cnt : 0;
    const varc = cnt ? Math.max(0, s2 / cnt - mean * mean) : 0;
    const thresh = mean + DETECT_K * Math.sqrt(varc);
    const centroid = cDen > 0 ? cNum / cDen / top : 0;
    const flatness = ln > 0 ? Math.exp(lg / top) / (ln / top) : 0;
    let onsetStrength = 0;
    let onsetClass = 0;
    if (cnt >= this.fluxWarmup && flux > thresh && flux > DETECT_FLOOR && t - this.lastOnset > MIN_GAP) {
      this.lastOnset = t;
      onsetStrength = clamp(0.55 + (flux - thresh) / Math.max(thresh, 1e-4) * 0.45);
      const loBins = Math.max(1, this.loTopBin);
      const hiBins = Math.max(1, top - this.hiBotBin);
      const midBins = Math.max(1, this.hiBotBin - this.loTopBin);
      const loD = loE / loBins;
      const midD = midE / midBins;
      const hiD = hiE / hiBins;
      const totD = loD + midD + hiD + 1e-6;
      const lo = loD / totD, hi = hiD / totD;
      if (hi > 0.42) onsetClass = CLASS_HAT;
      else if (lo > 0.42) onsetClass = CLASS_KICK;
      else if (flatness > 0.3) onsetClass = CLASS_SNARE;
      else onsetClass = CLASS_TONAL;
      this.onsetMsg.time = t;
      this.onsetMsg.strength = onsetStrength;
      this.onsetMsg.klass = CLASS_NAMES[onsetClass];
      this.onsetMsg.pan = pan;
      this.port.postMessage(this.onsetMsg);
    }
    this.publish(
      t,
      flux,
      thresh,
      level,
      crest,
      pan,
      width,
      centroid,
      flatness,
      onsetStrength,
      onsetClass
    );
  }
  /** Write one feature frame and publish it with a single release store. */
  publish(t, flux, thresh, level, crest, pan, width, centroid, flatness, onsetStrength, onsetClass) {
    const frames = this.frames;
    if (!frames || !this.ctl) return;
    const base = this.writeCount % RING_FRAMES * FEATURE_FLOATS;
    frames[base + F_TIME] = t;
    frames[base + F_FLUX] = flux;
    frames[base + F_THRESH] = thresh;
    frames[base + F_LEVEL] = level;
    frames[base + F_CREST] = crest;
    frames[base + F_PAN] = pan;
    frames[base + F_WIDTH] = width;
    frames[base + F_CENTROID] = centroid;
    frames[base + F_FLATNESS] = flatness;
    for (let b = 0; b < BAND_EDGES.length; b++) {
      const a = this.bandBins[b * 2], e = this.bandBins[b * 2 + 1];
      let sum = 0;
      for (let i = a; i <= e; i++) sum += this.spec[i];
      frames[base + F_BAND_SUB + b] = clamp(sum / (e - a + 1) * BAND_GAINS[b]);
    }
    frames[base + F_ONSET_STRENGTH] = onsetStrength;
    frames[base + F_ONSET_CLASS] = onsetClass;
    this.writeCount++;
    Atomics.store(this.ctl, CTL_WRITE_COUNT, this.writeCount | 0);
  }
  /** In-place iterative radix-2, decimation in time. */
  fft() {
    const { re, im, rev, twCos, twSin } = this;
    for (let i = 0; i < FFT_N; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let size = 2; size <= FFT_N; size <<= 1) {
      const half = size >> 1;
      const step = FFT_N / size;
      for (let i = 0; i < FFT_N; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = twCos[k], s = twSin[k];
          const tr = re[l] * c + im[l] * s;
          const ti = im[l] * c - re[l] * s;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] = re[j] + tr;
          im[j] = im[j] + ti;
        }
      }
    }
  }
};
function clamp(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampSigned(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
registerProcessor("aaavs-detector", DetectorProcessor);
