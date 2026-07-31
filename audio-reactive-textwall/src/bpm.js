// Realtime tempo lock.
//
// Ported from the approach used in a sibling project's offline BPM detector:
// lowpass the signal, pick peaks with a threshold that walks down until enough
// survive, histogram the intervals between nearby peaks, convert each interval
// to a tempo, fold it into a single octave, and rank by how often it recurs.
//
// That implementation is offline — it renders a whole decoded AudioBuffer
// through an OfflineAudioContext, which we cannot do on a live stream. So the
// same algorithm runs here incrementally: onsets arrive one at a time, we keep a
// rolling window of them, and re-score the histogram as they land.
//
// On top of detection we keep a phase lock, so the beat grid keeps ticking
// through breakdowns and quiet bars instead of going dead.

const MIN_BPM = 90;
const MAX_BPM = 180;
const MAX_LOOKAHEAD = 10;   // pair each onset with the next N, as the original does
const WINDOW = 48;          // onsets retained
const MIN_ONSETS = 8;       // below this there is nothing worth scoring

export class TempoTracker {
  constructor() {
    this.onsets = [];       // timestamps in seconds
    this.bpm = 0;
    this.confidence = 0;
    this.locked = false;

    this.phase = 0;         // 0..1 through the current beat
    this.beatIndex = 0;
    this.barPhase = 0;      // 0..1 through a 4-beat bar
    this._nextBeat = 0;     // absolute time of the next grid beat
    this.onBeat = null;     // fires on the predicted grid, not on raw onsets
    this.onDownbeat = null;
  }

  reset() {
    this.onsets.length = 0;
    this.bpm = 0;
    this.confidence = 0;
    this.locked = false;
    this._nextBeat = 0;
    this.beatIndex = 0;
    this.phase = 0;
    this.barPhase = 0;
  }

  // Call from the onset detector with the current audio clock in seconds.
  addOnset(t) {
    const last = this.onsets[this.onsets.length - 1];
    if (last !== undefined && t - last < 0.12) return; // debounce double-triggers
    this.onsets.push(t);
    if (this.onsets.length > WINDOW) this.onsets.shift();
    if (this.onsets.length >= MIN_ONSETS) this._score();

    // Nudge the grid toward a strong onset when we drift too far from it. This
    // moves the *next beat* by a fraction of a period, never more — an earlier
    // version eased a running anchor instead, and because the beat index was
    // recomputed from that anchor every frame, a run of late onsets could push
    // the index backwards and the grid would stop emitting beats entirely.
    if (this.locked && this._nextBeat) {
      const period = 60 / this.bpm;
      const err = wrapSigned(t - this._nextBeat, period);
      if (Math.abs(err) > period * 0.12) this._nextBeat += err * 0.25; // ease, don't snap
    }
  }

  _score() {
    // Interval histogram over nearby onset pairs.
    const intervals = new Map();
    for (let i = 0; i < this.onsets.length; i++) {
      for (let j = 1; j <= MAX_LOOKAHEAD; j++) {
        const k = i + j;
        if (k >= this.onsets.length) break;
        const dt = this.onsets[k] - this.onsets[i];
        if (dt <= 0) continue;
        const tempo = foldTempo(60 / dt);
        if (!tempo) continue;
        const key = Math.round(tempo);
        intervals.set(key, (intervals.get(key) || 0) + 1);
      }
    }
    if (!intervals.size) return;

    // Smear each bin into its neighbours so 127/128/129 reinforce instead of
    // splitting the vote — the offline version gets tight bins for free from a
    // whole file, we do not.
    const smoothed = new Map();
    let total = 0;
    for (const [tempo, count] of intervals) {
      for (let d = -2; d <= 2; d++) {
        const w = count * (1 - Math.abs(d) * 0.3);
        smoothed.set(tempo + d, (smoothed.get(tempo + d) || 0) + w);
      }
      total += count;
    }

    let best = 0;
    let bestScore = 0;
    for (const [tempo, score] of smoothed) {
      if (tempo < MIN_BPM || tempo > MAX_BPM) continue;
      if (score > bestScore) { bestScore = score; best = tempo; }
    }
    if (!best) return;

    this.confidence = Math.min(1, bestScore / Math.max(total, 1));

    // Glide toward the new estimate so the grid does not jump on one bad bar.
    if (!this.bpm) this.bpm = best;
    else if (Math.abs(best - this.bpm) > 6) this.bpm = best; // genuine tempo change
    else this.bpm += (best - this.bpm) * 0.2;

    this.locked = this.confidence > 0.12 && this.onsets.length >= MIN_ONSETS;
  }

  // Advance the predicted grid. `now` is the same clock used for addOnset.
  update(now) {
    if (!this.locked || !this.bpm) {
      this.phase = 0;
      return;
    }
    const period = 60 / this.bpm;
    if (!this._nextBeat) this._nextBeat = now + period;

    // Walk forward over every boundary we crossed. Bounded, so a backgrounded
    // tab resuming after a minute does not dump a hundred callbacks at once.
    let guard = 4;
    while (now >= this._nextBeat && guard-- > 0) {
      this._nextBeat += period;
      this.beatIndex++;
      this.onBeat?.();
      if (this.beatIndex % 4 === 0) this.onDownbeat?.();
    }
    if (now >= this._nextBeat) this._nextBeat = now + period; // fell too far behind

    this.phase = 1 - Math.max(0, Math.min(1, (this._nextBeat - now) / period));
    this.barPhase = ((this.beatIndex % 4) + this.phase) / 4;
  }
}

function foldTempo(bpm) {
  if (!isFinite(bpm) || bpm <= 0) return 0;
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm /= 2;
  return bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : 0;
}

function wrapSigned(v, period) {
  const m = ((v % period) + period) % period;
  return m > period / 2 ? m - period : m;
}
