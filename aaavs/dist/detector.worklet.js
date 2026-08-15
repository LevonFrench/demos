// src/audio-features.ts
var PERCEPTUAL_BAND_EDGES_HZ = [
  0,
  125,
  250,
  500,
  750,
  1e3,
  1500,
  2500,
  4e3,
  6e3,
  8500,
  12e3,
  2e4
];
var PERCEPTUAL_BAND_COUNT = PERCEPTUAL_BAND_EDGES_HZ.length - 1;
var ONSET_CLASS_NAMES = [
  null,
  "kick",
  "snare",
  "hat",
  "tonal"
];
var ONSET_CLASS_KICK = 1;
var ONSET_CLASS_SNARE = 2;
var ONSET_CLASS_HAT = 3;
var ONSET_CLASS_TONAL = 4;
var AUDIO_FEATURE_OFFSETS = Object.freeze({
  time: 0,
  flux: 1,
  threshold: 2,
  level: 3,
  crest: 4,
  pan: 5,
  width: 6,
  centroid: 7,
  flatness: 8,
  publicBands: 9,
  onsetStrength: 14,
  onsetClass: 15,
  perceptualBands: 16,
  perceptualFlux: 16 + PERCEPTUAL_BAND_COUNT
});
var AUDIO_FEATURE_FLOATS = 16 + PERCEPTUAL_BAND_COUNT * 2;
var PUBLIC_EDGES = [0, 80, 250, 2e3, 8e3, 2e4];
var PUBLIC_GAINS = [1.6, 1.5, 2.2, 3, 3];
var PUBLIC_BAND_COUNT = 5;
var HISTORY_SECONDS = 1.1;
var WARMUP_SECONDS = 0.25;
var THRESHOLD_SIGMA = 1.55;
var FLUX_FLOOR = 0.012;
var MIN_GAP_SECONDS = 0.09;
var WHITEN_FLOOR = 0.02;
var WHITEN_DECAY_PER_SECOND = 0.36;
var ENERGY_ATTACK_SECONDS = 0.012;
var ENERGY_RELEASE_SECONDS = 0.18;
var FLUX_ATTACK_SECONDS = 4e-3;
var FLUX_RELEASE_SECONDS = 0.085;
var EMPTY_TIME = -1e9;
var SPECTRUM_MIN_DB = -100;
var SPECTRUM_DB_RANGE = 70;
var AdaptiveMultibandDetector = class {
  result = {
    flux: 0,
    threshold: 0,
    onsetStrength: 0,
    onsetClassCode: 0,
    bands: new Float32Array(PERCEPTUAL_BAND_COUNT),
    bandFlux: new Float32Array(PERCEPTUAL_BAND_COUNT),
    publicBands: new Float32Array(PUBLIC_BAND_COUNT)
  };
  bandStart = new Int16Array(PERCEPTUAL_BAND_COUNT);
  bandEnd = new Int16Array(PERCEPTUAL_BAND_COUNT);
  publicWeights = new Float32Array(PUBLIC_BAND_COUNT * PERCEPTUAL_BAND_COUNT);
  publicWeightSums = new Float32Array(PUBLIC_BAND_COUNT);
  energy = new Float32Array(PERCEPTUAL_BAND_COUNT);
  classificationEnergy = new Float32Array(PERCEPTUAL_BAND_COUNT);
  positiveFlux = new Float32Array(PERCEPTUAL_BAND_COUNT);
  peak = new Float32Array(PERCEPTUAL_BAND_COUNT);
  previous = new Float32Array(PERCEPTUAL_BAND_COUNT);
  linearMagnitude = new Float32Array(256);
  historyTime;
  historyFlux;
  historyCapacity;
  historyHead = 0;
  historyCount = 0;
  historySum = 0;
  historySquareSum = 0;
  historyFirstTime = EMPTY_TIME;
  lastOnset = EMPTY_TIME;
  activeBands = 0;
  constructor(sampleRate2, spectrumBins, maximumFramesPerSecond = 1e3) {
    const nyquist = Math.max(1, sampleRate2 * 0.5);
    for (let value = 0; value < 256; value++) {
      const db = SPECTRUM_MIN_DB + value / 255 * SPECTRUM_DB_RANGE;
      this.linearMagnitude[value] = Math.pow(10, db / 20);
    }
    for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
      const lo = PERCEPTUAL_BAND_EDGES_HZ[band];
      const hi = Math.min(nyquist, PERCEPTUAL_BAND_EDGES_HZ[band + 1]);
      const start = Math.min(spectrumBins, Math.max(0, Math.floor(lo / nyquist * spectrumBins)));
      const end = hi > lo ? Math.min(spectrumBins, Math.max(start + 1, Math.ceil(hi / nyquist * spectrumBins))) : start;
      this.bandStart[band] = start;
      this.bandEnd[band] = end;
      if (end > start) this.activeBands++;
      const perceptualHi = PERCEPTUAL_BAND_EDGES_HZ[band + 1];
      for (let pub = 0; pub < PUBLIC_BAND_COUNT; pub++) {
        const overlap = Math.max(
          0,
          Math.min(perceptualHi, PUBLIC_EDGES[pub + 1]) - Math.max(lo, PUBLIC_EDGES[pub])
        );
        const weight = overlap / Math.max(1, perceptualHi - lo);
        this.publicWeights[pub * PERCEPTUAL_BAND_COUNT + band] = weight;
        this.publicWeightSums[pub] = this.publicWeightSums[pub] + weight;
      }
    }
    this.historyCapacity = Math.max(32, Math.ceil(HISTORY_SECONDS * maximumFramesPerSecond) + 4);
    this.historyTime = new Float32Array(this.historyCapacity);
    this.historyFlux = new Float32Array(this.historyCapacity);
    this.reset();
  }
  reset() {
    this.result.flux = 0;
    this.result.threshold = 0;
    this.result.onsetStrength = 0;
    this.result.onsetClassCode = 0;
    this.result.bands.fill(0);
    this.result.bandFlux.fill(0);
    this.result.publicBands.fill(0);
    this.energy.fill(0);
    this.classificationEnergy.fill(0);
    this.positiveFlux.fill(0);
    this.peak.fill(WHITEN_FLOOR);
    this.previous.fill(0);
    this.historyTime.fill(EMPTY_TIME);
    this.historyFlux.fill(0);
    this.historyHead = 0;
    this.historyCount = 0;
    this.historySum = 0;
    this.historySquareSum = 0;
    this.historyFirstTime = EMPTY_TIME;
    this.lastOnset = EMPTY_TIME;
  }
  analyse(spectrum, scale, time, dt, flatness) {
    const safeDt = Math.max(1e-5, Math.min(0.25, dt));
    const peakDecay = Math.pow(WHITEN_DECAY_PER_SECOND, safeDt);
    let flux = 0;
    let active = 0;
    for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
      const start = this.bandStart[band];
      const end = Math.min(this.bandEnd[band], spectrum.length);
      let square = 0;
      let linearSquare = 0;
      for (let bin = start; bin < end; bin++) {
        const raw = (spectrum[bin] ?? 0) * scale;
        const quantized = Math.floor(Math.max(0, Math.min(1, raw)) * 255 + 1e-6);
        const value = quantized / 255;
        square += value * value;
        const linear = this.linearMagnitude[quantized];
        linearSquare += linear * linear;
      }
      const energy = end > start ? Math.sqrt(square / (end - start)) : 0;
      this.energy[band] = energy;
      this.classificationEnergy[band] = end > start ? Math.sqrt(linearSquare / (end - start)) : 0;
      const oldEnvelope = this.result.bands[band];
      const energyTau = energy > oldEnvelope ? ENERGY_ATTACK_SECONDS : ENERGY_RELEASE_SECONDS;
      const energyCoeff = Math.exp(-safeDt / energyTau);
      this.result.bands[band] = energy + (oldEnvelope - energy) * energyCoeff;
      const peak = Math.max(energy, this.peak[band] * peakDecay, WHITEN_FLOOR);
      this.peak[band] = peak;
      const normalised = energy / peak;
      const positive = Math.max(0, normalised - this.previous[band]);
      this.positiveFlux[band] = positive;
      this.previous[band] = normalised;
      const oldFlux = this.result.bandFlux[band];
      const fluxTau = positive > oldFlux ? FLUX_ATTACK_SECONDS : FLUX_RELEASE_SECONDS;
      const fluxCoeff = Math.exp(-safeDt / fluxTau);
      this.result.bandFlux[band] = positive + (oldFlux - positive) * fluxCoeff;
      if (end > start) {
        flux += positive;
        active++;
      }
    }
    flux /= Math.max(1, active);
    this.expireHistory(time);
    const mean = this.historyCount > 0 ? this.historySum / this.historyCount : 0;
    const variance = this.historyCount > 0 ? Math.max(0, this.historySquareSum / this.historyCount - mean * mean) : 0;
    const threshold = mean + THRESHOLD_SIGMA * Math.sqrt(variance);
    const warmed = this.historyFirstTime > EMPTY_TIME * 0.5 && time - this.historyFirstTime >= WARMUP_SECONDS;
    let onsetStrength = 0;
    let onsetClassCode = 0;
    if (warmed && flux > threshold && flux > FLUX_FLOOR && time - this.lastOnset > MIN_GAP_SECONDS) {
      this.lastOnset = time;
      onsetStrength = clamp01(0.55 + (flux - threshold) / Math.max(threshold, 1e-4) * 0.45);
      onsetClassCode = this.classify(flatness);
    }
    this.pushHistory(time, flux);
    this.aggregatePublicBands();
    this.result.flux = flux;
    this.result.threshold = threshold;
    this.result.onsetStrength = onsetStrength;
    this.result.onsetClassCode = onsetClassCode;
    return this.result;
  }
  classify(flatness) {
    let low = 0, mid = 0, high = 0;
    let lowCount = 0, midCount = 0, highCount = 0;
    for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
      if (this.bandEnd[band] <= this.bandStart[band]) continue;
      const density = this.classificationEnergy[band] * (0.2 + this.positiveFlux[band]);
      if (band < 2) {
        low += density;
        lowCount++;
      } else if (band < 7) {
        mid += density;
        midCount++;
      } else {
        high += density;
        highCount++;
      }
    }
    low /= Math.max(1, lowCount);
    mid /= Math.max(1, midCount);
    high /= Math.max(1, highCount);
    const total = low + mid + high + 1e-6;
    const lowShare = low / total;
    const highShare = high / total;
    if (highShare > 0.4) return ONSET_CLASS_HAT;
    if (flatness > 0.28) return ONSET_CLASS_SNARE;
    if (lowShare > 0.56) return ONSET_CLASS_KICK;
    return ONSET_CLASS_TONAL;
  }
  aggregatePublicBands() {
    for (let pub = 0; pub < PUBLIC_BAND_COUNT; pub++) {
      let sum = 0;
      for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
        sum += this.result.bands[band] * this.publicWeights[pub * PERCEPTUAL_BAND_COUNT + band];
      }
      this.result.publicBands[pub] = clamp01(
        sum / Math.max(1e-6, this.publicWeightSums[pub]) * PUBLIC_GAINS[pub]
      );
    }
  }
  expireHistory(time) {
    while (this.historyCount > 0) {
      const tail = (this.historyHead - this.historyCount + this.historyCapacity) % this.historyCapacity;
      if (time - this.historyTime[tail] <= HISTORY_SECONDS) break;
      const old = this.historyFlux[tail];
      this.historySum -= old;
      this.historySquareSum -= old * old;
      this.historyCount--;
    }
    if (this.historyCount === 0) this.historyFirstTime = EMPTY_TIME;
    else {
      const tail = (this.historyHead - this.historyCount + this.historyCapacity) % this.historyCapacity;
      this.historyFirstTime = this.historyTime[tail];
    }
  }
  pushHistory(time, flux) {
    if (this.historyCount === this.historyCapacity) {
      const old = this.historyFlux[this.historyHead];
      this.historySum -= old;
      this.historySquareSum -= old * old;
      this.historyCount--;
    }
    this.historyTime[this.historyHead] = time;
    this.historyFlux[this.historyHead] = flux;
    this.historyHead = (this.historyHead + 1) % this.historyCapacity;
    this.historyCount++;
    this.historySum += flux;
    this.historySquareSum += flux * flux;
    if (this.historyCount === 1) this.historyFirstTime = time;
  }
};
function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// src/worklets/detector.worklet.ts
var RING_FRAMES = 256;
var HEADER_INTS = 4;
var HEADER_BYTES = HEADER_INTS * 4;
var CTL_WRITE_COUNT = 0;
var FFT_N = 512;
var BINS = FFT_N / 2;
var MIN_DB = -100;
var MAX_DB = -30;
var DB_RANGE = MAX_DB - MIN_DB;
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
  detector = new AdaptiveMultibandDetector(sampleRate, BINS, sampleRate / 128);
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
      this.frames = new Float32Array(ring, HEADER_BYTES, RING_FRAMES * AUDIO_FEATURE_FLOATS);
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
    this.detector.reset();
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
    let centroidNumerator = 0, centroidDenominator = 0, logSum = 0, linearSum = 0;
    for (let i = 0; i < BINS; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * scale;
      const db = 20 * Math.log10(mag + 1e-12);
      const value = clamp((db - MIN_DB) / DB_RANGE);
      this.spec[i] = value;
      centroidNumerator += value * i;
      centroidDenominator += value;
      logSum += Math.log(value + 1e-6);
      linearSum += value;
    }
    const centroid = centroidDenominator > 0 ? centroidNumerator / centroidDenominator / BINS : 0;
    const flatness = linearSum > 0 ? Math.exp(logSum / BINS) / (linearSum / BINS) : 0;
    const features = this.detector.analyse(this.spec, 1, t, 128 / sampleRate, flatness);
    if (features.onsetClassCode !== 0) {
      this.onsetMsg.time = t;
      this.onsetMsg.strength = features.onsetStrength;
      this.onsetMsg.klass = ONSET_CLASS_NAMES[features.onsetClassCode] ?? "tonal";
      this.onsetMsg.pan = pan;
      this.port.postMessage(this.onsetMsg);
    }
    this.publish(t, level, crest, pan, width, centroid, flatness);
  }
  /** Write one feature frame and publish it with a single release store. */
  publish(t, level, crest, pan, width, centroid, flatness) {
    const frames = this.frames;
    if (!frames || !this.ctl) return;
    const base = this.writeCount % RING_FRAMES * AUDIO_FEATURE_FLOATS;
    const offsets = AUDIO_FEATURE_OFFSETS;
    const features = this.detector.result;
    frames[base + offsets.time] = t;
    frames[base + offsets.flux] = features.flux;
    frames[base + offsets.threshold] = features.threshold;
    frames[base + offsets.level] = level;
    frames[base + offsets.crest] = crest;
    frames[base + offsets.pan] = pan;
    frames[base + offsets.width] = width;
    frames[base + offsets.centroid] = centroid;
    frames[base + offsets.flatness] = flatness;
    for (let band = 0; band < 5; band++) {
      frames[base + offsets.publicBands + band] = features.publicBands[band];
    }
    frames[base + offsets.onsetStrength] = features.onsetStrength;
    frames[base + offsets.onsetClass] = features.onsetClassCode;
    for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
      frames[base + offsets.perceptualBands + band] = features.bands[band];
      frames[base + offsets.perceptualFlux + band] = features.bandFlux[band];
    }
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
