// Audio analysis: level, three bands, and a beat envelope.
// Sources: microphone, an audio file, or an internal metronome so the page is
// alive with no input at all.

import { TempoTracker } from './bpm.js';

const BANDS = {
  bass: [20, 160],
  mid: [160, 2000],
  treble: [2000, 8000],
};

// Onset detection tuning.
const DETECT_RING = 256;      // ring capacity; the window below is what decides
const DETECT_WINDOW = 1.1;    // seconds of flux history the threshold adapts over
const DETECT_K = 1.6;         // threshold = mean + K * stddev
const DETECT_FLOOR = 0.004;   // absolute floor, so silence cannot self-trigger
const DETECT_HZ = 8000;       // ignore bins above this; nothing percussive up there
const MIN_GAP = 0.09;         // hard refractory in seconds

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.freq = null;
    this.time = null;
    this.detector = null; // second, unsmoothed analyser used only for onsets
    this.input = null; // hub every source connects to
    this.monitor = null; // input -> monitor -> speakers, gain 0 unless playing a file
    this.node = null; // current source node
    this.el = null; // <audio> when playing a file

    this.level = 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.beat = 0;
    this.gain = 1;
    // How readily onsets trigger. Divides the stddev multiplier, so turning it
    // down raises the bar and only the hardest hits get through. Separate from
    // `gain`, which scales what you SEE and never touches detection.
    this.beatSens = 1;

    this.mode = 'metronome';
    this.bpm = 120;

    // Tempo lock. Onsets from the detector below feed it; it hands back a beat
    // grid that keeps running even when the track drops out.
    this.tempo = new TempoTracker();
    this._clock = 0;

    // Fixed-size spectrum handed to the shaders as a texture. Kept separate from
    // the analyser's own bin array because that array's length depends on
    // fftSize and only exists once an AudioContext has been created — this one
    // is always present and always the same size, including in metronome mode.
    this.spectrum = new Uint8Array(256);

    this._metroPhase = 0;

    // Onset detection state. The history is a ring of (time, flux) pairs rather
    // than a fixed frame count — a 43-frame window is 0.72 s at 60 Hz but 0.30 s
    // at 144 Hz, so the old detector silently changed character with the display.
    this._prevSpec = null;
    this._fluxT = new Float32Array(DETECT_RING);
    this._fluxV = new Float32Array(DETECT_RING);
    this._fi = 0;
    this._lastBeat = -1;
  }

  _ensure() {
    if (this.ctx) return this.ctx;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Every source connects to `input`, and the taps hang off it once. Sources
    // then only ever touch one node, and monitoring is a gain value instead of
    // connect/disconnect bookkeeping on the analyser.
    this.input = this.ctx.createGain();
    this.monitor = this.ctx.createGain();
    this.monitor.gain.value = 0;
    this.input.connect(this.monitor);
    this.monitor.connect(this.ctx.destination);

    // Smoothed — this is what the meters and the shaders read. Smoothing is what
    // stops the bars strobing.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this.input.connect(this.analyser);

    // Unsmoothed, and deliberately coarser. Onsets are *edges*; running the
    // detector off the smoothed analyser was averaging away the very transient
    // it was looking for. AVS keeps the same separation — its beat detector
    // reads the raw FFT buffer, not the one the components render from.
    this.detector = this.ctx.createAnalyser();
    this.detector.fftSize = 1024;
    this.detector.smoothingTimeConstant = 0;
    this.input.connect(this.detector);

    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);
    this.spec = new Uint8Array(this.detector.frequencyBinCount);
    this._prevSpec = new Uint8Array(this.detector.frequencyBinCount);
    return this.ctx;
  }

  // Onsets are differences between consecutive frames, so a source swap looks
  // like one enormous onset unless the previous frame is forgotten.
  _resetDetector() {
    if (this._prevSpec) this._prevSpec.fill(0);
    this._fluxT.fill(0);
    this._fluxV.fill(0);
    this._fi = 0;
    this._lastBeat = -1;
    this.beat = 0;
  }

  _disconnect() {
    if (this.node) {
      try { this.node.disconnect(); } catch { /* already gone */ }
      this.node = null;
    }
    if (this.monitor) this.monitor.gain.value = 0;
    this._resetDetector();
    if (this.el) {
      this.el.pause();
      if (this.el.src.startsWith('blob:')) URL.revokeObjectURL(this.el.src);
      this.el = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  async useMic() {
    const ctx = this._ensure();
    await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this._disconnect(); // tears down whatever was playing, including an older mic stream
    this.stream = stream;
    this.node = ctx.createMediaStreamSource(stream);
    this.node.connect(this.input); // monitor gain stays 0 — never feed a mic back to the speakers
    this.tempo.reset();
    this.mode = 'mic';
  }

  // Names that usually indicate a loopback / "what you hear" input on Windows.
  // Ordered roughly by how likely they are to be the real desktop feed.
  static LOOPBACK_HINTS = [
    // Realtek / onboard
    'stereo mix', 'stereomix', 'what u hear', 'what you hear',
    // VB-Audio
    'cable output', 'vb-audio', 'voicemeeter',
    // Virtual Audio Cable (Eugene Muzychenko) names its cables "Line 1", "Line 2"…
    'virtual audio cable', 'line 1', 'line 2', 'line 3',
    // Audio interfaces that expose loopback as extra input channels.
    // Scarlett 4th gen puts it on inputs 3-4, so it enumerates as "Analogue 3 + 4"
    // rather than anything containing the word "loopback".
    'loopback', 'mix 1', 'mix l', 'analogue 3', 'analog 3', '3 + 4', '3+4',
    // Generic
    'wave out', 'wasapi', 'monitor of',
  ];

  // Enumerate audio inputs. Labels are blank until the page holds a microphone
  // permission, so this asks for one first — that grant is what makes the whole
  // device route work without a picker afterwards.
  async listInputs() {
    const ctx = this._ensure();
    await ctx.resume();

    let probe = null;
    try {
      probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Denied — we can still enumerate, just without readable labels.
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    if (probe) probe.getTracks().forEach((t) => t.stop());

    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => {
        const label = d.label || `Input ${i + 1}`;
        const lower = label.toLowerCase();
        const loopback = AudioEngine.LOOPBACK_HINTS.some((h) => lower.includes(h));
        return { deviceId: d.deviceId, label, loopback };
      });
  }

  // Connect a specific input. This is the good path for desktop audio: pick the
  // loopback device once and it persists — no share picker, no video track, and
  // no browser "you are sharing" bar.
  async useDevice(deviceId) {
    const ctx = this._ensure();
    await ctx.resume();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // All three off: any processing meant for speech mangles music, and
        // AGC in particular flattens exactly the dynamics we visualise.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this._disconnect();
    this.stream = stream;
    this.node = ctx.createMediaStreamSource(stream);
    this.node.connect(this.input); // no monitoring — loopback into the speakers is a feedback loop
    this.tempo.reset();
    this.mode = 'device';
    this.deviceLabel = stream.getAudioTracks()[0]?.label || '';
  }

  // Capture through the screen-share picker. Which surface you pick decides
  // whether you get audio at all:
  //
  //   Chrome Tab     -> audio supported on every platform
  //   Entire Screen  -> audio supported on Windows; the ONLY way to reach a
  //                     native app like the Spotify desktop client
  //   A Window       -> no audio, ever. Picking a window is the usual reason
  //                     "system audio doesn't work".
  //
  // `systemAudio: 'include'` asks Chrome to actually surface the system-audio
  // option, and `monitorTypeSurfaces` keeps whole screens in the picker.
  async useSystemAudio() {
    const ctx = this._ensure();
    await ctx.resume();

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // Chrome only offers the audio checkbox when video is requested
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      monitorTypeSurfaces: 'include',
    });

    const track = stream.getAudioTracks()[0];
    if (!track) {
      const surface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface;
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(surface === 'window'
        ? 'A single window can never carry audio. Re-pick "Entire Screen" and tick "Also share system audio" — that is the only way to capture a desktop app.'
        : 'No audio in that share — re-pick and tick "Share tab audio" / "Also share system audio". Note DRM tabs (Spotify Web) capture silent; use Entire Screen instead.');
    }

    this._disconnect();
    this.stream = stream;
    this.node = ctx.createMediaStreamSource(stream);
    this.node.connect(this.input); // already audible at the source — do not monitor
    this.tempo.reset();
    this.mode = 'system';

    // Hitting the browser's "Stop sharing" bar drops us back to the metronome.
    track.addEventListener('ended', () => {
      this.useMetronome();
      this.onSourceEnded?.();
    });
  }

  async useFile(file) {
    const ctx = this._ensure();
    await ctx.resume();
    this._disconnect();
    const el = new Audio(URL.createObjectURL(file));
    el.loop = true;
    el.crossOrigin = 'anonymous';
    this.el = el;
    this.node = ctx.createMediaElementSource(el);
    this.node.connect(this.input);
    this.monitor.gain.value = 1; // a dropped file is the one source you cannot already hear
    await el.play();
    this.tempo.reset();
    this.mode = 'file';
  }

  useMetronome() {
    this._disconnect();
    this.tempo.reset();
    this.mode = 'metronome';
  }

  // dt in seconds
  update(dt) {
    this._clock += dt;

    if (this.mode === 'metronome' || !this.analyser) {
      this._updateMetronome(dt);
      this.tempo.update(this._clock);
      return;
    }

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.time);

    let sum = 0;
    for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
    const rms = Math.sqrt(sum / this.time.length);

    const nyquist = this.ctx.sampleRate / 2;
    const binOf = (hz) => Math.min(this.freq.length - 1, Math.round((hz / nyquist) * this.freq.length));
    const band = ([lo, hi]) => {
      const a = binOf(lo);
      const b = binOf(hi);
      let s = 0;
      for (let i = a; i <= b; i++) s += this.freq[i];
      return s / ((b - a + 1) * 255);
    };

    const g = this.gain;
    this.level = clamp(rms * 4 * g);
    this.bass = clamp(band(BANDS.bass) * 1.6 * g);
    this.mid = clamp(band(BANDS.mid) * 2.2 * g);
    this.treble = clamp(band(BANDS.treble) * 3.0 * g);

    // Resample the analyser bins down to our fixed 256, taking the max of each
    // group rather than the mean — peaks are what the eye reads, and averaging
    // buries a narrow spike under its quiet neighbours.
    const step = this.freq.length / this.spectrum.length;
    for (let i = 0; i < this.spectrum.length; i++) {
      const a = Math.floor(i * step);
      const b = Math.min(this.freq.length, Math.floor((i + 1) * step));
      let peak = 0;
      for (let j = a; j < b; j++) if (this.freq[j] > peak) peak = this.freq[j];
      this.spectrum[i] = Math.min(255, peak * g);
    }

    this._detectBeat(dt);
    this.tempo.update(this._clock);
  }

  // Spectral flux onset detection.
  //
  // The old version compared bass energy against its own running mean. That
  // fires on anything *loud*, which on a sustained bassline means it fires
  // continuously and on a breakdown means it fires never. An onset is not
  // loudness, it is a sudden increase — so sum only the positive frame-to-frame
  // changes across the spectrum and threshold that instead.
  //
  // Three things follow from this that the energy version could not do: it
  // catches snares and claps as well as kicks, it ignores a bass note being
  // held, and it is independent of the Sensitivity slider (that scales the
  // display values only, so dragging it no longer re-triggers the whole show).
  _detectBeat(dt) {
    this.detector.getByteFrequencyData(this.spec);

    const nyq = this.ctx.sampleRate / 2;
    const top = Math.min(this.spec.length, Math.ceil((DETECT_HZ / nyq) * this.spec.length));

    let flux = 0;
    let wsum = 0;
    for (let i = 0; i < top; i++) {
      // Weight the low end up: a kick should outrank a hi-hat, but not silence
      // one. Flat weighting made brushed percussion trigger as hard as a drop.
      const w = 1 + 3 * Math.exp(-i / 5);
      const d = this.spec[i] - this._prevSpec[i];
      if (d > 0) flux += d * w;
      wsum += w;
      this._prevSpec[i] = this.spec[i];
    }
    flux /= wsum * 255;

    // Threshold adapts to both the mean and the spread of recent flux. The
    // stddev term is what stops it machine-gunning through a dense section
    // while still catching a single hit in a sparse one — a fixed multiple of
    // the mean cannot do both.
    const t = this._clock;
    this._fluxT[this._fi] = t;
    this._fluxV[this._fi] = flux;
    this._fi = (this._fi + 1) % DETECT_RING;

    let n = 0;
    let sum = 0;
    let sum2 = 0;
    for (let i = 0; i < DETECT_RING; i++) {
      if (t - this._fluxT[i] > DETECT_WINDOW) continue;
      const v = this._fluxV[i];
      sum += v;
      sum2 += v * v;
      n++;
    }
    const mean = n ? sum / n : 0;
    const varc = n ? Math.max(0, sum2 / n - mean * mean) : 0;
    const thresh = mean + (DETECT_K / Math.max(this.beatSens, 0.05)) * Math.sqrt(varc);

    // Refractory. Once the tempo is known, forbid anything faster than a
    // half-beat; before that fall back to a flat floor.
    const gap = this.tempo.locked && this.tempo.bpm
      ? Math.max(MIN_GAP, (60 / this.tempo.bpm) * 0.45)
      : MIN_GAP;

    this.beat *= Math.exp(-dt * 7);

    if (flux > thresh && flux > DETECT_FLOOR && t - this._lastBeat > gap) {
      this._lastBeat = t;
      // Scale the pulse by how far over threshold it landed, so a ghost note
      // does not hit as hard as a downbeat. Floored so weak hits still read.
      const strength = clamp(0.55 + (flux - thresh) / Math.max(thresh, 1e-4) * 0.45);
      this.beat = Math.max(this.beat, strength);
      this.tempo.addOnset(t); // feeds the tempo histogram
      this.onBeat?.();
    }
  }

  _updateMetronome(dt) {
    const period = 60 / this.bpm;
    this._metroPhase += dt / period;
    const fired = this._metroPhase >= 1;
    if (fired) {
      this._metroPhase -= Math.floor(this._metroPhase);
      this.beat = 1;
      this.tempo.addOnset(this._clock);
      this.onBeat?.();
    } else {
      this.beat *= Math.exp(-dt * 7);
    }
    const p = this._metroPhase;
    const env = Math.exp(-p * 5);
    const g = this.gain;
    this.bass = clamp(env * 0.9 * g);
    this.mid = clamp((0.25 + 0.35 * Math.sin(p * Math.PI * 4)) * env * g);
    this.treble = clamp(Math.exp(-p * 14) * 0.8 * g);
    this.level = clamp((0.15 + env * 0.5) * g);

    // Synthesised spectrum so spectrum-driven effects still do something with no
    // audio connected: a decaying tilt plus a couple of moving formants.
    for (let i = 0; i < this.spectrum.length; i++) {
      const f = i / this.spectrum.length;
      const tilt = Math.exp(-f * 3.2);
      const f1 = Math.exp(-Math.pow((f - 0.18 - 0.05 * Math.sin(this._clock * 1.3)) * 12, 2));
      const f2 = Math.exp(-Math.pow((f - 0.52 + 0.08 * Math.sin(this._clock * 0.7)) * 9, 2));
      // Floor the envelope: with pure `env` the synthesised spectrum collapses
      // to silence between beats and spectrum-driven effects look broken when
      // no real audio is connected.
      const v = (tilt * 0.75 + f1 * 0.5 + f2 * 0.35) * (0.35 + env * 0.65) * g;
      this.spectrum[i] = Math.max(0, Math.min(255, v * 255));
    }
  }
}

function clamp(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
