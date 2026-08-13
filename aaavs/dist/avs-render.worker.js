// src/avs/types.ts
var AVS_PRESET_HEADER_V1 = "Nullsoft AVS Preset 0.1";
var AVS_PRESET_HEADER_V2 = "Nullsoft AVS Preset 0.2";
var AVS_AUDIO_SAMPLES = 576;
var AVS_FFT_SIZE = 512;
var AVS_FFT_BINS = AVS_FFT_SIZE / 2;

// src/avs/preset.ts
var HEADER_BYTES = 24;
var ROOT_CONFIG_BYTES = 1;
var EFFECT_LIST_ID = -2;
var DLL_RENDER_BASE = 16384;
var TEXT = new TextDecoder("windows-1252");
var EFFECT_LIST_CODE_ID = 16384;
var EFFECT_LIST_CODE_NAME = "AVS 2.8+ Effect List Config";
var AvsPresetError = class extends Error {
  constructor(message, offset) {
    super(`${message} (byte ${offset})`);
    this.offset = offset;
    this.name = "AvsPresetError";
  }
};
function parseAvsPreset(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES + ROOT_CONFIG_BYTES) {
    throw new AvsPresetError("AVS preset is shorter than its header", bytes.byteLength);
  }
  const header = decode(bytes.subarray(0, HEADER_BYTES));
  let version;
  if (header === AVS_PRESET_HEADER_V2) version = 2;
  else if (header === AVS_PRESET_HEADER_V1) version = 1;
  else throw new AvsPresetError(`Unsupported AVS preset signature ${JSON.stringify(header)}`, 0);
  const components = readComponents(bytes, HEADER_BYTES + ROOT_CONFIG_BYTES, bytes.byteLength, "");
  return {
    version,
    header,
    clearEveryFrame: bytes[HEADER_BYTES] === 1,
    components,
    byteLength: bytes.byteLength
  };
}
function readComponents(bytes, start, end, parent, absoluteBase = 0) {
  const components = [];
  let cursor = start;
  let ordinal = 0;
  while (cursor < end) {
    if (end - cursor < 8) {
      for (let i = cursor; i < end; i++) {
        if (bytes[i] !== 0) throw new AvsPresetError("Truncated renderer record", absoluteBase + cursor);
      }
      break;
    }
    ordinal++;
    const path = parent ? `${parent}.${ordinal}` : `${ordinal}`;
    const effectId = i32(bytes, cursor);
    const isApe = effectId !== EFFECT_LIST_ID && effectId >>> 0 >= DLL_RENDER_BASE;
    const headerBytes = isApe ? 40 : 8;
    requireBytes(cursor, headerBytes, end, "renderer header", absoluteBase);
    const apeId = isApe ? nulText(bytes.subarray(cursor + 4, cursor + 36)) : null;
    const lengthOffset = cursor + 4 + (isApe ? 32 : 0);
    const payloadLength = u32(bytes, lengthOffset);
    const payloadStart = cursor + headerBytes;
    const payloadEnd = payloadStart + payloadLength;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > end) {
      throw new AvsPresetError(
        `Renderer ${path} payload (${payloadLength} bytes) exceeds its container`,
        absoluteBase + lengthOffset
      );
    }
    const payload = bytes.slice(payloadStart, payloadEnd);
    let list = null;
    let listCode = null;
    let children = [];
    if (effectId === EFFECT_LIST_ID && payload.length > 0) {
      list = readListSettings(payload, payloadStart);
      let childOffset = list.byteLength;
      const codeRecord = readEffectListCode(payload, childOffset, payloadStart);
      if (codeRecord) {
        listCode = codeRecord.code;
        childOffset = codeRecord.nextOffset;
      }
      children = readComponents(payload, childOffset, payload.length, path, absoluteBase + payloadStart);
    }
    components.push({
      effectId,
      apeId,
      payload,
      fileOffset: absoluteBase + cursor,
      path,
      children,
      list,
      listCode
    });
    cursor = payloadEnd;
  }
  return components;
}
function readListSettings(payload, absoluteOffset) {
  const extended = (payload[0] & 128) !== 0;
  if (!extended) {
    const mode2 = payload[0];
    return {
      mode: mode2,
      // r_list.h stores a DISABLE bit. This inversion is easy to miss because
      // most serialized modes are zero, meaning an enabled, uncleared list.
      enabled: (mode2 & 2) === 0,
      clearEveryFrame: (mode2 & 1) !== 0,
      inputBlendMode: mode2 >>> 8 & 31,
      // The output selector is stored with bit zero toggled for historical
      // compatibility with the original list renderer.
      outputBlendMode: mode2 >>> 16 & 31 ^ 1,
      inputBlendValue: 128,
      outputBlendValue: 128,
      inputBuffer: 0,
      outputBuffer: 0,
      inputInvert: false,
      outputInvert: false,
      beatRender: false,
      beatRenderFrames: 1,
      byteLength: 1
    };
  }
  requireBytes(0, 5, payload.length, "extended Effect List header", absoluteOffset);
  const mode = u32(payload, 1);
  const byteLength = payload[4] + 1;
  if (byteLength < 5 || byteLength > payload.length) {
    throw new AvsPresetError(`Invalid Effect List header length ${byteLength}`, absoluteOffset + 4);
  }
  const ext = (index, fallback) => 5 + index * 4 + 4 <= byteLength ? i32(payload, 5 + index * 4) : fallback;
  return {
    mode,
    enabled: (mode & 2) === 0,
    clearEveryFrame: (mode & 1) !== 0,
    inputBlendMode: mode >>> 8 & 31,
    outputBlendMode: mode >>> 16 & 31 ^ 1,
    inputBlendValue: ext(0, 128),
    outputBlendValue: ext(1, 128),
    inputBuffer: ext(2, 0),
    outputBuffer: ext(3, 0),
    inputInvert: ext(4, 0) !== 0,
    outputInvert: ext(5, 0) !== 0,
    beatRender: ext(6, 0) !== 0,
    beatRenderFrames: ext(7, 1),
    byteLength
  };
}
function readEffectListCode(payload, offset, absoluteOffset) {
  if (payload.length - offset < 40) return null;
  if (i32(payload, offset) !== EFFECT_LIST_CODE_ID) return null;
  const name = nulText(payload.subarray(offset + 4, offset + 36));
  if (name !== EFFECT_LIST_CODE_NAME) return null;
  const length = u32(payload, offset + 36);
  const start = offset + 40;
  const end = start + length;
  if (end > payload.length) {
    throw new AvsPresetError("Effect List code record exceeds its container", absoluteOffset + offset + 36);
  }
  const raw = payload.slice(start, end);
  const decoded = decodeListCode(raw);
  return { code: { ...decoded, raw }, nextOffset: end };
}
function decodeListCode(raw) {
  if (raw.length < 4) return { enabled: false, init: "", frame: "" };
  let cursor = 0;
  const enabled = i32(raw, cursor) !== 0;
  cursor += 4;
  const readString4 = () => {
    if (cursor + 4 > raw.length) return "";
    const length = u32(raw, cursor);
    cursor += 4;
    const end = Math.min(raw.length, cursor + length);
    const value = nulText(raw.subarray(cursor, end));
    cursor = end;
    return value;
  };
  return { enabled, init: readString4(), frame: readString4() };
}
function requireBytes(offset, length, end, what, base = 0) {
  if (offset < 0 || length < 0 || offset + length > end) {
    throw new AvsPresetError(`Truncated ${what}`, base + offset);
  }
}
function u32(bytes, offset) {
  requireBytes(offset, 4, bytes.length, "uint32");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}
function i32(bytes, offset) {
  requireBytes(offset, 4, bytes.length, "int32");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}
function decode(bytes) {
  return TEXT.decode(bytes);
}
function nulText(bytes) {
  const zero = bytes.indexOf(0);
  return decode(zero < 0 ? bytes : bytes.subarray(0, zero));
}

// src/avs/audio.ts
var AvsBeatDetector = class {
  slowPeak = 0;
  fastPeak = 0;
  lastTriggerPeak = 0;
  reset() {
    this.slowPeak = 0;
    this.fastPeak = 0;
    this.lastTriggerPeak = 0;
  }
  update(waveform) {
    let left = 0;
    let right = 0;
    for (let i = 0; i < AVS_AUDIO_SAMPLES; i++) {
      left += Math.abs(signedByte(waveform[0][i]));
      right += Math.abs(signedByte(waveform[1][i]));
    }
    const level = Math.max(left, right);
    this.slowPeak = (125 * this.slowPeak + 3 * this.fastPeak) / 128;
    const beat = level >= 34 / 32 * this.slowPeak && level > AVS_AUDIO_SAMPLES * 16;
    if (beat) {
      this.slowPeak = (level + this.lastTriggerPeak) * 0.5;
      this.lastTriggerPeak = level;
    } else {
      this.fastPeak = Math.max(level, this.fastPeak * 14 / 16);
    }
    return { beat, level };
  }
};
var AvsAudioAnalyser = class {
  beat = new AvsBeatDetector();
  reset() {
    this.beat.reset();
  }
  analyse(pcm) {
    if (pcm.left.length < AVS_AUDIO_SAMPLES) {
      throw new RangeError(`AVS audio analysis needs ${AVS_AUDIO_SAMPLES} PCM frames`);
    }
    const right = pcm.right ?? pcm.left;
    if (right.length < AVS_AUDIO_SAMPLES) {
      throw new RangeError(`AVS right channel needs ${AVS_AUDIO_SAMPLES} PCM frames`);
    }
    const waveform = [pcmBytes(pcm.left), pcmBytes(right)];
    const spectrum = [
      spectrumBytes(waveform[0]),
      spectrumBytes(waveform[1])
    ];
    const hit = this.beat.update(waveform);
    return { waveform, spectrum, beat: hit.beat, beatLevel: hit.level };
  }
};
function avsLogSpectrumByte(value) {
  const x = clamp(value, 0, 255);
  return clamp(Math.floor(255 * Math.log(1 + 60 * x / 255) / Math.log(60)), 0, 255);
}
var AvsAudioAccumulator = class {
  waveform = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)];
  spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)];
  beat = new AvsBeatDetector();
  beatLatched = false;
  beatLevel = 0;
  push(waveform, spectrum) {
    validateHostFrame(waveform, "waveform");
    validateHostFrame(spectrum, "spectrum");
    for (let channel = 0; channel < 2; channel++) {
      this.waveform[channel].set(waveform[channel]);
      const held = this.spectrum[channel];
      const incoming = spectrum[channel];
      for (let i = 0; i < AVS_AUDIO_SAMPLES; i++) {
        const mapped = avsLogSpectrumByte(incoming[i]);
        if (mapped > held[i]) held[i] = mapped;
      }
    }
    const hit = this.beat.update(waveform);
    this.beatLatched ||= hit.beat;
    this.beatLevel = hit.level;
  }
  consume() {
    const waveform = [this.waveform[0].slice(), this.waveform[1].slice()];
    const spectrum = [this.spectrum[0].slice(), this.spectrum[1].slice()];
    const frame = { waveform, spectrum, beat: this.beatLatched, beatLevel: this.beatLevel };
    this.spectrum[0].fill(0);
    this.spectrum[1].fill(0);
    this.beatLatched = false;
    return frame;
  }
  reset() {
    this.waveform[0].fill(0);
    this.waveform[1].fill(0);
    this.spectrum[0].fill(0);
    this.spectrum[1].fill(0);
    this.beat.reset();
    this.beatLatched = false;
    this.beatLevel = 0;
  }
};
function avsAudioSample(frame, kind, band, width, channelValue) {
  const channel = Math.floor(channelValue + 0.5);
  if (channel < 0 || channel > 2) return 0;
  let centre = Math.trunc(band * AVS_AUDIO_SAMPLES);
  let span = Math.max(1, Math.trunc(width * AVS_AUDIO_SAMPLES));
  centre -= Math.trunc(span / 2);
  if (centre < 0) {
    span += centre;
    centre = 0;
  }
  if (centre > AVS_AUDIO_SAMPLES - 1) centre = AVS_AUDIO_SAMPLES - 1;
  if (centre + span > AVS_AUDIO_SAMPLES) span = AVS_AUDIO_SAMPLES - centre;
  if (span <= 0) return 0;
  const end = centre + span;
  let sum = 0;
  let count = 0;
  for (let i = centre; i < end; i++) {
    const read = (ch) => kind === "osc" ? ((frame.waveform[ch][i] ^ 128) - 128) / 127.5 : frame.spectrum[ch][i] / 255;
    sum += channel === 0 ? (read(0) + read(1)) * 0.5 : read(channel - 1);
    count++;
  }
  return count > 0 ? sum / count : 0;
}
function pcmBytes(samples) {
  const out = new Uint8Array(AVS_AUDIO_SAMPLES);
  for (let i = 0; i < out.length; i++) {
    const value = clamp(samples[i], -1, 1);
    const pcm16 = value <= -1 ? -32768 : Math.round(value * 32767);
    out[i] = pcm16 >> 8 & 255;
  }
  return out;
}
function spectrumBytes(waveform) {
  const re = new Float64Array(AVS_FFT_SIZE);
  const im = new Float64Array(AVS_FFT_SIZE);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < AVS_FFT_SIZE; i++) {
    const x = signedByte(waveform[i]);
    const y = x - x1 + 0.99 * y1;
    x1 = x;
    y1 = y;
    const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (AVS_FFT_SIZE - 1));
    re[i] = y * hann;
  }
  fft(re, im);
  const out = new Uint8Array(AVS_AUDIO_SAMPLES);
  let last = 0;
  for (let bin = 0; bin < AVS_FFT_BINS; bin++) {
    const magnitude = clamp(Math.hypot(re[bin], im[bin]) / 16, 0, 255);
    const smooth = (magnitude + last) * 0.5;
    out[bin * 2] = avsLogSpectrumByte(smooth);
    out[bin * 2 + 1] = avsLogSpectrumByte(magnitude);
    last = magnitude;
  }
  for (let i = AVS_FFT_SIZE; i < AVS_AUDIO_SAMPLES; i++) {
    last *= 0.5;
    out[i] = avsLogSpectrumByte(last);
  }
  return out;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    const stepR = Math.cos(angle);
    const stepI = Math.sin(angle);
    for (let base = 0; base < n; base += size) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const even = base + j;
        const odd = even + size / 2;
        const tr = wr * re[odd] - wi * im[odd];
        const ti = wr * im[odd] + wi * re[odd];
        re[odd] = re[even] - tr;
        im[odd] = im[even] - ti;
        re[even] = re[even] + tr;
        im[even] = im[even] + ti;
        const nextWr = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR;
        wr = nextWr;
      }
    }
  }
}
function signedByte(value) {
  return value < 128 ? value : value - 256;
}
function validateHostFrame(frame, label) {
  if (frame[0].length < AVS_AUDIO_SAMPLES || frame[1].length < AVS_AUDIO_SAMPLES) {
    throw new RangeError(`AVS ${label} callback needs two ${AVS_AUDIO_SAMPLES}-byte channels`);
  }
}
function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

// src/avs/eel/types.ts
var AvsEelSyntaxError = class extends SyntaxError {
  constructor(message, offset, source) {
    const before = source.slice(0, offset);
    const line = before.split("\n").length;
    const lastNewline = before.lastIndexOf("\n");
    const column = offset - lastNewline;
    super(`${message} at ${line}:${column}`);
    this.offset = offset;
    this.name = "AvsEelSyntaxError";
  }
};
var AvsEelCompileError = class extends Error {
  constructor(message, span) {
    super(`${message} (characters ${span.start}-${span.end})`);
    this.span = span;
    this.name = "AvsEelCompileError";
  }
};

// src/avs/eel/parser.ts
var ASSIGNMENTS = /* @__PURE__ */ new Set(["=", "+=", "-=", "*=", "/=", "%=", "|=", "&=", "^=", "**="]);
var PRECEDENCE = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "===": 6,
  "!==": 6,
  "<": 7,
  "<=": 7,
  ">": 7,
  ">=": 7,
  "<<": 8,
  ">>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
  "**": 11
};
function parseAvsEel(source) {
  const parser = new Parser(source);
  return { kind: "program", source, body: parser.program() };
}
var Parser = class {
  constructor(source) {
    this.source = source;
    this.lexer = new Lexer(source);
    this.current = this.lexer.next();
  }
  lexer;
  current;
  program() {
    const values = [];
    for (; ; ) {
      if (this.current.kind === "eof") break;
      if (this.take(";") || this.take(",")) continue;
      values.push(this.expression(0, true));
      if (this.take(";") || this.take(",")) continue;
      if (this.current.lineBreakBefore) continue;
      if (this.startsExpression()) continue;
      if (!this.atEnd()) this.fail(`Expected statement separator, got ${JSON.stringify(this.current.text)}`);
    }
    if (values.length === 0) return { kind: "number", value: 0, span: { start: 0, end: 0 } };
    if (values.length === 1) return values[0];
    return {
      kind: "sequence",
      values,
      span: { start: values[0].span.start, end: values[values.length - 1].span.end }
    };
  }
  expression(minPrecedence, stopAtComma) {
    let left = this.prefix();
    for (; ; ) {
      if (stopAtComma && this.current.text === ",") break;
      if (this.current.text === "?") {
        if (minPrecedence > 0) break;
        this.advance();
        const yes = this.expression(0, true);
        this.expect(":");
        const no = this.expression(0, stopAtComma);
        left = { kind: "conditional", condition: left, yes, no, span: { start: left.span.start, end: no.span.end } };
        continue;
      }
      if (ASSIGNMENTS.has(this.current.text)) {
        if (minPrecedence > 0) break;
        const operator2 = this.current.text;
        this.advance();
        const value = this.expression(0, stopAtComma);
        left = { kind: "assign", operator: operator2, target: left, value, span: { start: left.span.start, end: value.span.end } };
        continue;
      }
      const precedence = PRECEDENCE[this.current.text];
      if (precedence === void 0 || precedence < minPrecedence) break;
      const operator = this.current.text;
      this.advance();
      const right = this.expression(operator === "**" ? precedence : precedence + 1, stopAtComma);
      left = { kind: "binary", operator, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }
  prefix() {
    const token = this.current;
    if (token.kind === "number") {
      this.advance();
      const value = Number(token.text);
      if (!Number.isFinite(value)) this.fail(`Invalid number ${JSON.stringify(token.text)}`, token.start);
      return { kind: "number", value, span: { start: token.start, end: token.end } };
    }
    if (token.kind === "identifier") {
      this.advance();
      const name = token.text.toLowerCase();
      if (!this.take("(")) return { kind: "variable", name, span: { start: token.start, end: token.end } };
      const args = [];
      if (!this.take(")")) {
        do {
          args.push(this.expression(0, true));
        } while (this.take(","));
        this.expect(")");
      }
      return { kind: "call", name, args, span: { start: token.start, end: this.previousEnd } };
    }
    if (token.text === "(") {
      this.advance();
      const values = [];
      while (!this.take(")")) {
        if (this.current.kind === "eof") this.fail("Unterminated parenthesized expression", token.start);
        if (this.take(";") || this.take(",")) continue;
        values.push(this.expression(0, true));
        if (this.current.text !== ")" && !this.take(";") && !this.take(",") && !this.current.lineBreakBefore && !this.startsExpression()) {
          this.fail(`Expected separator or ')', got ${JSON.stringify(this.current.text)}`);
        }
      }
      if (values.length === 0) return { kind: "number", value: 0, span: { start: token.start, end: this.previousEnd } };
      if (values.length === 1) return values[0];
      return { kind: "sequence", values, span: { start: token.start, end: this.previousEnd } };
    }
    if (token.text === "+" || token.text === "-" || token.text === "!" || token.text === "~") {
      this.advance();
      const value = this.expression(12, true);
      return { kind: "unary", operator: token.text, value, span: { start: token.start, end: value.span.end } };
    }
    this.fail(`Expected expression, got ${JSON.stringify(token.text)}`);
  }
  previousEnd = 0;
  startsExpression() {
    return this.current.kind === "number" || this.current.kind === "identifier" || this.current.text === "(" || this.current.text === "+" || this.current.text === "-" || this.current.text === "!" || this.current.text === "~";
  }
  atEnd() {
    return this.current.kind === "eof";
  }
  advance() {
    this.previousEnd = this.current.end;
    this.current = this.lexer.next();
  }
  take(text) {
    if (this.current.text !== text) return false;
    this.advance();
    return true;
  }
  expect(text) {
    if (!this.take(text)) this.fail(`Expected ${JSON.stringify(text)}, got ${JSON.stringify(this.current.text)}`);
  }
  fail(message, offset = this.current.start) {
    throw new AvsEelSyntaxError(message, offset, this.source);
  }
};
var Lexer = class {
  constructor(source) {
    this.source = source;
  }
  offset = 0;
  next() {
    const lineBreakBefore = this.skipTrivia();
    const start = this.offset;
    if (start >= this.source.length) return { kind: "eof", text: "", start, end: start, lineBreakBefore };
    const rest = this.source.slice(start);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) return this.token("number", number[0], lineBreakBefore);
    const identifier = /^[$A-Za-z_][$A-Za-z0-9_]*/.exec(rest);
    if (identifier) return this.token("identifier", identifier[0], lineBreakBefore);
    for (const operator of ["!==", "===", "**=", "<<=", ">>=", "!=", "==", "<=", ">=", "&&", "||", "<<", ">>", "**", "+=", "-=", "*=", "/=", "%=", "|=", "&=", "^="]) {
      if (rest.startsWith(operator)) return this.token("operator", operator, lineBreakBefore);
    }
    const char = this.source[start];
    if ("+-*/%^|&!=<>~".includes(char)) return this.token("operator", char, lineBreakBefore);
    if ("(),;?:".includes(char)) return this.token("punctuation", char, lineBreakBefore);
    throw new AvsEelSyntaxError(`Unexpected character ${JSON.stringify(char)}`, start, this.source);
  }
  token(kind, text, lineBreakBefore) {
    const start = this.offset;
    this.offset += text.length;
    return { kind, text, start, end: this.offset, lineBreakBefore };
  }
  skipTrivia() {
    let lineBreak = false;
    for (; ; ) {
      while (this.offset < this.source.length && this.source[this.offset] !== "\xA0" && /\s/.test(this.source[this.offset])) {
        lineBreak ||= this.source[this.offset] === "\n" || this.source[this.offset] === "\r";
        this.offset++;
      }
      if (this.source[this.offset] === "\xA0" || this.source[this.offset] === "\xA3" || this.source[this.offset] === "\xA4" || this.source[this.offset] === "\xA9") {
        const semicolon = this.source.indexOf(";", this.offset + 1);
        const relativeNewline = this.source.slice(this.offset + 1).search(/\r?\n/);
        const newline = relativeNewline < 0 ? -1 : this.offset + 1 + relativeNewline;
        const end = semicolon >= 0 && (newline < 0 || semicolon < newline) ? semicolon + 1 : newline < 0 ? this.source.length : newline;
        this.offset = end;
        continue;
      }
      if (this.source.startsWith("//", this.offset)) {
        const newline = this.source.indexOf("\n", this.offset + 2);
        this.offset = newline < 0 ? this.source.length : newline + 1;
        lineBreak = true;
        continue;
      }
      if (this.source[this.offset] === "/" && this.source[this.offset + 1] !== "*" && this.atLineStart(this.offset) && /[\sA-Za-z_]/.test(this.source[this.offset + 1] ?? "")) {
        const newline = this.source.indexOf("\n", this.offset + 1);
        this.offset = newline < 0 ? this.source.length : newline + 1;
        lineBreak = true;
        continue;
      }
      if (this.source.startsWith("/*", this.offset)) {
        const end = this.source.indexOf("*/", this.offset + 2);
        if (end < 0) throw new AvsEelSyntaxError("Unterminated block comment", this.offset, this.source);
        lineBreak ||= /[\r\n]/.test(this.source.slice(this.offset, end + 2));
        this.offset = end + 2;
        continue;
      }
      break;
    }
    return lineBreak;
  }
  atLineStart(offset) {
    const newline = this.source.lastIndexOf("\n", offset - 1);
    return this.source.slice(newline + 1, offset).trim().length === 0;
  }
};

// src/avs/eel/jit.ts
var CLOSE = 1e-5;
var HELPERS = {
  truth(value) {
    return Math.abs(value) >= CLOSE;
  },
  close(a, b) {
    return Math.abs(a - b) < CLOSE;
  },
  integer(value) {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  },
  finite(value) {
    return Number.isFinite(value) ? value : 0;
  },
  divide(a, b) {
    return Math.abs(b) < Number.EPSILON ? 0 : Number.isFinite(a / b) ? a / b : 0;
  },
  modulo(a, b) {
    return Math.abs(b) < Number.EPSILON ? 0 : Number.isFinite(a % b) ? a % b : 0;
  },
  assignment(operator, left, right) {
    let result;
    switch (operator) {
      case "=":
        result = right;
        break;
      case "+=":
        result = left + right;
        break;
      case "-=":
        result = left - right;
        break;
      case "*=":
        result = left * right;
        break;
      case "/=":
        result = this.divide(left, right);
        break;
      case "%=":
        result = this.modulo(left, right);
        break;
      case "|=":
        result = this.integer(left) | this.integer(right);
        break;
      case "&=":
        result = this.integer(left) & this.integer(right);
        break;
      case "^=":
        result = this.integer(left) ^ this.integer(right);
        break;
      case "**=":
        result = Math.pow(left, right);
        break;
      default:
        result = 0;
    }
    return this.finite(result);
  }
};
function compileAvsEelJit(node) {
  const builder = new Builder();
  let result;
  try {
    result = builder.expression(node);
  } catch (error) {
    if (error instanceof UnsupportedJitNode) return null;
    throw error;
  }
  const declarations = [...builder.variables.values()].map((index) => `const a${index}=b[${index}].values,j${index}=b[${index}].index;`).join("");
  const source = `${declarations}return function(){${builder.lines.join("")}return ${result};}`;
  if (source.length > 24e3) return null;
  let factory;
  try {
    factory = new Function("vm", "b", "H", source);
  } catch {
    return null;
  }
  const names = [...builder.variables.keys()];
  return (vm) => factory(vm, names.map((name) => vm.bindVariable(name)), HELPERS);
}
var Builder = class {
  variables = /* @__PURE__ */ new Map();
  lines = [];
  temporary = 0;
  expression(node) {
    switch (node.kind) {
      case "number":
        return numberLiteral(node.value);
      case "variable":
        return this.variable(node.name);
      case "sequence": {
        let result = "0";
        for (const value of node.values) {
          result = this.expression(value);
          const next = this.temp();
          this.lines.push(`const ${next}=H.finite(${result});`);
          result = next;
        }
        return result;
      }
      case "unary":
        return this.unary(node.operator, node.value);
      case "binary":
        return this.binary(node.operator, node.left, node.right);
      case "conditional":
        return this.conditional(node.condition, node.yes, node.no);
      case "assign":
        return this.assign(node.operator, node.target, node.value);
      case "call":
        return this.call(node.name, node.args);
    }
  }
  variable(rawName) {
    if (rawName === "$pi") return "Math.PI";
    if (rawName === "$e") return "Math.E";
    if (rawName === "$phi") return "((1+Math.sqrt(5))*.5)";
    const index = this.variableIndex(rawName);
    return `(a${index}[j${index}]??0)`;
  }
  variableLocation(rawName) {
    const index = this.variableIndex(rawName);
    return `a${index}[j${index}]`;
  }
  variableIndex(rawName) {
    const name = normalizeVariable(rawName);
    let index = this.variables.get(name);
    if (index === void 0) {
      index = this.variables.size;
      this.variables.set(name, index);
    }
    return index;
  }
  unary(operator, valueNode) {
    const value = this.expression(valueNode);
    switch (operator) {
      case "+":
        return `H.finite(${value})`;
      case "-":
        return `H.finite(-(${value}))`;
      case "!":
        return `(H.truth(${value})?0:1)`;
      case "~":
        return `(~H.integer(${value}))`;
      default:
        throw new UnsupportedJitNode();
    }
  }
  binary(operator, leftNode, rightNode) {
    const left = this.store(this.expression(leftNode));
    if (operator === "&&" || operator === "||") {
      const result = this.temp();
      this.lines.push(`let ${result};`);
      if (operator === "&&") {
        this.lines.push(`if(H.truth(${left})){`);
        const right2 = this.expression(rightNode);
        this.lines.push(`${result}=H.truth(${right2})?1:0;}else{${result}=0;}`);
      } else {
        this.lines.push(`if(H.truth(${left})){${result}=1;}else{`);
        const right2 = this.expression(rightNode);
        this.lines.push(`${result}=H.truth(${right2})?1:0;}`);
      }
      return result;
    }
    const right = this.expression(rightNode);
    switch (operator) {
      case "+":
        return `H.finite((${left})+(${right}))`;
      case "-":
        return `H.finite((${left})-(${right}))`;
      case "*":
        return `H.finite((${left})*(${right}))`;
      case "/":
        return `H.divide(${left},${right})`;
      case "%":
        return `H.modulo(${left},${right})`;
      case "**":
        return `H.finite(Math.pow(${left},${right}))`;
      case "|":
        return `(H.integer(${left})|H.integer(${right}))`;
      case "&":
        return `(H.integer(${left})&H.integer(${right}))`;
      case "^":
        return `(H.integer(${left})^H.integer(${right}))`;
      case "<<":
        return `(H.integer(${left})<<(H.integer(${right})&31))`;
      case ">>":
        return `(H.integer(${left})>>(H.integer(${right})&31))`;
      case "<":
        return `((${left})<(${right})?1:0)`;
      case "<=":
        return `((${left})<=(${right})?1:0)`;
      case ">":
        return `((${left})>(${right})?1:0)`;
      case ">=":
        return `((${left})>=(${right})?1:0)`;
      case "==":
        return `(H.close(${left},${right})?1:0)`;
      case "!=":
        return `(H.close(${left},${right})?0:1)`;
      case "===":
        return `((${left})===(${right})?1:0)`;
      case "!==":
        return `((${left})!==(${right})?1:0)`;
      default:
        throw new UnsupportedJitNode();
    }
  }
  conditional(conditionNode, yesNode, noNode) {
    const condition = this.expression(conditionNode);
    const result = this.temp();
    this.lines.push(`let ${result};if(H.truth(${condition})){`);
    const yes = this.expression(yesNode);
    this.lines.push(`${result}=${yes};}else{`);
    const no = this.expression(noNode);
    this.lines.push(`${result}=${no};}`);
    return result;
  }
  assign(operator, target, valueNode) {
    if (target.kind === "variable") {
      if (target.name === "$pi" || target.name === "$e" || target.name === "$phi") throw new UnsupportedJitNode();
      const targetAccess = this.variableLocation(target.name);
      const right = this.expression(valueNode);
      const rightTemp = this.store(right);
      const left = this.store(targetAccess);
      const result = this.temp();
      this.lines.push(`const ${result}=H.assignment(${JSON.stringify(operator)},${left},${rightTemp});`);
      this.lines.push(`${targetAccess}=${result};`);
      return result;
    }
    if (isMemoryCall(target)) {
      const address = this.store(this.expression(target.args[0]));
      const right = this.store(this.expression(valueNode));
      const global = target.name === "gmegabuf";
      const left = this.store(`vm.readMemory(${global},${address})`);
      const result = this.temp();
      this.lines.push(`const ${result}=H.assignment(${JSON.stringify(operator)},${left},${right});`);
      this.lines.push(`vm.writeMemory(${global},${address},${result});`);
      return result;
    }
    throw new UnsupportedJitNode();
  }
  call(name, nodes) {
    if (name === "if") return this.conditional(nodes[0], nodes[1], nodes[2]);
    if (name === "loop") {
      const count = this.store(this.expression(nodes[0]));
      const iterations = this.temp();
      const result = this.temp();
      const iterator = this.temp();
      this.lines.push(`const ${iterations}=Math.min(Math.max(0,H.integer(${count})),vm.maxLoopIterations);let ${result}=0;for(let ${iterator}=0;${iterator}<${iterations};${iterator}++){`);
      const body = this.expression(nodes[1]);
      this.lines.push(`${result}=${body};}`);
      return `H.finite(${result})`;
    }
    if (name === "assign") {
      const target = nodes[0];
      if (target.kind === "variable") {
        const access = this.variableLocation(target.name);
        const value = this.store(`H.finite(${this.expression(nodes[1])})`);
        this.lines.push(`${access}=${value};`);
        return value;
      }
      if (isMemoryCall(target)) {
        const address = this.store(this.expression(target.args[0]));
        const value = this.store(`H.finite(${this.expression(nodes[1])})`);
        this.lines.push(`vm.writeMemory(${target.name === "gmegabuf"},${address},${value});`);
        return value;
      }
      throw new UnsupportedJitNode();
    }
    if (name === "megabuf" || name === "gmegabuf") {
      return `vm.readMemory(${name === "gmegabuf"},${this.expression(nodes[0])})`;
    }
    const args = nodes.map((node) => this.store(this.expression(node)));
    const one = (fn) => `H.finite(${fn}(${args[0]}))`;
    const two = (fn) => `H.finite(${fn}(${args[0]},${args[1]}))`;
    switch (name) {
      case "sin":
        return one("Math.sin");
      case "cos":
        return one("Math.cos");
      case "tan":
        return one("Math.tan");
      case "asin":
        return one("Math.asin");
      case "acos":
        return one("Math.acos");
      case "atan":
        return one("Math.atan");
      case "atan2":
        return two("Math.atan2");
      case "sqrt":
        return one("Math.sqrt");
      case "sqr":
        return `H.finite((${args[0]})*(${args[0]}))`;
      case "invsqrt":
        return `H.finite(1/Math.sqrt(${args[0]}))`;
      case "pow":
        return two("Math.pow");
      case "exp":
        return one("Math.exp");
      case "log":
        return one("Math.log");
      case "log10":
        return one("Math.log10");
      case "abs":
        return one("Math.abs");
      case "floor":
        return one("Math.floor");
      case "ceil":
        return one("Math.ceil");
      case "int":
        return one("Math.trunc");
      case "sign":
        return `((${args[0]})<0?-1:((${args[0]})>0?1:0))`;
      case "min":
        return two("Math.min");
      case "max":
        return two("Math.max");
      case "equal":
        return `(H.close(${args[0]},${args[1]})?1:0)`;
      case "above":
        return `((${args[0]})>(${args[1]})?1:0)`;
      case "below":
        return `((${args[0]})<(${args[1]})?1:0)`;
      case "band":
        return `(H.truth(${args[0]})&&H.truth(${args[1]})?1:0)`;
      case "bor":
        return `(H.truth(${args[0]})||H.truth(${args[1]})?1:0)`;
      case "bnot":
        return `(H.truth(${args[0]})?0:1)`;
      case "rand":
        return `vm.random(${args[0]})`;
      case "getosc":
        return `vm.host("getosc",${args[0]},${args[1]},${args[2]})`;
      case "getspec":
        return `vm.host("getspec",${args[0]},${args[1]},${args[2]})`;
      case "gettime":
        return `vm.host("gettime",${args[0]})`;
      case "getkbmouse":
        return `vm.host("getkbmouse",${args[0]})`;
      default:
        throw new UnsupportedJitNode();
    }
  }
  store(expression) {
    const temporary = this.temp();
    this.lines.push(`const ${temporary}=${expression};`);
    return temporary;
  }
  temp() {
    return `t${this.temporary++}`;
  }
};
var UnsupportedJitNode = class extends Error {
};
function isMemoryCall(node) {
  return node.kind === "call" && (node.name === "megabuf" || node.name === "gmegabuf") && node.args.length === 1;
}
function normalizeVariable(name) {
  return name.toLowerCase().slice(0, 8);
}
function numberLiteral(value) {
  return Number.isFinite(value) ? String(value) : "0";
}

// src/avs/eel/compiler.ts
var CLOSE2 = 1e-5;
function compileAvsEel(source) {
  return compileAvsEelAst(parseAvsEel(source));
}
function compileAvsEelAst(ast) {
  const fallback = compileNode(ast.body);
  const bindJit = ast.source.length <= 1400 ? compileAvsEelJit(ast.body) : null;
  let boundVm;
  let boundExecute;
  const execute7 = (vm) => {
    if (vm !== boundVm) {
      boundVm = vm;
      boundExecute = bindJit ? bindJit(vm) : () => fallback(vm);
    }
    return boundExecute();
  };
  return { source: ast.source, ast, execute: execute7 };
}
function compileNode(node) {
  switch (node.kind) {
    case "number":
      return () => node.value;
    case "variable": {
      if (node.name === "$pi") return () => Math.PI;
      if (node.name === "$e") return () => Math.E;
      if (node.name === "$phi") return () => (1 + Math.sqrt(5)) * 0.5;
      const name = normalizeVariable2(node.name);
      const access = variableAccess(name);
      return (vm) => access.get(vm);
    }
    case "sequence": {
      const values = node.values.map(compileNode);
      return (vm) => {
        let result = 0;
        for (const value of values) result = finite(value(vm));
        return result;
      };
    }
    case "unary": {
      const value = compileNode(node.value);
      switch (node.operator) {
        case "+":
          return (vm) => finite(value(vm));
        case "-":
          return (vm) => finite(-value(vm));
        case "!":
          return (vm) => truth(value(vm)) ? 0 : 1;
        case "~":
          return (vm) => ~integer(value(vm));
        default:
          throw new AvsEelCompileError(`Unknown unary operator ${node.operator}`, node.span);
      }
    }
    case "binary":
      return compileBinary(node.operator, compileNode(node.left), compileNode(node.right), node.span);
    case "conditional": {
      const condition = compileNode(node.condition);
      const yes = compileNode(node.yes);
      const no = compileNode(node.no);
      return (vm) => truth(condition(vm)) ? yes(vm) : no(vm);
    }
    case "assign": {
      if (node.target.kind === "variable") {
        const name = normalizeVariable2(node.target.name);
        const access = variableAccess(name);
        const value2 = compileNode(node.value);
        return (vm) => {
          const right = value2(vm);
          const left = access.get(vm);
          const result = assignment(node.operator, left, right);
          access.set(vm, result);
          return result;
        };
      }
      if (node.target.kind === "call" && (node.target.name === "megabuf" || node.target.name === "gmegabuf")) {
        arity(node.target.name, node.target.args, 1, node.target.span);
        const global = node.target.name === "gmegabuf";
        const index = compileNode(node.target.args[0]);
        const value2 = compileNode(node.value);
        return (vm) => {
          const address = index(vm);
          const right = value2(vm);
          const left = vm.readMemory(global, address);
          const result = assignment(node.operator, left, right);
          vm.writeMemory(global, address, result);
          return result;
        };
      }
      const target = compileReference(node.target);
      const value = compileNode(node.value);
      return (vm) => {
        const reference = target(vm);
        const right = value(vm);
        const left = reference.get();
        const result = assignment(node.operator, left, right);
        reference.set(result);
        return result;
      };
    }
    case "call":
      return compileCall(node.name, node.args, node.span);
  }
}
function compileBinary(operator, left, right, span) {
  switch (operator) {
    case "&&":
      return (vm) => truth(left(vm)) ? truth(right(vm)) ? 1 : 0 : 0;
    case "||":
      return (vm) => truth(left(vm)) ? 1 : truth(right(vm)) ? 1 : 0;
    case "+":
      return (vm) => finite(left(vm) + right(vm));
    case "-":
      return (vm) => finite(left(vm) - right(vm));
    case "*":
      return (vm) => finite(left(vm) * right(vm));
    case "/":
      return (vm) => divide(left(vm), right(vm));
    case "%":
      return (vm) => modulo(left(vm), right(vm));
    case "**":
      return (vm) => finite(Math.pow(left(vm), right(vm)));
    case "|":
      return (vm) => integer(left(vm)) | integer(right(vm));
    case "&":
      return (vm) => integer(left(vm)) & integer(right(vm));
    case "^":
      return (vm) => integer(left(vm)) ^ integer(right(vm));
    case "<<":
      return (vm) => integer(left(vm)) << (integer(right(vm)) & 31);
    case ">>":
      return (vm) => integer(left(vm)) >> (integer(right(vm)) & 31);
    case "<":
      return (vm) => left(vm) < right(vm) ? 1 : 0;
    case "<=":
      return (vm) => left(vm) <= right(vm) ? 1 : 0;
    case ">":
      return (vm) => left(vm) > right(vm) ? 1 : 0;
    case ">=":
      return (vm) => left(vm) >= right(vm) ? 1 : 0;
    case "==":
      return (vm) => close(left(vm), right(vm)) ? 1 : 0;
    case "!=":
      return (vm) => close(left(vm), right(vm)) ? 0 : 1;
    case "===":
      return (vm) => left(vm) === right(vm) ? 1 : 0;
    case "!==":
      return (vm) => left(vm) !== right(vm) ? 1 : 0;
    default:
      throw new AvsEelCompileError(`Unknown binary operator ${operator}`, span);
  }
}
function compileCall(name, nodes, span) {
  if (name === "if") {
    arity(name, nodes, 3, span);
    const condition = compileNode(nodes[0]);
    const yes = compileNode(nodes[1]);
    const no = compileNode(nodes[2]);
    return (vm) => truth(condition(vm)) ? yes(vm) : no(vm);
  }
  if (name === "loop") {
    arity(name, nodes, 2, span);
    const count = compileNode(nodes[0]);
    const body = compileNode(nodes[1]);
    return (vm) => {
      const iterations = Math.min(Math.max(0, integer(count(vm))), vm.maxLoopIterations);
      let result = 0;
      for (let i = 0; i < iterations; i++) result = body(vm);
      return finite(result);
    };
  }
  if (name === "assign") {
    arity(name, nodes, 2, span);
    const value = compileNode(nodes[1]);
    if (nodes[0].kind === "variable") {
      const targetName = normalizeVariable2(nodes[0].name);
      const access = variableAccess(targetName);
      return (vm) => {
        const result = finite(value(vm));
        access.set(vm, result);
        return result;
      };
    }
    if (nodes[0].kind === "call" && (nodes[0].name === "megabuf" || nodes[0].name === "gmegabuf")) {
      const global = nodes[0].name === "gmegabuf";
      const index = compileNode(nodes[0].args[0]);
      return (vm) => {
        const address = index(vm);
        const result = finite(value(vm));
        vm.writeMemory(global, address, result);
        return result;
      };
    }
    const target = compileReference(nodes[0]);
    return (vm) => {
      const reference = target(vm);
      const result = finite(value(vm));
      reference.set(result);
      return result;
    };
  }
  if (name === "megabuf" || name === "gmegabuf") {
    arity(name, nodes, 1, span);
    const index = compileNode(nodes[0]);
    return (vm) => vm.readMemory(name === "gmegabuf", index(vm));
  }
  const args = nodes.map(compileNode);
  const one = (fn) => {
    arity(name, nodes, 1, span);
    return (vm) => finite(fn(args[0](vm)));
  };
  const two = (fn) => {
    arity(name, nodes, 2, span);
    return (vm) => finite(fn(args[0](vm), args[1](vm)));
  };
  switch (name) {
    case "sin":
      return one(Math.sin);
    case "cos":
      return one(Math.cos);
    case "tan":
      return one(Math.tan);
    case "asin":
      return one(Math.asin);
    case "acos":
      return one(Math.acos);
    case "atan":
      return one(Math.atan);
    case "atan2":
      return two(Math.atan2);
    case "sqrt":
      return one(Math.sqrt);
    case "sqr":
      return one((v) => v * v);
    case "invsqrt":
      return one((v) => 1 / Math.sqrt(v));
    case "pow":
      return two(Math.pow);
    case "exp":
      return one(Math.exp);
    case "log":
      return one(Math.log);
    case "log10":
      return one(Math.log10);
    case "abs":
      return one(Math.abs);
    case "floor":
      return one(Math.floor);
    case "ceil":
      return one(Math.ceil);
    case "int":
      return one(Math.trunc);
    case "sign":
      return one((v) => v < 0 ? -1 : v > 0 ? 1 : 0);
    case "min":
      return two(Math.min);
    case "max":
      return two(Math.max);
    case "equal":
      return two((a, b) => close(a, b) ? 1 : 0);
    case "above":
      return two((a, b) => a > b ? 1 : 0);
    case "below":
      return two((a, b) => a < b ? 1 : 0);
    case "band":
      return two((a, b) => truth(a) && truth(b) ? 1 : 0);
    case "bor":
      return two((a, b) => truth(a) || truth(b) ? 1 : 0);
    case "bnot":
      return one((v) => truth(v) ? 0 : 1);
    case "rand": {
      arity(name, nodes, 1, span);
      return (vm) => vm.random(args[0](vm));
    }
    case "getosc":
    case "getspec": {
      arity(name, nodes, 3, span);
      return (vm) => vm.host(name, args[0](vm), args[1](vm), args[2](vm));
    }
    case "gettime":
    case "getkbmouse": {
      arity(name, nodes, 1, span);
      return (vm) => vm.host(name, args[0](vm));
    }
    default:
      throw new AvsEelCompileError(`Unknown EEL function ${name}`, span);
  }
}
function compileReference(node) {
  if (node.kind === "variable") {
    if (node.name === "$pi" || node.name === "$e" || node.name === "$phi") {
      throw new AvsEelCompileError(`Cannot assign to constant ${node.name}`, node.span);
    }
    const name = normalizeVariable2(node.name);
    let boundVm;
    let reference;
    return (vm) => {
      if (vm !== boundVm) {
        boundVm = vm;
        reference = vm.variable(name);
      }
      return reference;
    };
  }
  if (node.kind === "call" && (node.name === "megabuf" || node.name === "gmegabuf")) {
    arity(node.name, node.args, 1, node.span);
    const index = compileNode(node.args[0]);
    return (vm) => vm.memory(node.name === "gmegabuf", index(vm));
  }
  if (node.kind === "conditional") {
    const condition = compileNode(node.condition);
    const yes = compileReference(node.yes);
    const no = compileReference(node.no);
    return (vm) => truth(condition(vm)) ? yes(vm) : no(vm);
  }
  if (node.kind === "call" && node.name === "if") {
    arity(node.name, node.args, 3, node.span);
    const condition = compileNode(node.args[0]);
    const yes = compileReference(node.args[1]);
    const no = compileReference(node.args[2]);
    return (vm) => truth(condition(vm)) ? yes(vm) : no(vm);
  }
  throw new AvsEelCompileError("Assignment target must be a variable, memory cell, or conditional reference", node.span);
}
function arity(name, args, expected, span) {
  if (args.length !== expected) throw new AvsEelCompileError(`${name} expects ${expected} arguments, got ${args.length}`, span);
}
function truth(value) {
  return Math.abs(value) >= CLOSE2;
}
function close(a, b) {
  return Math.abs(a - b) < CLOSE2;
}
function integer(value) {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}
function finite(value) {
  return Number.isFinite(value) ? value : 0;
}
function divide(a, b) {
  return Math.abs(b) < Number.EPSILON ? 0 : finite(a / b);
}
function modulo(a, b) {
  return Math.abs(b) < Number.EPSILON ? 0 : finite(a % b);
}
function normalizeVariable2(name) {
  return name.toLowerCase().slice(0, 8);
}
function variableAccess(name) {
  let boundVm;
  let binding;
  const resolve = (vm) => {
    if (vm !== boundVm) {
      boundVm = vm;
      binding = vm.bindVariable(name);
    }
    return binding;
  };
  return {
    get(vm) {
      const cell = resolve(vm);
      return cell.values[cell.index] ?? 0;
    },
    set(vm, value) {
      const cell = resolve(vm);
      cell.values[cell.index] = finite(value);
    }
  };
}
function assignment(operator, left, right) {
  let result;
  switch (operator) {
    case "=":
      result = right;
      break;
    case "+=":
      result = left + right;
      break;
    case "-=":
      result = left - right;
      break;
    case "*=":
      result = left * right;
      break;
    case "/=":
      result = divide(left, right);
      break;
    case "%=":
      result = modulo(left, right);
      break;
    case "|=":
      result = integer(left) | integer(right);
      break;
    case "&=":
      result = integer(left) & integer(right);
      break;
    case "^=":
      result = integer(left) ^ integer(right);
      break;
    case "**=":
      result = Math.pow(left, right);
      break;
    default:
      result = 0;
  }
  return finite(result);
}

// src/avs/eel/vm.ts
var REGISTER_COUNT = 100;
var MEMORY_BLOCK_SIZE = 16384;
var MEMORY_BLOCK_COUNT = 64;
var MEMORY_CELL_COUNT = MEMORY_BLOCK_SIZE * MEMORY_BLOCK_COUNT;
var DEFAULT_MAX_LOOPS = 4096;
var MEMORY_CLOSE_FACTOR = 1e-5;
var AvsEelMemory = class {
  blocks = /* @__PURE__ */ new Map();
  read(value) {
    const index = memoryIndex(value);
    if (index < 0) return 0;
    const block = this.blocks.get(Math.floor(index / MEMORY_BLOCK_SIZE));
    return block?.[index % MEMORY_BLOCK_SIZE] ?? 0;
  }
  write(value, next) {
    const index = memoryIndex(value);
    if (index < 0) return;
    const blockIndex = Math.floor(index / MEMORY_BLOCK_SIZE);
    let block = this.blocks.get(blockIndex);
    if (!block) {
      if (next === 0) return;
      block = new Float64Array(MEMORY_BLOCK_SIZE);
      this.blocks.set(blockIndex, block);
    }
    block[index % MEMORY_BLOCK_SIZE] = Number.isFinite(next) ? next : 0;
  }
  clear() {
    this.blocks.clear();
  }
};
var AvsEelGlobalState = class {
  registers = new Float64Array(REGISTER_COUNT);
  memory = new AvsEelMemory();
  reset() {
    this.registers.fill(0);
    this.memory.clear();
  }
};
var AvsEelVm = class {
  global;
  localMemory = new AvsEelMemory();
  maxLoopIterations;
  hostFunctions;
  randomState;
  references = /* @__PURE__ */ new Map();
  bindings = /* @__PURE__ */ new Map();
  variableIndexes = /* @__PURE__ */ new Map();
  variableValues = [];
  constructor(options = {}) {
    this.global = options.global ?? new AvsEelGlobalState();
    this.hostFunctions = options.host ?? {};
    this.randomState = options.seed === void 0 ? 1831565813 : options.seed >>> 0;
    this.maxLoopIterations = Math.max(0, Math.trunc(options.maxLoopIterations ?? DEFAULT_MAX_LOOPS));
  }
  execute(program) {
    return program.execute(this);
  }
  setHost(host) {
    this.hostFunctions = host;
  }
  reseed(seed) {
    this.randomState = seed >>> 0;
  }
  get(name) {
    return this.variable(name).get();
  }
  set(name, value) {
    this.variable(name).set(value);
  }
  /** Resolve an EEL identifier to stable numeric storage once per VM. */
  bindVariable(rawName) {
    const name = rawName.toLowerCase().slice(0, 8);
    const cached = this.bindings.get(name);
    if (cached) return cached;
    const register = registerIndex(name);
    let binding;
    if (register >= 0) {
      binding = { values: this.global.registers, index: register };
    } else {
      let index = this.variableIndexes.get(name);
      if (index === void 0) {
        index = this.variableValues.length;
        this.variableIndexes.set(name, index);
        this.variableValues.push(0);
      }
      binding = { values: this.variableValues, index };
    }
    this.bindings.set(name, binding);
    return binding;
  }
  /** Fast path for compiler-normalized static identifiers. */
  getVariable(name) {
    const binding = this.bindVariable(name);
    return binding.values[binding.index] ?? 0;
  }
  /** Fast path for compiler-normalized static identifiers. */
  setVariable(name, value) {
    const binding = this.bindVariable(name);
    binding.values[binding.index] = clean(value);
  }
  variable(rawName) {
    const name = rawName.toLowerCase().slice(0, 8);
    const cached = this.references.get(name);
    if (cached) return cached;
    const binding = this.bindVariable(name);
    const reference = {
      get: () => binding.values[binding.index] ?? 0,
      set: (value) => {
        binding.values[binding.index] = clean(value);
      }
    };
    this.references.set(name, reference);
    return reference;
  }
  memory(global, rawIndex) {
    const memory = global ? this.global.memory : this.localMemory;
    const index = memoryIndex(rawIndex);
    return { get: () => memory.read(index), set: (value) => memory.write(index, clean(value)) };
  }
  readMemory(global, index) {
    return (global ? this.global.memory : this.localMemory).read(index);
  }
  writeMemory(global, index, value) {
    (global ? this.global.memory : this.localMemory).write(index, clean(value));
  }
  host(name, first, second = 0, third = 0) {
    const fn = this.hostFunctions[name];
    if (!fn) return 0;
    if (name === "getosc" || name === "getspec") {
      return clean(fn(first, second, third));
    }
    return clean(fn(first));
  }
  random(limit) {
    let state = this.randomState + 2654435769 >>> 0;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.randomState = state >>> 0;
    const bound = Math.max(0, Math.trunc(limit));
    return bound > 1 ? this.randomState % bound : 0;
  }
  resetLocal() {
    this.variableValues.fill(0);
    this.localMemory.clear();
  }
};
function memoryIndex(value) {
  if (!Number.isFinite(value) || value < 0) return -1;
  const index = Math.trunc(value + MEMORY_CLOSE_FACTOR);
  return index < 0 || index >= MEMORY_CELL_COUNT ? -1 : index;
}
function clean(value) {
  return Number.isFinite(value) ? value : 0;
}
function registerIndex(name) {
  if (name.length !== 5 || name.charCodeAt(0) !== 114 || name.charCodeAt(1) !== 101 || name.charCodeAt(2) !== 103) return -1;
  const tens = name.charCodeAt(3) - 48;
  const ones = name.charCodeAt(4) - 48;
  return tens >= 0 && tens <= 9 && ones >= 0 && ones <= 9 ? tens * 10 + ones : -1;
}

// src/avs/framebuffer.ts
var AVS_LIST_BLEND_MODES = {
  0: "ignore",
  1: "replace",
  2: "average",
  3: "maximum",
  4: "additive",
  5: "destination-minus-source",
  6: "source-minus-destination",
  7: "every-other-line",
  8: "every-other-pixel",
  9: "xor",
  10: "adjustable",
  11: "multiply",
  12: "buffer-depth",
  13: "minimum"
};
var AVS_BLEND_TABLE = (() => {
  const values = new Uint8Array(256 * 256);
  for (let x = 0; x < 256; x++) {
    const row = x << 8;
    for (let y = 0; y < 256; y++) values[row | y] = Math.trunc(x / 255 * y);
  }
  return values;
})();
var AvsFramebuffer = class _AvsFramebuffer {
  constructor(width, height, pixels) {
    this.width = width;
    this.height = height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`Invalid AVS framebuffer size ${width}x${height}`);
    }
    const length = width * height;
    if (pixels && pixels.length !== length) {
      throw new RangeError(`AVS framebuffer has ${pixels.length} pixels, expected ${length}`);
    }
    this.pixels = pixels ?? new Uint32Array(length);
  }
  pixels;
  clear(color = 0) {
    this.pixels.fill(color & 16777215);
  }
  clone() {
    return new _AvsFramebuffer(this.width, this.height, this.pixels.slice());
  }
  copyFrom(source) {
    this.assertShape(source);
    this.pixels.set(source.pixels);
  }
  /** Blend source (the list/local image) over this destination/parent image. */
  blendFrom(source, mode, amount = 128, depth, invertDepth = false) {
    this.assertShape(source);
    if (mode === "ignore") return;
    if (mode === "replace") {
      this.copyFrom(source);
      return;
    }
    if (mode === "buffer-depth") {
      if (!depth) return;
      this.assertShape(depth);
    }
    const alpha = clampByte(amount);
    const destination = this.pixels;
    const input = source.pixels;
    const length = destination.length;
    if (mode === "every-other-line") {
      const width = this.width;
      for (let y = 0; y < this.height; y += 2) {
        const end = (y + 1) * width;
        for (let i = y * width; i < end; i++) destination[i] = input[i];
      }
      return;
    }
    if (mode === "every-other-pixel") {
      const width = this.width;
      for (let y = 0; y < this.height; y++) {
        const end = (y + 1) * width;
        for (let i = y * width + (y & 1); i < end; i += 2) destination[i] = input[i];
      }
      return;
    }
    if (mode === "buffer-depth") {
      const depthPixels = depth.pixels;
      for (let i = 0; i < length; i++) {
        const depthPixel = depthPixels[i];
        const low = depthPixel & 255;
        const middle = depthPixel >>> 8 & 255;
        const high = depthPixel >>> 16 & 255;
        let mix = low > middle ? low : middle;
        if (high > mix) mix = high;
        if (invertDepth) mix = 255 - mix;
        destination[i] = adjustablePixel(input[i], destination[i], mix);
      }
      return;
    }
    switch (mode) {
      case "average":
        for (let i = 0; i < length; i++) {
          destination[i] = (input[i] >>> 1 & 8355711) + (destination[i] >>> 1 & 8355711);
        }
        return;
      case "maximum":
        for (let i = 0; i < length; i++) destination[i] = maximumPixel(input[i], destination[i]);
        return;
      case "minimum":
        for (let i = 0; i < length; i++) destination[i] = minimumPixel(input[i], destination[i]);
        return;
      case "additive":
        for (let i = 0; i < length; i++) destination[i] = additivePixel(input[i], destination[i]);
        return;
      case "destination-minus-source":
        for (let i = 0; i < length; i++) destination[i] = subtractPixel(destination[i], input[i]);
        return;
      case "source-minus-destination":
        for (let i = 0; i < length; i++) destination[i] = subtractPixel(input[i], destination[i]);
        return;
      case "xor":
        for (let i = 0; i < length; i++) destination[i] = (input[i] ^ destination[i]) & 16777215;
        return;
      case "adjustable":
        for (let i = 0; i < length; i++) destination[i] = adjustablePixel(input[i], destination[i], alpha);
        return;
      case "multiply":
        for (let i = 0; i < length; i++) destination[i] = multiplyPixel(input[i], destination[i]);
        return;
    }
  }
  assertShape(other) {
    if (other.width !== this.width || other.height !== this.height) {
      throw new RangeError(`AVS framebuffer mismatch ${other.width}x${other.height} vs ${this.width}x${this.height}`);
    }
  }
};
var AvsBufferBank = class {
  buffers = new Array(8).fill(null);
  get(index, width, height, create = true) {
    if (!Number.isInteger(index) || index < 0 || index >= 8) return null;
    const current = this.buffers[index];
    if (current?.width === width && current.height === height) return current;
    if (!create) return null;
    const next = new AvsFramebuffer(width, height);
    this.buffers[index] = next;
    return next;
  }
  clear() {
    for (const buffer of this.buffers) buffer?.clear();
  }
  release() {
    this.buffers.fill(null);
  }
};
function decodeAvsListBlend(code) {
  return AVS_LIST_BLEND_MODES[code] ?? "ignore";
}
function blendPixel(source, destination, mode, amount = 128) {
  source &= 16777215;
  destination &= 16777215;
  switch (mode) {
    case "ignore":
      return destination;
    case "replace":
      return source;
    case "average":
      return (source >>> 1 & 8355711) + (destination >>> 1 & 8355711);
    case "maximum":
      return maximumPixel(source, destination);
    case "minimum":
      return minimumPixel(source, destination);
    case "additive":
      return additivePixel(source, destination);
    case "destination-minus-source":
      return subtractPixel(destination, source);
    case "source-minus-destination":
      return subtractPixel(source, destination);
    case "xor":
      return (source ^ destination) & 16777215;
    case "adjustable":
    case "buffer-depth": {
      const a = clampByte(amount);
      return adjustablePixel(source, destination, a);
    }
    case "multiply":
      return multiplyPixel(source, destination);
    // Selection for these modes is performed by blendFrom because it needs x/y.
    case "every-other-line":
    case "every-other-pixel":
      return source;
  }
}
function maximumPixel(a, b) {
  const a0 = a & 255;
  const b0 = b & 255;
  const a1 = a >>> 8 & 255;
  const b1 = b >>> 8 & 255;
  const a2 = a >>> 16 & 255;
  const b2 = b >>> 16 & 255;
  return (a0 > b0 ? a0 : b0) | (a1 > b1 ? a1 : b1) << 8 | (a2 > b2 ? a2 : b2) << 16;
}
function minimumPixel(a, b) {
  const a0 = a & 255;
  const b0 = b & 255;
  const a1 = a >>> 8 & 255;
  const b1 = b >>> 8 & 255;
  const a2 = a >>> 16 & 255;
  const b2 = b >>> 16 & 255;
  return (a0 < b0 ? a0 : b0) | (a1 < b1 ? a1 : b1) << 8 | (a2 < b2 ? a2 : b2) << 16;
}
function additivePixel(a, b) {
  let c0 = (a & 255) + (b & 255);
  let c1 = (a >>> 8 & 255) + (b >>> 8 & 255);
  let c2 = (a >>> 16 & 255) + (b >>> 16 & 255);
  if (c0 > 255) c0 = 255;
  if (c1 > 255) c1 = 255;
  if (c2 > 255) c2 = 255;
  return c0 | c1 << 8 | c2 << 16;
}
function subtractPixel(a, b) {
  let c0 = (a & 255) - (b & 255);
  let c1 = (a >>> 8 & 255) - (b >>> 8 & 255);
  let c2 = (a >>> 16 & 255) - (b >>> 16 & 255);
  if (c0 < 0) c0 = 0;
  if (c1 < 0) c1 = 0;
  if (c2 < 0) c2 = 0;
  return c0 | c1 << 8 | c2 << 16;
}
function adjustablePixel(source, destination, amount) {
  const inverse = 255 - amount;
  const c0 = table(source & 255, amount) + table(destination & 255, inverse);
  const c1 = table(source >>> 8 & 255, amount) + table(destination >>> 8 & 255, inverse);
  const c2 = table(source >>> 16 & 255, amount) + table(destination >>> 16 & 255, inverse);
  return c0 | c1 << 8 | c2 << 16;
}
function multiplyPixel(a, b) {
  return table(a & 255, b & 255) | table(a >>> 8 & 255, b >>> 8 & 255) << 8 | table(a >>> 16 & 255, b >>> 16 & 255) << 16;
}
function table(x, y) {
  return AVS_BLEND_TABLE[x << 8 | y];
}
function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.trunc(value);
}

// src/avs/executor.ts
var AvsEffectRegistry = class {
  /** Shared NS-EEL registers and gmegabuf for every effect in this graph. */
  eelGlobal;
  builtins = /* @__PURE__ */ new Map();
  apes = /* @__PURE__ */ new Map();
  constructor(eelGlobal = new AvsEelGlobalState()) {
    this.eelGlobal = eelGlobal;
  }
  registerBuiltin(effectId, handler) {
    this.builtins.set(effectId, handler);
    return this;
  }
  registerApe(apeId, handler) {
    this.apes.set(apeId.toLowerCase(), handler);
    return this;
  }
  handler(component) {
    return component.apeId ? this.apes.get(component.apeId.toLowerCase()) : this.builtins.get(component.effectId);
  }
};
var AvsExecutor = class {
  constructor(preset, registry) {
    this.preset = preset;
    this.registry = registry;
    this.eelGlobal = registry.eelGlobal;
  }
  buffers = new AvsBufferBank();
  stats = { rendered: 0, unsupported: 0, lists: 0 };
  /** Preset-global EEL registers/gmegabuf shared with registered codeable effects. */
  eelGlobal;
  retained = /* @__PURE__ */ new Map();
  alternates = /* @__PURE__ */ new Map();
  beatFrames = /* @__PURE__ */ new Map();
  listEel = /* @__PURE__ */ new Map();
  render(framebuffer, audio, preinit = false) {
    this.stats.rendered = 0;
    this.stats.unsupported = 0;
    this.stats.lists = 0;
    if (this.preset.clearEveryFrame && !preinit) framebuffer.clear();
    const alternate = this.surface(this.alternates, "$root", framebuffer);
    const line = { blendMode: 0, adjustableAlpha: 0, lineWidth: 1 };
    const result = this.runChildren(this.preset.components, framebuffer, alternate, audio, line, preinit, audio.beat);
    if (result.current !== framebuffer) framebuffer.copyFrom(result.current);
    return { ...this.stats };
  }
  reset() {
    this.retained.clear();
    this.alternates.clear();
    this.beatFrames.clear();
    this.listEel.clear();
    this.buffers.release();
  }
  runChildren(children, primary, alternate, audio, line, preinit, initialBeat) {
    let current = primary;
    let spare = alternate;
    let beat = initialBeat;
    for (const component of children) {
      if (component.list) {
        this.runList(component, current, audio, line, preinit, beat);
        continue;
      }
      const handler = this.registry.handler(component);
      if (!handler) {
        this.stats.unsupported++;
        continue;
      }
      const result = handler({
        component,
        input: current,
        output: spare,
        audio,
        buffers: this.buffers,
        line,
        preinit,
        beat
      });
      this.stats.rendered++;
      if (result?.swap) {
        const old = current;
        current = spare;
        spare = old;
      }
      if (result?.beat !== void 0 && !preinit) beat = result.beat;
    }
    return { current, alternate: spare, beat };
  }
  runList(component, parent, audio, parentLine, preinit, beat) {
    const settings = component.list;
    this.stats.lists++;
    let remaining = this.beatFrames.get(component.path) ?? 0;
    if ((beat || preinit) && settings.beatRender) {
      remaining = settings.beatRenderFrames;
      this.beatFrames.set(component.path, remaining);
    }
    const frameState = this.evaluateListCode(
      component,
      audio,
      parent.width,
      parent.height,
      preinit,
      beat,
      settings.enabled || remaining > 0,
      settings.clearEveryFrame,
      settings.inputBlendValue,
      settings.outputBlendValue,
      remaining
    );
    if (!frameState.enabled) {
      this.retained.delete(component.path);
      return;
    }
    if (settings.inputBlendMode === 1 && settings.outputBlendMode === 1) {
      const alternate2 = this.surface(this.alternates, `${component.path}:fast`, parent);
      const line2 = { blendMode: 0, adjustableAlpha: 0, lineWidth: 1 };
      const result2 = this.runChildren(component.children, parent, alternate2, audio, line2, preinit, frameState.beat);
      if (result2.current !== parent) parent.copyFrom(result2.current);
      this.consumeBeatFrame(component.path, frameState.remainingBeatFrames);
      return;
    }
    const local = this.surface(this.retained, component.path, parent);
    const alternate = this.surface(this.alternates, component.path, parent);
    if (frameState.clear) local.clear();
    if (!preinit) {
      const depth = settings.inputBlendMode === 12 ? this.buffers.get(settings.inputBuffer, parent.width, parent.height, false) : null;
      local.blendFrom(
        parent,
        decodeAvsListBlend(settings.inputBlendMode),
        frameState.alphaIn,
        depth ?? void 0,
        settings.inputInvert
      );
    }
    const line = { ...parentLine, blendMode: 0 };
    const result = this.runChildren(component.children, local, alternate, audio, line, preinit, frameState.beat);
    if (result.current !== local) local.copyFrom(result.current);
    if (!preinit) {
      const depth = settings.outputBlendMode === 12 ? this.buffers.get(settings.outputBuffer, parent.width, parent.height, false) : null;
      parent.blendFrom(
        local,
        decodeAvsListBlend(settings.outputBlendMode),
        frameState.alphaOut,
        depth ?? void 0,
        settings.outputInvert
      );
    }
    this.consumeBeatFrame(component.path, frameState.remainingBeatFrames);
  }
  evaluateListCode(component, audio, width, height, preinit, beat, enabled, clear, alphaIn, alphaOut, remainingBeatFrames) {
    const code = component.listCode;
    if (!code?.enabled) {
      return { enabled, clear, alphaIn, alphaOut, beat, remainingBeatFrames };
    }
    let state = this.listEel.get(component.path);
    if (!state) {
      state = {
        vm: new AvsEelVm({ global: this.eelGlobal, seed: hashPath(component.path) }),
        init: compileOrNull(code.init),
        frame: compileOrNull(code.frame),
        initialized: false
      };
      this.listEel.set(component.path, state);
    }
    const { vm } = state;
    vm.setHost({
      getosc: (band, span, channel) => avsAudioSample(audio, "osc", band, span, channel),
      getspec: (band, span, channel) => avsAudioSample(audio, "spec", band, span, channel)
    });
    vm.set("beat", beat && !preinit ? 1 : 0);
    vm.set("enabled", enabled ? 1 : 0);
    vm.set("w", width);
    vm.set("h", height);
    vm.set("clear", clear ? 1 : 0);
    vm.set("alphain", alphaIn / 255);
    vm.set("alphaout", alphaOut / 255);
    if (!state.initialized) {
      execute(state.init, vm);
      state.initialized = true;
    }
    execute(state.frame, vm);
    return {
      enabled: eelSwitch(vm.get("enabled")),
      clear: eelSwitch(vm.get("clear")),
      alphaIn: alphaByte(vm.get("alphain")),
      alphaOut: alphaByte(vm.get("alphaout")),
      beat: preinit ? beat : eelSwitch(vm.get("beat")),
      remainingBeatFrames
    };
  }
  consumeBeatFrame(path, remaining) {
    if (remaining > 0) this.beatFrames.set(path, remaining - 1);
  }
  surface(store, key, like) {
    const current = store.get(key);
    if (current?.width === like.width && current.height === like.height) return current;
    const created = new AvsFramebuffer(like.width, like.height);
    store.set(key, created);
    return created;
  }
};
function compileOrNull(source) {
  if (!source.trim()) return null;
  try {
    return compileAvsEel(source);
  } catch {
    return null;
  }
}
function execute(program, vm) {
  return program ? vm.execute(program) : 0;
}
function eelSwitch(value) {
  return value > 0.1 || value < -0.1;
}
function alphaByte(value) {
  const byte = Math.trunc(value * 255);
  return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}
function hashPath(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/core.ts
function registerAvsCoreEffects(registry = new AvsEffectRegistry()) {
  const stackDirection = /* @__PURE__ */ new Map();
  const clearFrames = /* @__PURE__ */ new Map();
  registry.registerBuiltin(18, (ctx) => {
    if (ctx.preinit) return;
    const direction = int(ctx, 0, 0);
    const index = clamp2(int(ctx, 4, 0), 0, 7);
    const blend2 = int(ctx, 8, 0);
    const amount = int(ctx, 12, 128);
    const buffer = ctx.buffers.get(index, ctx.input.width, ctx.input.height, direction !== 1);
    if (!buffer) return;
    let actual = direction;
    if (direction >= 2) {
      const phase = stackDirection.get(ctx.component.path) ?? 0;
      actual = direction & 1 ^ phase;
      stackDirection.set(ctx.component.path, phase ^ 1);
    }
    const source = actual === 0 ? ctx.input : buffer;
    const destination = actual === 0 ? buffer : ctx.input;
    blendStack(destination, source, blend2, amount);
  });
  registry.registerBuiltin(21, () => void 0);
  registry.registerBuiltin(25, (ctx) => {
    if (ctx.preinit || int(ctx, 0, 1) === 0) return;
    const seen = clearFrames.get(ctx.component.path) ?? 0;
    if (int(ctx, 16, 0) !== 0 && seen > 0) return;
    clearFrames.set(ctx.component.path, seen + 1);
    const color = int(ctx, 4, 0) & 16777215;
    const blend2 = int(ctx, 8, 0);
    const average = int(ctx, 12, 0) !== 0;
    if (blend2 === 2) {
      for (let i = 0; i < ctx.input.pixels.length; i++) {
        ctx.input.pixels[i] = blendLine(color, ctx.input.pixels[i], ctx.line.blendMode, ctx.line.adjustableAlpha);
      }
    } else if (blend2 !== 0) {
      for (let i = 0; i < ctx.input.pixels.length; i++) {
        ctx.input.pixels[i] = add(color, ctx.input.pixels[i]);
      }
    } else if (average) {
      for (let i = 0; i < ctx.input.pixels.length; i++) {
        ctx.input.pixels[i] = averagePixel(color, ctx.input.pixels[i]);
      }
    } else ctx.input.clear(color);
  });
  registry.registerBuiltin(37, (ctx) => {
    if (ctx.preinit || int(ctx, 0, 1) === 0) return;
    for (let i = 0; i < ctx.input.pixels.length; i++) {
      ctx.input.pixels[i] = ctx.input.pixels[i] ^ 16777215;
    }
  });
  registry.registerBuiltin(40, (ctx) => {
    if (ctx.preinit) return;
    const mode = uint(ctx, 0, 2147549184);
    if ((mode & 2147483648) === 0) return;
    ctx.line.blendMode = mode & 255;
    ctx.line.adjustableAlpha = mode >>> 8 & 255;
    ctx.line.lineWidth = mode >>> 16 & 255;
  });
  registry.registerBuiltin(44, (ctx) => {
    if (ctx.preinit) return;
    const direction = int(ctx, 0, 0);
    if (direction === 0) {
      for (let i = 0; i < ctx.input.pixels.length; i++) {
        const p = ctx.input.pixels[i];
        ctx.input.pixels[i] = rgb(p, (v) => Math.min(255, v + v));
      }
    } else if (direction === 1) {
      for (let i = 0; i < ctx.input.pixels.length; i++) {
        ctx.input.pixels[i] = ctx.input.pixels[i] >>> 1 & 8355711;
      }
    }
  });
  return registry;
}
function blendStack(destination, source, code, amount) {
  const modes = {
    0: "replace",
    1: "average",
    2: "additive",
    3: "every-other-pixel",
    4: "destination-minus-source",
    5: "every-other-line",
    6: "xor",
    7: "maximum",
    8: "minimum",
    9: "source-minus-destination",
    10: "multiply",
    11: "adjustable"
  };
  destination.blendFrom(source, modes[code] ?? "replace", amount);
}
function blendLine(source, destination, mode, amount) {
  switch (mode) {
    case 1:
      return add(source, destination);
    case 2:
      return channel2(source, destination, Math.max);
    case 3:
      return averagePixel(source, destination);
    case 4:
      return channel2(source, destination, (s, d) => Math.max(0, d - s));
    case 5:
      return channel2(source, destination, (s, d) => Math.max(0, s - d));
    case 6:
      return channel2(source, destination, table2);
    case 7:
      return channel2(source, destination, (s, d) => table2(s, amount) + table2(d, 255 - amount));
    case 8:
      return (source ^ destination) & 16777215;
    case 9:
      return channel2(source, destination, Math.min);
    default:
      return source & 16777215;
  }
}
function int(ctx, offset, fallback) {
  if (offset + 4 > ctx.component.payload.length) return fallback;
  return new DataView(
    ctx.component.payload.buffer,
    ctx.component.payload.byteOffset,
    ctx.component.payload.byteLength
  ).getInt32(offset, true);
}
function uint(ctx, offset, fallback) {
  if (offset + 4 > ctx.component.payload.length) return fallback >>> 0;
  return new DataView(
    ctx.component.payload.buffer,
    ctx.component.payload.byteOffset,
    ctx.component.payload.byteLength
  ).getUint32(offset, true);
}
function add(a, b) {
  return channel2(a, b, (x, y) => Math.min(255, x + y));
}
function averagePixel(a, b) {
  return (a >>> 1 & 8355711) + (b >>> 1 & 8355711);
}
function table2(a, b) {
  return Math.trunc(a / 255 * b);
}
function rgb(pixel, fn) {
  return fn(pixel & 255) | fn(pixel >>> 8 & 255) << 8 | fn(pixel >>> 16 & 255) << 16;
}
function channel2(a, b, fn) {
  return fn(a & 255, b & 255) & 255 | (fn(a >>> 8 & 255, b >>> 8 & 255) & 255) << 8 | (fn(a >>> 16 & 255, b >>> 16 & 255) & 255) << 16;
}
function clamp2(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

// src/avs/effects/add-borders.ts
var AVS_ADD_BORDERS_APE_ID = "Virtual Effect: Addborders";
function decodeAvsAddBorders(payload) {
  return {
    enabled: i322(payload, 0, 1) !== 0,
    color: i322(payload, 4, 0) & 16777215,
    size: Math.max(0, i322(payload, 8, 1))
  };
}
function registerAvsAddBorders(registry = new AvsEffectRegistry()) {
  registry.registerApe(AVS_ADD_BORDERS_APE_ID, (context2) => render(context2, decodeAvsAddBorders(context2.component.payload)));
  return registry;
}
function render(context2, config) {
  if (context2.preinit || !config.enabled || config.size === 0) return;
  const { width, height } = context2.input;
  const sizeX = Math.min(width, config.size);
  const sizeY = Math.min(height, config.size);
  for (let y = 0; y < height; y++) {
    const edgeY = y < sizeY || y >= height - sizeY;
    for (let x = 0; x < width; x++) {
      if (edgeY || x < sizeX || x >= width - sizeX) {
        context2.input.pixels[x + y * width] = config.color;
      }
    }
  }
}
function i322(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}

// src/avs/effects/classic.ts
function registerAvsClassicEffects(registry = new AvsEffectRegistry(), options = {}) {
  const randomInt = options.randomInt ?? ((maximum) => Math.floor(Math.random() * maximum));
  const blitters = /* @__PURE__ */ new Map();
  const scatterTables = /* @__PURE__ */ new Map();
  const mirrors = /* @__PURE__ */ new Map();
  const mirrorShared = {
    lastMode: 0,
    divisor: [0, 0, 0, 0],
    increment: [0, 0, 0, 0]
  };
  registry.registerBuiltin(3, (ctx) => {
    if (ctx.preinit) return;
    const fade = int2(ctx, 0, 16);
    if (fade === 0) return;
    const target = int2(ctx, 4, 0);
    const tr = target & 255;
    const tg = target >>> 8 & 255;
    const tb = target >>> 16 & 255;
    for (let i = 0; i < ctx.input.pixels.length; i++) {
      const pixel = ctx.input.pixels[i];
      ctx.input.pixels[i] = approach(pixel & 255, tr, fade) | approach(pixel >>> 8 & 255, tg, fade) << 8 | approach(pixel >>> 16 & 255, tb, fade) << 16;
    }
  });
  registry.registerBuiltin(4, (ctx) => {
    if (ctx.preinit) return;
    const scale = int2(ctx, 0, 30);
    const beatScale = int2(ctx, 4, 30);
    const blend2 = int2(ctx, 8, 0) !== 0;
    const changeOnBeat = int2(ctx, 12, 0) !== 0;
    const subpixel = int2(ctx, 16, 0) !== 0;
    let state = blitters.get(ctx.component.path);
    if (!state || state.scale !== scale) {
      state = { scale, position: scale };
      blitters.set(ctx.component.path, state);
    }
    if (ctx.beat && changeOnBeat) state.position = beatScale;
    let value;
    if (scale < beatScale) {
      value = Math.max(state.position, scale);
      state.position -= 3;
    } else {
      value = Math.min(state.position, scale);
      state.position += 3;
    }
    value = Math.max(0, value);
    if (value < 32) {
      blitIn(ctx, value, blend2, subpixel);
      return { swap: true };
    }
    if (value > 32) blitOut(ctx, value, blend2);
  });
  registry.registerBuiltin(6, (ctx) => {
    const mode = int2(ctx, 0, 1);
    if (ctx.preinit || mode === 0) return;
    blur(ctx, mode, int2(ctx, 4, 0) !== 0);
    return { swap: true };
  });
  registry.registerBuiltin(16, (ctx) => {
    if (int2(ctx, 0, 1) === 0 || ctx.preinit) return;
    const { width, height } = ctx.input;
    if (height <= 8) {
      ctx.output.copyFrom(ctx.input);
      return { swap: true };
    }
    let table6 = scatterTables.get(width);
    if (!table6) {
      table6 = new Int32Array(512);
      for (let i = 0; i < table6.length; i++) {
        let dx = i % 8 - 4;
        let dy = Math.floor(i / 8) % 8 - 4;
        if (dx < 0) dx++;
        if (dy < 0) dy++;
        table6[i] = width * dy + dx;
      }
      scatterTables.set(width, table6);
    }
    const edge = width * 4;
    ctx.output.pixels.set(ctx.input.pixels.subarray(0, edge), 0);
    for (let i = edge; i < width * (height - 4); i++) {
      const offset = table6[normalizeRandom(randomInt(512), 512)];
      ctx.output.pixels[i] = ctx.input.pixels[i + offset];
    }
    ctx.output.pixels.set(ctx.input.pixels.subarray(width * (height - 4)), width * (height - 4));
    return { swap: true };
  });
  registry.registerBuiltin(22, (ctx) => {
    if (ctx.preinit || int2(ctx, 0, 1) === 0) return;
    const additive = int2(ctx, 4, 0) !== 0;
    const average = int2(ctx, 8, 1) !== 0;
    const red = multiplier(int2(ctx, 12, 0));
    const green = multiplier(int2(ctx, 16, 0));
    const blue = multiplier(int2(ctx, 20, 0));
    const reference = int2(ctx, 28, 0);
    const exclude = int2(ctx, 32, 0) !== 0;
    const distance = int2(ctx, 36, 16);
    for (let i = 0; i < ctx.input.pixels.length; i++) {
      const pixel = ctx.input.pixels[i];
      if (exclude && inRange(pixel, reference, distance)) continue;
      const adjusted = adjustBrightness(pixel, red, green, blue);
      ctx.input.pixels[i] = additive ? add2(pixel, adjusted) : average ? averagePixel2(pixel, adjusted) : adjusted;
    }
  });
  registry.registerBuiltin(26, (ctx) => {
    if (ctx.preinit || int2(ctx, 0, 1) === 0) return;
    const configuredMode = int2(ctx, 4, 1) & 15;
    const onBeat = int2(ctx, 8, 0) !== 0;
    const smooth = int2(ctx, 12, 0) !== 0;
    const slower = Math.max(1, int2(ctx, 16, 4));
    let state = mirrors.get(ctx.component.path);
    if (!state) {
      state = { beatMode: 0, frameCount: 0 };
      mirrors.set(ctx.component.path, state);
    }
    if (onBeat && ctx.beat) state.beatMode = normalizeRandom(randomInt(16), 16) & configuredMode;
    const mode = onBeat ? state.beatMode : configuredMode;
    updateMirrorTarget(mirrorShared, mode);
    renderMirror(ctx, mode, smooth, mirrorShared.divisor);
    state.frameCount++;
    if (smooth && state.frameCount % slower === 0) stepMirror(mirrorShared);
  });
  return registry;
}
function blur(ctx, mode, roundUp) {
  const { width, height } = ctx.input;
  const source = ctx.input.pixels;
  const destination = ctx.output.pixels;
  if (width < 2 || height < 2) {
    destination.set(source);
    return;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const center = source[y * width + x];
      const left = x > 0 ? source[y * width + x - 1] : 0;
      const right = x + 1 < width ? source[y * width + x + 1] : 0;
      const up = y > 0 ? source[(y - 1) * width + x] : 0;
      const down = y + 1 < height ? source[(y + 1) * width + x] : 0;
      destination[y * width + x] = blurPixel(
        mode,
        center,
        left,
        right,
        up,
        down,
        x === 0,
        x === width - 1,
        y === 0,
        y === height - 1,
        roundUp
      );
    }
  }
}
function blurPixel(mode, center, left, right, up, down, atLeft, atRight, atTop, atBottom, roundUp) {
  if (mode === 3) {
    const horizontal = atLeft ? [[right, 1]] : atRight ? [[left, 1]] : [[left, 2], [right, 2]];
    const vertical = atTop ? [[down, 1]] : atBottom ? [[up, 1]] : [[up, 2], [down, 2]];
    const rounding = atLeft || atRight ? atTop || atBottom ? 1 : 2 : atTop || atBottom ? 2 : 3;
    return shiftedSum([...horizontal, ...vertical], roundUp ? rounding : 0);
  }
  if (mode === 2) {
    const corner2 = (atLeft || atRight) && (atTop || atBottom);
    const edge2 = atLeft || atRight || atTop || atBottom;
    const terms2 = [[center, 1]];
    if (corner2) {
      terms2.push([center, 2], [atLeft ? right : left, 3], [atTop ? down : up, 3]);
    } else if (edge2) {
      terms2.push([center, 3]);
      if (!atLeft && !atRight) terms2.push([left, 3], [right, 3], [atTop ? down : up, 3]);
      else terms2.push([atLeft ? right : left, 3], [up, 3], [down, 3]);
    } else terms2.push([center, 2], [left, 4], [right, 4], [up, 4], [down, 4]);
    return shiftedSum(terms2, roundUp ? corner2 ? 3 : edge2 ? 4 : 5 : 0);
  }
  const corner = (atLeft || atRight) && (atTop || atBottom);
  const edge = atLeft || atRight || atTop || atBottom;
  let terms;
  if (corner) terms = [[center, 1], [atLeft ? right : left, 2], [atTop ? down : up, 2]];
  else if (edge && (atTop || atBottom)) terms = [[center, 2], [left, 2], [right, 2], [atTop ? down : up, 2]];
  else if (edge) terms = [[center, 2], [atLeft ? right : left, 2], [up, 2], [down, 2]];
  else terms = [[center, 1], [left, 3], [right, 3], [up, 3], [down, 3]];
  return shiftedSum(terms, roundUp ? corner ? 2 : edge ? 3 : 4 : 0);
}
function shiftedSum(terms, rounding) {
  let r = rounding, g = rounding, b = rounding;
  for (const [pixel, shift] of terms) {
    r += (pixel & 255) >>> shift;
    g += (pixel >>> 8 & 255) >>> shift;
    b += (pixel >>> 16 & 255) >>> shift;
  }
  return r & 255 | (g & 255) << 8 | (b & 255) << 16;
}
function blitIn(ctx, value, blend2, subpixel) {
  const { width, height } = ctx.input;
  const source = ctx.input.pixels;
  const destination = ctx.output.pixels;
  const step = Math.trunc((value + 32) * 65536 / 64);
  const startX = Math.trunc((width * 65536 - step * width) / 2);
  let sourceY = Math.trunc((height * 65536 - step * height) / 2);
  for (let y = 0; y < height; y++) {
    let sourceX = startX;
    for (let x = 0; x < width; x++) {
      const sx = sourceX >> 16;
      const sy = sourceY >> 16;
      const sampled = subpixel ? bilinear(source, width, height, sx, sy, sourceX >> 8 & 255, sourceY >> 8 & 255) : source[sy * width + sx];
      destination[y * width + x] = blend2 ? averagePixel2(source[y * width + x], sampled) : sampled;
      sourceX += step;
      if (!subpixel && blend2 && (x & 3) === 3) sourceX += step;
    }
    sourceY += step;
  }
}
function blitOut(ctx, value, blend2) {
  const { width, height } = ctx.input;
  const source = ctx.input.pixels;
  const scratch = ctx.output.pixels;
  const step = value + 128 - 32 << 9;
  const regionWidth = Math.trunc(width * 65536 / step) & ~3;
  const regionHeight = Math.trunc(height * 65536 / step);
  if (regionWidth >= width || regionHeight >= height || regionWidth <= 0 || regionHeight <= 0) return;
  const startX = Math.trunc((width - regionWidth) / 2);
  const startY = Math.trunc((height - regionHeight) / 2);
  let sourceY = 32768;
  for (let y = 0; y < regionHeight; y++) {
    let sourceX = 32768;
    const sy = sourceY >> 16;
    for (let x = 0; x < regionWidth; x++) {
      const sampled = source[sy * width + (sourceX >> 16)];
      const index = (startY + y) * width + startX + x;
      scratch[index] = blend2 ? averagePixel2(source[index], sampled) : sampled;
      sourceX += step;
      if (blend2 && (x & 3) === 3) sourceX += step;
    }
    sourceY += step;
  }
  for (let y = 0; y < regionHeight; y++) {
    const offset = (startY + y) * width + startX;
    source.set(scratch.subarray(offset, offset + regionWidth), offset);
  }
}
function bilinear(pixels, width, height, x, y, xPart, yPart) {
  const x1 = Math.min(width - 1, x + 1);
  const y1 = Math.min(height - 1, y + 1);
  const a = pixels[y * width + x];
  const b = pixels[y * width + x1];
  const c = pixels[y1 * width + x];
  const d = pixels[y1 * width + x1];
  return channels4(a, b, c, d, (av, bv, cv, dv) => {
    const top = av * (255 - xPart) + bv * xPart >>> 8;
    const bottom = cv * (255 - xPart) + dv * xPart >>> 8;
    return top * (255 - yPart) + bottom * yPart >>> 8;
  });
}
function renderMirror(ctx, mode, smooth, divisor) {
  const pixels = ctx.input.pixels;
  const { width, height } = ctx.input;
  const halfWidth = Math.trunc(width / 2);
  const halfHeight = Math.trunc(height / 2);
  if ((mode & 4) !== 0 || smooth && divisor[2] !== 0) {
    const amount = divisor[2];
    for (let y = 0; y < height; y++) for (let x = 0; x < halfWidth; x++) {
      const source = y * width + x;
      const target = y * width + width - 1 - x;
      pixels[target] = smooth && amount ? adaptive(pixels[target], pixels[source], amount) : pixels[source];
    }
  }
  if ((mode & 8) !== 0 || smooth && divisor[3] !== 0) {
    const amount = divisor[3];
    for (let y = 0; y < height; y++) for (let x = 0; x < halfWidth; x++) {
      const target = y * width + x;
      const source = y * width + width - 1 - x;
      pixels[target] = smooth && amount ? adaptive(pixels[target], pixels[source], amount) : pixels[source];
    }
  }
  if ((mode & 1) !== 0 || smooth && divisor[0] !== 0) {
    const amount = divisor[0];
    for (let y = 0; y < halfHeight; y++) for (let x = 0; x < width; x++) {
      const source = y * width + x;
      const target = (height - 1 - y) * width + x;
      pixels[target] = smooth && amount ? adaptive(pixels[target], pixels[source], amount) : pixels[source];
    }
  }
  if ((mode & 2) !== 0 || smooth && divisor[1] !== 0) {
    const amount = divisor[1];
    for (let y = 0; y < halfHeight; y++) for (let x = 0; x < width; x++) {
      const target = y * width + x;
      const source = (height - 1 - y) * width + x;
      pixels[target] = smooth && amount ? adaptive(pixels[target], pixels[source], amount) : pixels[source];
    }
  }
}
function updateMirrorTarget(state, mode) {
  const difference = mode ^ state.lastMode;
  for (let i = 0; i < 4; i++) {
    const bit = 1 << i;
    if ((difference & bit) === 0) continue;
    const wasOn = (state.lastMode & bit) !== 0;
    state.increment[i] = wasOn ? -1 : 1;
    if (state.divisor[i] === 0) state.divisor[i] = wasOn ? 16 : 1;
  }
  state.lastMode = mode;
}
function stepMirror(state) {
  for (let i = 0; i < 4; i++) {
    if (state.divisor[i] !== 0) state.divisor[i] = (state.divisor[i] + state.increment[i] + 16) % 16;
  }
}
function adaptive(current, target, divisor) {
  return channels2(current, target, (a, b) => (a >>> 4) * (16 - divisor) + (b >>> 4) * divisor & 255);
}
function multiplier(setting) {
  return Math.trunc((1 + (setting < 0 ? 1 : 16) * (setting / 4096)) * 65536);
}
function adjustBrightness(pixel, red, green, blue) {
  const high = clampByte2(Math.trunc((pixel >>> 16 & 255) * red / 65536));
  const middle = clampByte2(Math.trunc((pixel >>> 8 & 255) * green / 65536));
  const low = clampByte2(Math.trunc((pixel & 255) * blue / 65536));
  return low | middle << 8 | high << 16;
}
function inRange(pixel, reference, distance) {
  return Math.abs((pixel & 255) - (reference & 255)) <= distance && Math.abs((pixel >>> 8 & 255) - (reference >>> 8 & 255)) <= distance && Math.abs((pixel >>> 16 & 255) - (reference >>> 16 & 255)) <= distance;
}
function approach(value, target, fade) {
  if (value <= target - fade) return value + fade & 255;
  if (value >= target + fade) return value - fade & 255;
  return target;
}
function averagePixel2(a, b) {
  return (a >>> 1 & 8355711) + (b >>> 1 & 8355711);
}
function add2(a, b) {
  return channels2(a, b, (x, y) => Math.min(255, x + y));
}
function channels2(a, b, fn) {
  return fn(a & 255, b & 255) & 255 | (fn(a >>> 8 & 255, b >>> 8 & 255) & 255) << 8 | (fn(a >>> 16 & 255, b >>> 16 & 255) & 255) << 16;
}
function channels4(a, b, c, d, fn) {
  return fn(a & 255, b & 255, c & 255, d & 255) & 255 | (fn(a >>> 8 & 255, b >>> 8 & 255, c >>> 8 & 255, d >>> 8 & 255) & 255) << 8 | (fn(a >>> 16 & 255, b >>> 16 & 255, c >>> 16 & 255, d >>> 16 & 255) & 255) << 16;
}
function int2(ctx, offset, fallback) {
  if (offset + 4 > ctx.component.payload.length) return fallback;
  return new DataView(
    ctx.component.payload.buffer,
    ctx.component.payload.byteOffset,
    ctx.component.payload.byteLength
  ).getInt32(offset, true);
}
function normalizeRandom(value, maximum) {
  if (!Number.isFinite(value)) return 0;
  const integer2 = Math.trunc(value);
  return (integer2 % maximum + maximum) % maximum;
}
function clampByte2(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

// src/avs/effects/color-map.ts
var AVS_COLOR_MAP_APE_ID = "Color Map";
var FIXED_CONFIG_BYTES = 496;
var MAP_HEADER_BYTES = 60;
var MAP_COUNT = 8;
var POINT_BYTES = 12;
function decodeAvsColorMap(payload) {
  if (payload.length < FIXED_CONFIG_BYTES) return defaultConfig();
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const maps = [];
  let pointOffset = FIXED_CONFIG_BYTES;
  for (let index = 0; index < MAP_COUNT; index++) {
    const header = 16 + index * MAP_HEADER_BYTES;
    const count = view.getInt32(header + 4, true);
    const byteCount = count > 0 && count <= 65536 ? count * POINT_BYTES : -1;
    let points;
    if (byteCount < 0 || pointOffset + byteCount > payload.length) {
      points = defaultPoints();
    } else {
      points = [];
      for (let point = 0; point < count; point++, pointOffset += POINT_BYTES) {
        points.push({
          position: view.getUint32(pointOffset, true),
          color: view.getUint32(pointOffset + 4, true) & 16777215,
          id: view.getUint32(pointOffset + 8, true)
        });
      }
    }
    maps.push({
      index,
      enabled: count > 0 ? view.getInt32(header, true) !== 0 : index === 0,
      id: view.getUint32(header + 8, true),
      filename: nulText2(payload.subarray(header + 12, header + MAP_HEADER_BYTES)),
      points
    });
  }
  return {
    key: view.getInt32(0, true),
    blendMode: view.getInt32(4, true),
    mapCycleMode: view.getInt32(8, true),
    adjustBlend: payload[12],
    dontSkipFastBeats: payload[14] !== 0,
    cycleSpeed: normalizeCycleSpeed(payload[15]),
    maps
  };
}
function buildAvsColorMapTable(points) {
  const table6 = new Uint32Array(256);
  const sorted = points.length > 0 ? [...points].sort((a, b) => a.position - b.position || a.color - b.color) : defaultPoints();
  const first = sorted[0];
  const firstPosition = clamp3(first.position, 0, 255);
  table6.fill(first.color & 16777215, 0, firstPosition);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const left = sorted[i];
    const right = sorted[i + 1];
    const leftPosition = clamp3(left.position, 0, 255);
    const rightPosition = clamp3(right.position, 0, 255);
    const distance = rightPosition - leftPosition;
    if (distance <= 0) continue;
    const increment = Math.trunc(65536 / distance);
    let fraction = 0;
    for (let position = leftPosition; position <= rightPosition; position++) {
      const weight = Math.min(256, fraction >>> 8);
      table6[position] = mix256(left.color, right.color, weight);
      fraction += increment;
    }
  }
  const last = sorted[sorted.length - 1];
  table6.fill(last.color & 16777215, clamp3(last.position, 0, 255), 256);
  return table6;
}
function registerAvsColorMap(registry = new AvsEffectRegistry()) {
  const states = /* @__PURE__ */ new Map();
  registry.registerApe(AVS_COLOR_MAP_APE_ID, (context2) => {
    if (context2.preinit) return;
    const config = decodeAvsColorMap(context2.component.payload);
    let state = states.get(context2.component.path);
    if (!state) {
      const initial = firstEnabled(config.maps);
      state = {
        tables: config.maps.map((map) => buildAvsColorMapTable(map.points)),
        previous: initial,
        target: initial,
        // load_config copies the variable tail into the object before fixing
        // pointers, so the first point's editor id also becomes this field.
        progress: readI32(context2.component.payload, FIXED_CONFIG_BYTES + 8, 0),
        random: hashPath2(context2.component.path)
      };
      states.set(context2.component.path, state);
    }
    const table6 = selectTable(config, state, context2.beat);
    transform(context2, config, table6);
  });
  return registry;
}
function selectTable(config, state, beat) {
  if (config.mapCycleMode === 0) {
    state.progress = 0;
    return state.tables[state.previous];
  }
  state.target = modulo2(state.target, MAP_COUNT);
  state.progress = Math.min(256, state.progress + config.cycleSpeed);
  if (beat && (!config.dontSkipFastBeats || state.progress === 256)) {
    const enabled = config.maps.filter((map) => map.enabled).map((map) => map.index);
    if (enabled.length > 0) {
      state.previous = state.target;
      if (config.mapCycleMode === 1) {
        do {
          state.random = xorshift32(state.random);
          state.target = state.random & 7;
        } while (!config.maps[state.target].enabled);
      } else {
        let candidate = state.target;
        do
          candidate = candidate + 1 & 7;
        while (!config.maps[candidate].enabled);
        state.target = candidate;
      }
    }
    state.progress = 0;
  }
  if (state.progress === 0 || state.previous === state.target) return state.tables[state.previous];
  if (state.progress === 256) {
    state.previous = state.target;
    return state.tables[state.target];
  }
  const table6 = new Uint32Array(256);
  const previous = state.tables[state.previous];
  const target = state.tables[state.target];
  for (let i = 0; i < 256; i++) table6[i] = mix256(previous[i], target[i], state.progress);
  return table6;
}
function transform(context2, config, table6) {
  for (let i = 0; i < context2.input.pixels.length; i++) {
    const destination = context2.input.pixels[i] & 16777215;
    const key = colorKey(destination, config.key);
    if (key === null) continue;
    const source = table6[key];
    context2.input.pixels[i] = blend(source, destination, config.blendMode, config.adjustBlend);
  }
}
function colorKey(pixel, key) {
  const blue = pixel & 255;
  const green = pixel >>> 8 & 255;
  const red = pixel >>> 16 & 255;
  switch (key) {
    case 0:
      return red;
    case 1:
      return green;
    case 2:
      return blue;
    case 3:
      return Math.min(255, red + green + blue >>> 1);
    case 4:
      return Math.max(red, green, blue);
    case 5:
      return Math.trunc((red + green + blue) / 3);
    default:
      return null;
  }
}
function blend(source, destination, mode, amount) {
  switch (mode) {
    case 0:
      return source;
    case 1:
      return channels22(source, destination, (s, d) => Math.min(255, s + d));
    case 2:
      return channels22(source, destination, Math.max);
    case 3:
      return channels22(source, destination, Math.min);
    case 4:
      return channels22(source, destination, (s, d) => s + d >>> 1);
    case 5:
      return channels22(source, destination, (s, d) => Math.max(0, d - s));
    case 6:
      return channels22(source, destination, (s, d) => Math.max(0, s - d));
    case 7:
      return channels22(source, destination, (s, d) => s * d >>> 8);
    case 8:
      return (source ^ destination) & 16777215;
    case 9:
      return channels22(source, destination, (s, d) => Math.min(255, (s * amount >>> 8) + (d * (256 - amount) >>> 8)));
    default:
      return destination;
  }
}
function mix256(left, right, rightWeight) {
  return channels22(right, left, (r, l) => r * rightWeight + l * (256 - rightWeight) >>> 8);
}
function channels22(a, b, fn) {
  return fn(a & 255, b & 255) & 255 | (fn(a >>> 8 & 255, b >>> 8 & 255) & 255) << 8 | (fn(a >>> 16 & 255, b >>> 16 & 255) & 255) << 16;
}
function defaultConfig() {
  return {
    key: 0,
    blendMode: 0,
    mapCycleMode: 0,
    adjustBlend: 0,
    dontSkipFastBeats: false,
    cycleSpeed: 8,
    maps: Array.from({ length: MAP_COUNT }, (_, index) => ({
      index,
      enabled: index === 0,
      id: 0,
      filename: "",
      points: defaultPoints()
    }))
  };
}
function defaultPoints() {
  return [{ position: 0, color: 0, id: 0 }, { position: 255, color: 16777215, id: 1 }];
}
function normalizeCycleSpeed(raw) {
  const signed3 = raw < 128 ? raw : raw - 256;
  if (signed3 === 0) return 8;
  return clamp3(signed3, 1, 64);
}
function readI32(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function firstEnabled(maps) {
  return maps.find((map) => map.enabled)?.index ?? 0;
}
function nulText2(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder("windows-1252").decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp3(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function modulo2(value, divisor) {
  const result = value % divisor;
  return result < 0 ? result + divisor : result;
}
function hashPath2(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}
function xorshift32(value) {
  let state = value || 1831565813;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

// src/avs/effects/convolution.ts
var AVS_CONVOLUTION_APE_ID = "Holden03: Convolution Filter";
var AVS_CONVOLUTION_KERNEL_SIZE = 7;
var KERNEL_CELLS = AVS_CONVOLUTION_KERNEL_SIZE ** 2;
var CORE_BYTES = (4 + KERNEL_CELLS + 2) * 4;
function decodeAvsConvolutionConfig(payload) {
  const defaults = new Int32Array(4 + KERNEL_CELLS + 2);
  defaults[0] = 1;
  defaults[4 + 24] = 1;
  defaults[4 + KERNEL_CELLS + 1] = 1;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const words = Math.min(defaults.length, Math.floor(payload.length / 4));
  for (let index = 0; index < words; index++) defaults[index] = view.getInt32(index * 4, true);
  const scale = defaults[4 + KERNEL_CELLS + 1];
  return {
    // The native loader tests these four values against exactly one.
    enabled: defaults[0] === 1,
    wrap: defaults[1] === 1,
    absolute: defaults[2] === 1,
    twoPass: defaults[3] === 1,
    kernel: Array.from(defaults.subarray(4, 4 + KERNEL_CELLS)),
    bias: defaults[4 + KERNEL_CELLS],
    scale: scale === 0 ? 1 : scale,
    legacyFilename: payload.length > CORE_BYTES ? new TextDecoder("windows-1252").decode(payload.subarray(CORE_BYTES)) : ""
  };
}
function registerAvsConvolutionFilter(registry = new AvsEffectRegistry()) {
  const states = /* @__PURE__ */ new Map();
  registry.registerApe(AVS_CONVOLUTION_APE_ID, (context2) => {
    let state = states.get(context2.component.path);
    if (!state) {
      state = prepareConvolution(decodeAvsConvolutionConfig(context2.component.payload));
      states.set(context2.component.path, state);
    }
    if (!state.config.enabled || context2.input.width === 0 || context2.input.height === 0) return;
    return renderConvolution(context2, state);
  });
  return registry;
}
function prepareConvolution(config) {
  let firstNonzero = -1;
  const sign = config.scale < 0 ? -1 : 1;
  const taps = [];
  const rotatedTaps = [];
  for (let index = 0; index < KERNEL_CELLS; index++) {
    const raw = config.kernel[index];
    if (raw === 0) continue;
    if (firstNonzero < 0) firstNonzero = index;
    const coefficient = Math.imul(raw, sign);
    const dx = index % 7 - 3;
    const dy = Math.floor(index / 7) - 3;
    taps.push({ dx, dy, coefficient });
    rotatedTaps.push({ dx: -dy, dy: dx, coefficient });
  }
  if (firstNonzero < 0 && config.bias !== 0) firstNonzero = KERNEL_CELLS;
  const sums = coefficientSums(config.kernel, config.bias);
  const bias = Math.imul(config.bias, sign);
  const minimumX = taps.reduce((minimum, tap) => Math.min(minimum, tap.dx), 0);
  const maximumX = taps.reduce((maximum, tap) => Math.max(maximum, tap.dx), 0);
  const divisor = Math.abs(config.scale) || 1;
  const positiveTaps = taps.filter((tap) => tap.coefficient > 0);
  const negativeTaps = taps.filter((tap) => tap.coefficient < 0);
  return {
    config,
    taps,
    rotatedTaps,
    bias,
    biasProduct: Math.imul(Math.abs(bias) & 65535, 256) & 65535,
    divisor,
    hasNegative: bias < 0 || taps.some((tap) => tap.coefficient < 0),
    saturatePositive: sums.saturatePositive,
    saturateNegative: sums.saturateNegative,
    swap: firstNonzero >= 0 && firstNonzero < 24,
    leftEdge: -minimumX,
    rightEdge: maximumX,
    scaleShift: divisor <= 32768 && (divisor & divisor - 1) === 0 ? Math.log2(divisor) : -1,
    positiveDx: Int8Array.from(positiveTaps, (tap) => tap.dx),
    positiveDy: Int8Array.from(positiveTaps, (tap) => tap.dy),
    positiveCoefficients: Uint16Array.from(positiveTaps, (tap) => tap.coefficient),
    negativeDx: Int8Array.from(negativeTaps, (tap) => tap.dx),
    negativeDy: Int8Array.from(negativeTaps, (tap) => tap.dy),
    negativeCoefficients: Uint16Array.from(negativeTaps, (tap) => -tap.coefficient)
  };
}
function renderConvolution(context2, state) {
  const { config } = state;
  const swap = state.swap;
  const source = context2.input.pixels;
  const target = swap ? context2.output.pixels : source;
  const width = context2.input.width;
  const height = context2.input.height;
  if (swap && !config.twoPass && state.bias === 0 && !state.saturatePositive && !state.saturateNegative && !config.absolute && !config.wrap && state.scaleShift >= 0) {
    renderFastConvolution(source, target, width, height, state);
    return { swap: true };
  }
  const first = new Uint16Array(4);
  const second = new Uint16Array(4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      convolvePass(source, width, height, x, y, state.taps, state, first);
      if (config.twoPass) {
        convolvePass(source, width, height, x, y, state.rotatedTaps, state, second);
        for (let channel = 0; channel < 4; channel++) {
          first[channel] = Math.min(65535, first[channel] + second[channel]);
        }
      }
      target[y * width + x] = (packByte(scaleWord(first[0], state.divisor)) | packByte(scaleWord(first[1], state.divisor)) << 8 | packByte(scaleWord(first[2], state.divisor)) << 16 | packByte(scaleWord(first[3], state.divisor)) << 24) >>> 0;
    }
  }
  return swap ? { swap: true } : void 0;
}
function renderFastConvolution(source, target, width, height, state) {
  const dx = state.positiveDx;
  const dy = state.positiveDy;
  const coefficients = state.positiveCoefficients;
  const tapCount = coefficients.length;
  const negativeDx = state.negativeDx;
  const negativeDy = state.negativeDy;
  const negativeCoefficients = state.negativeCoefficients;
  const negativeTapCount = negativeCoefficients.length;
  if (negativeTapCount === 0 && tapCount === 1 && coefficients[0] === 1 && state.scaleShift === 0) {
    const shiftX = dx[0];
    const shiftY = dy[0];
    for (let y = 0; y < height; y++) {
      const sourceRow = clamp4(y + shiftY, 0, height - 1) * width;
      const targetRow = y * width;
      if (shiftX === 0) {
        target.set(source.subarray(sourceRow, sourceRow + width), targetRow);
      } else {
        for (let x = 0; x < width; x++) {
          target[targetRow + x] = source[sourceRow + clamp4(x + shiftX, 0, width - 1)];
        }
      }
    }
    return;
  }
  const rowBases = new Int32Array(tapCount);
  const negativeRowBases = new Int32Array(negativeTapCount);
  const interiorStart = Math.min(width, state.leftEdge);
  const interiorEnd = Math.max(interiorStart, width - state.rightEdge);
  const shift = state.scaleShift;
  for (let y = 0; y < height; y++) {
    for (let tap = 0; tap < tapCount; tap++) {
      rowBases[tap] = clamp4(y + dy[tap], 0, height - 1) * width;
    }
    for (let tap = 0; tap < negativeTapCount; tap++) {
      negativeRowBases[tap] = clamp4(y + negativeDy[tap], 0, height - 1) * width;
    }
    const targetRow = y * width;
    for (let x = 0; x < width; x++) {
      let redBlue = 0;
      let green = 0;
      let alpha = 0;
      let negativeRedBlue = 0;
      let negativeGreen = 0;
      let negativeAlpha = 0;
      const interior = x >= interiorStart && x < interiorEnd;
      for (let tap = 0; tap < tapCount; tap++) {
        const sourceX = interior ? x + dx[tap] : clamp4(x + dx[tap], 0, width - 1);
        const pixel = source[rowBases[tap] + sourceX];
        const coefficient = coefficients[tap];
        redBlue += (pixel & 16711935) * coefficient;
        green += (pixel >>> 8 & 255) * coefficient;
        alpha += (pixel >>> 24) * coefficient;
      }
      for (let tap = 0; tap < negativeTapCount; tap++) {
        const sourceX = interior ? x + negativeDx[tap] : clamp4(x + negativeDx[tap], 0, width - 1);
        const pixel = source[negativeRowBases[tap] + sourceX];
        const coefficient = negativeCoefficients[tap];
        negativeRedBlue += (pixel & 16711935) * coefficient;
        negativeGreen += (pixel >>> 8 & 255) * coefficient;
        negativeAlpha += (pixel >>> 24) * coefficient;
      }
      let blue = redBlue & 65535;
      let red = Math.floor(redBlue / 65536);
      if (negativeTapCount !== 0) {
        const negativeBlue = negativeRedBlue & 65535;
        const negativeRed = Math.floor(negativeRedBlue / 65536);
        blue = blue > negativeBlue ? blue - negativeBlue : 0;
        green = green > negativeGreen ? green - negativeGreen : 0;
        red = red > negativeRed ? red - negativeRed : 0;
        alpha = alpha > negativeAlpha ? alpha - negativeAlpha : 0;
      }
      blue >>>= shift;
      green >>>= shift;
      red >>>= shift;
      alpha >>>= shift;
      if (blue > 255) blue = 255;
      if (green > 255) green = 255;
      if (red > 255) red = 255;
      if (alpha > 255) alpha = 255;
      target[targetRow + x] = (blue | green << 8 | red << 16 | alpha << 24) >>> 0;
    }
  }
}
function coefficientSums(kernel, bias) {
  let positive = 0;
  let negative = 0;
  for (const coefficient of [...kernel, bias]) {
    if (coefficient > 0) positive = positive + coefficient >>> 0;
    else if (coefficient < 0) negative = negative + (-coefficient >>> 0) >>> 0;
  }
  return { saturatePositive: positive >= 256, saturateNegative: negative >= 256 };
}
function convolvePass(source, width, height, x, y, taps, state, output) {
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  let n0 = 0;
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  for (const tap of taps) {
    const sx = clamp4(x + tap.dx, 0, width - 1);
    const sy = clamp4(y + tap.dy, 0, height - 1);
    const pixel = source[sy * width + sx];
    const magnitude = Math.abs(tap.coefficient) & 65535;
    if (tap.coefficient > 0) {
      p0 = addWord(p0, Math.imul(pixel & 255, magnitude) & 65535, state.saturatePositive);
      p1 = addWord(p1, Math.imul(pixel >>> 8 & 255, magnitude) & 65535, state.saturatePositive);
      p2 = addWord(p2, Math.imul(pixel >>> 16 & 255, magnitude) & 65535, state.saturatePositive);
      p3 = addWord(p3, Math.imul(pixel >>> 24, magnitude) & 65535, state.saturatePositive);
    } else {
      n0 = addWord(n0, Math.imul(pixel & 255, magnitude) & 65535, state.saturateNegative);
      n1 = addWord(n1, Math.imul(pixel >>> 8 & 255, magnitude) & 65535, state.saturateNegative);
      n2 = addWord(n2, Math.imul(pixel >>> 16 & 255, magnitude) & 65535, state.saturateNegative);
      n3 = addWord(n3, Math.imul(pixel >>> 24, magnitude) & 65535, state.saturateNegative);
    }
  }
  if (state.bias > 0) {
    p0 = Math.min(65535, p0 + state.biasProduct);
    p1 = Math.min(65535, p1 + state.biasProduct);
    p2 = Math.min(65535, p2 + state.biasProduct);
    p3 = Math.min(65535, p3 + state.biasProduct);
  } else if (state.bias < 0) {
    n0 = Math.min(65535, n0 + state.biasProduct);
    n1 = Math.min(65535, n1 + state.biasProduct);
    n2 = Math.min(65535, n2 + state.biasProduct);
    n3 = Math.min(65535, n3 + state.biasProduct);
  }
  output[0] = combineWords(p0, n0, state);
  output[1] = combineWords(p1, n1, state);
  output[2] = combineWords(p2, n2, state);
  output[3] = combineWords(p3, n3, state);
}
function combineWords(positive, negative, state) {
  if (!state.hasNegative) return positive;
  if (state.config.absolute) {
    return clamp4(signed16(positive) - signed16(negative), -32768, 32767) & 65535 & 32767;
  }
  if (state.config.wrap) return positive - negative & 65535;
  return positive > negative ? positive - negative : 0;
}
function scaleWord(value, divisor) {
  if (divisor <= 1) return value & 65535;
  if (divisor <= 32768 && (divisor & divisor - 1) === 0) {
    return value >>> Math.log2(divisor);
  }
  const reciprocal = Math.floor(65536 / divisor) & 65535;
  return Math.floor(value * reciprocal / 65536) & 65535;
}
function addWord(left, right, saturate) {
  return saturate ? Math.min(65535, left + right) : left + right & 65535;
}
function signed16(value) {
  return value & 32768 ? (value & 65535) - 65536 : value & 65535;
}
function packByte(value) {
  const signed3 = signed16(value);
  return signed3 < 0 ? 0 : signed3 > 255 ? 255 : signed3;
}
function clamp4(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

// src/avs/effects/basic-transforms.ts
function registerAvsBasicTransforms(registry = new AvsEffectRegistry()) {
  const clears = /* @__PURE__ */ new Map();
  const interleaves = /* @__PURE__ */ new Map();
  const mosaics = /* @__PURE__ */ new Map();
  const colorFades = /* @__PURE__ */ new Map();
  const waterFrames = /* @__PURE__ */ new Map();
  registry.registerBuiltin(5, (context2) => {
    if (context2.preinit) return;
    const color = int3(context2, 0, 16777215) & 16777215;
    const average = int3(context2, 4, 0) !== 0;
    const every = int3(context2, 8, 1);
    let state = clears.get(context2.component.path);
    if (!state) {
      state = { beats: 0, quiet: 0 };
      clears.set(context2.component.path, state);
    }
    if (context2.beat) {
      if (every !== 0 && ++state.beats >= every) {
        state.beats = 0;
        state.quiet = 0;
        if (average) for (let i = 0; i < context2.input.pixels.length; i++) {
          context2.input.pixels[i] = blendPixel(color, context2.input.pixels[i], "average");
        }
        else context2.input.clear(color);
      }
    } else if (++state.quiet >= every) state.quiet = 0;
  });
  registry.registerBuiltin(11, (context2) => {
    if (context2.preinit) return;
    const enabled = int3(context2, 0, 1);
    if (enabled === 0) return;
    const normal = [int3(context2, 4, 8), int3(context2, 8, -8), int3(context2, 12, -8)];
    const beat = [int3(context2, 16, normal[0]), int3(context2, 20, normal[1]), int3(context2, 24, normal[2])];
    let state = colorFades.get(context2.component.path);
    if (!state) {
      state = { position: [...normal], random: hashPath3(context2.component.path) };
      colorFades.set(context2.component.path, state);
    }
    state.position[0] += Math.sign(normal[0] - state.position[0]);
    state.position[1] += Math.sign(normal[2] - state.position[1]);
    state.position[2] += Math.sign(normal[1] - state.position[2]);
    if ((enabled & 4) === 0) state.position = [...normal];
    else if (context2.beat && (enabled & 2) !== 0) {
      state.position[0] = nextRandom(state, 32) - 6;
      state.position[1] = nextRandom(state, 64) - 32;
      if (state.position[1] < 0 && state.position[1] > -16) state.position[1] = -32;
      if (state.position[1] >= 0 && state.position[1] < 16) state.position[1] = 32;
      state.position[2] = nextRandom(state, 32) - 6;
    } else if (context2.beat) state.position = [...beat];
    const [first, second, third] = state.position;
    const table6 = [[third, second, first], [second, first, third], [first, third, second], [third, third, third]];
    for (let i = 0; i < context2.input.pixels.length; i++) {
      const pixel = context2.input.pixels[i];
      const low = pixel & 255, middle = pixel >>> 8 & 255, high = pixel >>> 16 & 255;
      const x = middle - high;
      const y = high - low;
      const category = x > 0 && x > -y ? 0 : y < 0 && x < -y ? 1 : x < 0 && y > 0 ? 2 : 3;
      const offsets = table6[category];
      context2.input.pixels[i] = clampByte3(low + offsets[0]) | clampByte3(middle + offsets[1]) << 8 | clampByte3(high + offsets[2]) << 16;
    }
  });
  registry.registerBuiltin(12, (context2) => {
    if (context2.preinit) return;
    const mode = int3(context2, 0, 1);
    if (mode === 0) return;
    const source = int3(context2, 4, 2105376) & 16777215;
    const replacement = int3(context2, 8, source) & 16777215;
    const distanceSquared = Math.pow(int3(context2, 12, 10) * 2, 2);
    const sr = source & 255, sg = source >>> 8 & 255, sb = source >>> 16 & 255;
    for (let i = 0; i < context2.input.pixels.length; i++) {
      const pixel = context2.input.pixels[i];
      const r = pixel & 255, g = pixel >>> 8 & 255, b = pixel >>> 16 & 255;
      const match = mode === 1 ? r <= sr && g <= sg && b <= sb : mode === 2 ? r >= sr && g >= sg && b >= sb : Math.pow(r - sr, 2) + Math.pow(g - sg, 2) + Math.pow(b - sb, 2) <= distanceSquared;
      if (match) context2.input.pixels[i] = replacement;
    }
  });
  registry.registerBuiltin(20, (context2) => {
    if (context2.preinit || int3(context2, 0, 1) === 0) return;
    const { width, height } = context2.input;
    let previous = waterFrames.get(context2.component.path);
    if (!previous || previous.length !== context2.input.pixels.length) {
      previous = new Uint32Array(context2.input.pixels.length);
      waterFrames.set(context2.component.path, previous);
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const neighbors = [];
      if (x > 0) neighbors.push(context2.input.pixels[x - 1 + y * width]);
      if (x + 1 < width) neighbors.push(context2.input.pixels[x + 1 + y * width]);
      if (y > 0) neighbors.push(context2.input.pixels[x + (y - 1) * width]);
      if (y + 1 < height) neighbors.push(context2.input.pixels[x + (y + 1) * width]);
      const index = x + y * width;
      let result = 0;
      for (let shift = 0; shift <= 16; shift += 8) {
        let total = 0;
        for (const pixel of neighbors) total += pixel >>> shift & 255;
        if (neighbors.length > 2) total = Math.trunc(total / 2);
        const value = clampByte3(total - (previous[index] >>> shift & 255));
        result |= value << shift;
      }
      context2.output.pixels[index] = result;
    }
    previous.set(context2.input.pixels);
    return { swap: true };
  });
  registry.registerBuiltin(23, (context2) => {
    if (context2.preinit || int3(context2, 0, 1) === 0) return;
    const normalX = int3(context2, 4, 1);
    const normalY = int3(context2, 8, 1);
    const color = int3(context2, 12, 0) & 16777215;
    const additive = int3(context2, 16, 0) !== 0;
    const average = int3(context2, 20, 0) !== 0;
    const onBeat = int3(context2, 24, 0) !== 0;
    const beatX = int3(context2, 28, normalX);
    const beatY = int3(context2, 32, normalY);
    const duration = int3(context2, 36, 4);
    let state = interleaves.get(context2.component.path);
    if (!state) {
      state = { x: normalX, y: normalY };
      interleaves.set(context2.component.path, state);
    }
    const smoothing = (duration + 448) / 512;
    state.x = state.x * smoothing + normalX * (1 - smoothing);
    state.y = state.y * smoothing + normalY * (1 - smoothing);
    if (context2.beat && onBeat) {
      state.x = beatX;
      state.y = beatY;
    }
    const blockX = Math.trunc(state.x);
    const blockY = Math.trunc(state.y);
    if (blockX < 0 || blockY < 0) return;
    let vertical = blockY === 0;
    let yPhase = blockY > 0 ? context2.input.height % blockY / 2 : 0;
    const xOffset = blockX > 0 ? Math.trunc(context2.input.width % blockX / 2) : 0;
    for (let y = 0; y < context2.input.height; y++) {
      if (blockY > 0 && ++yPhase >= blockY) {
        vertical = !vertical;
        yPhase = 0;
      }
      let horizontal = false;
      for (let x = 0; x < context2.input.width; x++) {
        const selected = !vertical || blockX > 0 && !horizontal;
        if (selected) {
          const index = x + y * context2.input.width;
          const mode = additive ? "additive" : average ? "average" : "replace";
          context2.input.pixels[index] = blendPixel(color, context2.input.pixels[index], mode);
        }
        if (blockX > 0 && (x + xOffset + 1) % blockX === 0) horizontal = !horizontal;
      }
    }
  });
  registry.registerBuiltin(30, (context2) => {
    if (context2.preinit || int3(context2, 0, 1) === 0) return;
    const quality = int3(context2, 4, 50);
    const beatQuality = int3(context2, 8, quality);
    const additive = int3(context2, 12, 0) !== 0;
    const average = int3(context2, 16, 0) !== 0;
    const onBeat = int3(context2, 20, 0) !== 0;
    const duration = Math.max(1, int3(context2, 24, 15));
    let state = mosaics.get(context2.component.path);
    if (!state) {
      state = { quality, remaining: 0 };
      mosaics.set(context2.component.path, state);
    }
    if (onBeat && context2.beat) {
      state.quality = beatQuality;
      state.remaining = duration;
    } else if (state.remaining === 0) state.quality = quality;
    if (state.quality < 100 && state.quality > 0) {
      mosaic(context2, state.quality, additive, average);
      if (state.remaining > 0) {
        state.remaining--;
        if (state.remaining > 0) {
          const step = Math.trunc(Math.abs(quality - beatQuality) / duration);
          state.quality += step * (beatQuality > quality ? -1 : 1);
        }
      }
      return { swap: true };
    }
    if (state.remaining > 0) state.remaining--;
  });
  return registry;
}
function mosaic(context2, quality, additive, average) {
  const { width, height } = context2.input;
  const incrementX = Math.trunc(width * 65536 / quality);
  const incrementY = Math.trunc(height * 65536 / quality);
  let sourceY = incrementY >> 17;
  let yPosition = 0;
  for (let y = 0; y < height; y++) {
    let sourceX = incrementX >> 17;
    let xPosition = 0;
    let sampled = context2.input.pixels[Math.min(height - 1, sourceY) * width + Math.min(width - 1, sourceX)];
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      context2.output.pixels[index] = additive ? blendPixel(sampled, context2.input.pixels[index], "additive") : average ? blendPixel(sampled, context2.input.pixels[index], "average") : sampled;
      xPosition += 65536;
      if (xPosition >= incrementX) {
        sourceX += xPosition >> 16;
        xPosition -= incrementX;
        if (sourceX < width) sampled = context2.input.pixels[Math.min(height - 1, sourceY) * width + sourceX];
      }
    }
    yPosition += 65536;
    if (yPosition >= incrementY) {
      sourceY += yPosition >> 16;
      yPosition -= incrementY;
    }
  }
}
function int3(context2, offset, fallback) {
  if (offset + 4 > context2.component.payload.length) return fallback;
  return new DataView(
    context2.component.payload.buffer,
    context2.component.payload.byteOffset,
    context2.component.payload.byteLength
  ).getInt32(offset, true);
}
function clampByte3(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.trunc(value);
}
function nextRandom(state, bound) {
  let value = state.random || 1831565813;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.random = value >>> 0;
  return state.random % bound;
}
function hashPath3(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/bitmap-assets.ts
function createAvsBitmapResolver(assets) {
  const resolved = /* @__PURE__ */ new Map();
  const entries = assets instanceof Map ? assets.entries() : Object.entries(assets);
  for (const [name, value] of entries) {
    const bitmap = value instanceof Uint8Array ? decodeAvsBmp(value) : validateBitmap(value);
    const normalized = normalizeName(name);
    resolved.set(normalized, bitmap);
    resolved.set(basename(normalized), bitmap);
  }
  return (legacyName) => {
    const normalized = normalizeName(legacyName);
    return resolved.get(normalized) ?? resolved.get(basename(normalized)) ?? null;
  };
}
function decodeAvsBmp(bytes) {
  if (bytes.length < 54 || bytes[0] !== 66 || bytes[1] !== 77) {
    throw new Error("Invalid BMP file header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = u322(view, 10);
  const dibSize = u322(view, 14);
  if (dibSize < 40 || 14 + dibSize > bytes.length) throw new Error(`Unsupported BMP DIB header ${dibSize}`);
  const width = i323(view, 18);
  const rawHeight = i323(view, 22);
  const planes = u16(view, 26);
  const bits = u16(view, 28);
  const compression = u322(view, 30);
  if (width <= 0 || rawHeight === 0 || planes !== 1) throw new Error("Invalid BMP dimensions or plane count");
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  if (pixelOffset > bytes.length) throw new Error("BMP pixel offset is outside the file");
  const palette = readPalette(bytes, view, dibSize, bits);
  const pixels = new Uint32Array(width * height);
  if (compression === 1 && bits === 8) {
    decodeRle8(bytes.subarray(pixelOffset), pixels, width, height, topDown, palette);
  } else if (compression === 0 || compression === 3 && (bits === 16 || bits === 32)) {
    decodeRows(bytes, view, pixelOffset, pixels, width, height, topDown, bits, compression, dibSize, palette);
  } else {
    throw new Error(`Unsupported BMP encoding: ${bits} bits, compression ${compression}`);
  }
  return { width, height, pixels };
}
function decodeRows(bytes, view, pixelOffset, pixels, width, height, topDown, bits, compression, dibSize, palette) {
  if (![1, 4, 8, 16, 24, 32].includes(bits)) throw new Error(`Unsupported BMP depth ${bits}`);
  const stride = Math.floor((width * bits + 31) / 32) * 4;
  const masks = colorMasks(view, bits, compression, dibSize);
  for (let storedY = 0; storedY < height; storedY++) {
    const y = topDown ? storedY : height - storedY - 1;
    const row = pixelOffset + storedY * stride;
    if (row + stride > bytes.length) throw new Error("Truncated BMP pixel rows");
    for (let x = 0; x < width; x++) {
      let pixel;
      if (bits === 1) pixel = palette[bytes[row + (x >>> 3)] >>> 7 - (x & 7) & 1] ?? 0;
      else if (bits === 4) {
        const packed = bytes[row + (x >>> 1)];
        pixel = palette[(x & 1) === 0 ? packed >>> 4 : packed & 15] ?? 0;
      } else if (bits === 8) pixel = palette[bytes[row + x]] ?? 0;
      else if (bits === 16) pixel = maskedPixel(u16(view, row + x * 2), masks);
      else if (bits === 24) {
        const offset = row + x * 3;
        pixel = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
      } else pixel = maskedPixel(u322(view, row + x * 4), masks);
      pixels[y * width + x] = pixel & 16777215;
    }
  }
}
function decodeRle8(data, pixels, width, height, topDown, palette) {
  let offset = 0;
  let x = 0;
  let storedY = 0;
  const write = (index) => {
    if (x < width && storedY < height) {
      const y = topDown ? storedY : height - storedY - 1;
      pixels[y * width + x] = palette[index] ?? 0;
    }
    x++;
  };
  while (offset + 1 < data.length && storedY < height) {
    const count = data[offset++];
    const value = data[offset++];
    if (count !== 0) {
      for (let i = 0; i < count; i++) write(value);
      continue;
    }
    if (value === 0) {
      x = 0;
      storedY++;
      continue;
    }
    if (value === 1) break;
    if (value === 2) {
      if (offset + 1 >= data.length) throw new Error("Truncated BMP RLE delta");
      x += data[offset++];
      storedY += data[offset++];
      continue;
    }
    if (offset + value > data.length) throw new Error("Truncated BMP RLE literal");
    for (let i = 0; i < value; i++) write(data[offset + i]);
    offset += value;
    if (value & 1) offset++;
  }
}
function readPalette(bytes, view, dibSize, bits) {
  if (bits > 8) return [];
  const declared = u322(view, 46);
  const count = declared || 1 << bits;
  const start = 14 + dibSize;
  if (start + count * 4 > bytes.length) throw new Error("Truncated BMP palette");
  const palette = [];
  for (let index = 0; index < count; index++) {
    const offset = start + index * 4;
    palette.push(bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16);
  }
  return palette;
}
function colorMasks(view, bits, compression, dibSize) {
  if (bits === 16 && compression === 0) return { red: 31744, green: 992, blue: 31 };
  if (bits === 32 && compression === 0) return { red: 16711680, green: 65280, blue: 255 };
  const offset = dibSize >= 52 ? 14 + 40 : 14 + dibSize;
  return { red: u322(view, offset), green: u322(view, offset + 4), blue: u322(view, offset + 8) };
}
function maskedPixel(value, masks) {
  return scaleMask(value, masks.blue) | scaleMask(value, masks.green) << 8 | scaleMask(value, masks.red) << 16;
}
function scaleMask(value, mask) {
  if (mask === 0) return 0;
  let shift = 0;
  while ((mask >>> shift & 1) === 0) shift++;
  const maximum = mask >>> shift;
  return Math.round(((value & mask) >>> shift) * 255 / maximum);
}
function validateBitmap(bitmap) {
  if (!Number.isInteger(bitmap.width) || !Number.isInteger(bitmap.height) || bitmap.width <= 0 || bitmap.height <= 0 || bitmap.pixels.length !== bitmap.width * bitmap.height) {
    throw new Error("Invalid AVS bitmap asset");
  }
  return bitmap;
}
function normalizeName(name) {
  return name.trim().replaceAll("\\", "/").toLowerCase();
}
function basename(name) {
  return name.slice(name.lastIndexOf("/") + 1);
}
function u16(view, offset) {
  if (offset + 2 > view.byteLength) throw new Error("Truncated BMP field");
  return view.getUint16(offset, true);
}
function u322(view, offset) {
  if (offset + 4 > view.byteLength) throw new Error("Truncated BMP field");
  return view.getUint32(offset, true);
}
function i323(view, offset) {
  if (offset + 4 > view.byteLength) throw new Error("Truncated BMP field");
  return view.getInt32(offset, true);
}

// src/avs/effects/beat-particle.ts
function decodeAvsMovingParticle(payload) {
  return {
    enabled: i324(payload, 0, 1),
    color: i324(payload, 4, 16777215) & 16777215,
    maximumDistance: i324(payload, 8, 16),
    size: i324(payload, 12, 8),
    beatSize: i324(payload, 16, 8),
    blend: i324(payload, 20, 1)
  };
}
function decodeAvsCustomBpm(payload) {
  return {
    enabled: i324(payload, 0, 1) !== 0,
    arbitrary: i324(payload, 4, 1) !== 0,
    skip: i324(payload, 8, 0) !== 0,
    invert: i324(payload, 12, 0) !== 0,
    arbitraryMilliseconds: i324(payload, 16, 500),
    skipCount: i324(payload, 20, 1),
    skipFirst: i324(payload, 24, 0)
  };
}
function decodeAvsStarfield(payload) {
  return {
    enabled: i324(payload, 0, 1) !== 0,
    color: i324(payload, 4, 16777215) & 16777215,
    additive: i324(payload, 8, 0) !== 0,
    average: i324(payload, 12, 0) !== 0,
    speed: f32(payload, 16, 6),
    maximumStars: i324(payload, 20, 350),
    onBeat: i324(payload, 24, 0) !== 0,
    beatSpeed: f32(payload, 28, 4),
    beatDurationFrames: i324(payload, 32, 15)
  };
}
function registerAvsBeatParticleEffects(registry, options = {}) {
  registerMovingParticle(registry, options);
  registerStarfield(registry, options);
  registerCustomBpm(registry, options);
  return registry;
}
function registerStarfield(registry, options) {
  const states = /* @__PURE__ */ new Map();
  registry.registerBuiltin(27, (context2) => {
    const config = decodeAvsStarfield(context2.component.payload);
    if (!config.enabled) return;
    let state = states.get(context2.component.path);
    if (!state) {
      state = {
        width: 0,
        height: 0,
        stars: [],
        currentSpeed: Math.fround(config.speed),
        beatIncrement: 0,
        beatFrames: 0,
        randomState: hashPath4(context2.component.path)
      };
      states.set(context2.component.path, state);
    }
    if (config.onBeat && (context2.beat || context2.preinit)) {
      state.currentSpeed = Math.fround(config.beatSpeed);
      state.beatIncrement = Math.fround((config.speed - state.currentSpeed) / config.beatDurationFrames);
      state.beatFrames = config.beatDurationFrames;
    }
    if (state.width !== context2.input.width || state.height !== context2.input.height) {
      state.width = context2.input.width;
      state.height = context2.input.height;
      initializeStars(state, config.maximumStars, options.random);
    }
    if (context2.preinit) return;
    const centerX = Math.trunc(state.width / 2);
    const centerY = Math.trunc(state.height / 2);
    for (const star of state.stars) {
      const depth = Math.trunc(star.z);
      if (depth <= 0) {
        recreateStar(star, state, options.random);
        continue;
      }
      const x = Math.trunc((star.x << 7) / depth) + centerX;
      const y = Math.trunc((star.y << 7) / depth) + centerY;
      if (x <= 0 || x >= state.width || y <= 0 || y >= state.height) {
        recreateStar(star, state, options.random);
        continue;
      }
      const intensity = Math.trunc((255 - depth) * star.speed);
      const gray = intensity | intensity << 8 | intensity << 16;
      const color = config.color === 16777215 ? gray : adaptiveStarColor(gray, config.color, intensity >> 4);
      const index = x + y * state.width;
      const destination = context2.input.pixels[index];
      context2.input.pixels[index] = config.additive ? blendPixel(color, destination, "additive") : config.average ? blendPixel(color, destination, "average") : color;
      star.z = Math.fround(star.z - Math.fround(star.speed * state.currentSpeed));
    }
    if (state.beatFrames === 0) state.currentSpeed = Math.fround(config.speed);
    else {
      state.currentSpeed = Math.fround(Math.max(0, state.currentSpeed + state.beatIncrement));
      state.beatFrames--;
    }
  });
}
function initializeStars(state, configuredCount, random) {
  const scaled = Math.round(configuredCount * state.width * state.height / (512 * 384));
  const count = Math.max(0, Math.min(4095, scaled));
  state.stars = new Array(count);
  const centerX = Math.trunc(state.width / 2);
  const centerY = Math.trunc(state.height / 2);
  for (let i = 0; i < count; i++) {
    state.stars[i] = {
      x: randomBound(state, random, state.width) - centerX,
      y: randomBound(state, random, state.height) - centerY,
      z: Math.fround(randomBound(state, random, 255)),
      speed: Math.fround((randomBound(state, random, 9) + 1) / 10)
    };
  }
}
function recreateStar(star, state, random) {
  star.x = randomBound(state, random, state.width) - Math.trunc(state.width / 2);
  star.y = randomBound(state, random, state.height) - Math.trunc(state.height / 2);
  star.z = 255;
}
function adaptiveStarColor(gray, color, divisor) {
  return (gray >>> 4 & 986895) * (16 - divisor) + (color >>> 4 & 986895) * divisor & 16777215;
}
function registerMovingParticle(registry, options) {
  const states = /* @__PURE__ */ new Map();
  registry.registerBuiltin(8, (context2) => {
    const config = decodeAvsMovingParticle(context2.component.payload);
    if ((config.enabled & 1) === 0 || context2.preinit) return;
    let state = states.get(context2.component.path);
    if (!state) {
      state = {
        center: [0, 0],
        velocity: [-0.01551, 0],
        position: [-0.6, 0.3],
        size: config.size,
        randomState: hashPath4(context2.component.path)
      };
      states.set(context2.component.path, state);
    }
    if (context2.beat) {
      state.center[0] = (randomModulo33(state, options.random) - 16) / 48;
      state.center[1] = (randomModulo33(state, options.random) - 16) / 48;
    }
    state.velocity[0] -= 4e-3 * (state.position[0] - state.center[0]);
    state.velocity[1] -= 4e-3 * (state.position[1] - state.center[1]);
    state.position[0] += state.velocity[0];
    state.position[1] += state.velocity[1];
    state.velocity[0] *= 0.991;
    state.velocity[1] *= 0.991;
    const scale = Math.min(Math.trunc(context2.input.height / 2), Math.trunc(context2.input.width * 3 / 8));
    const x = Math.trunc(state.position[0] * scale * (config.maximumDistance / 32)) + Math.trunc(context2.input.width / 2);
    const y = Math.trunc(state.position[1] * scale * (config.maximumDistance / 32)) + Math.trunc(context2.input.height / 2);
    if (context2.beat && (config.enabled & 2) !== 0) state.size = config.beatSize;
    const drawSize = state.size;
    state.size = Math.trunc((state.size + config.size) / 2);
    drawParticle(context2, x, y, drawSize, config.color, config.blend);
  });
}
function drawParticle(context2, centerX, centerY, rawSize, color, blend2) {
  if (rawSize <= 1) {
    plotParticlePixel(context2, centerX, centerY, color, blend2);
    return;
  }
  const size = Math.min(rawSize, 128);
  const radiusSquared = size * size * 0.25;
  const top = centerY - Math.trunc(size / 2);
  for (let row = 0; row < size; row++) {
    const y = top + row;
    if (y < 0 || y >= context2.input.height) continue;
    const relativeY = row - size * 0.5;
    const halfWidth = Math.max(1, Math.trunc(Math.sqrt(Math.max(0, radiusSquared - relativeY * relativeY)) + 0.99));
    const start = Math.max(0, centerX - halfWidth);
    const end = Math.min(context2.input.width, centerX + halfWidth);
    for (let x = start; x < end; x++) plotParticlePixel(context2, x, y, color, blend2);
  }
}
function plotParticlePixel(context2, x, y, color, blend2) {
  if (x < 0 || y < 0 || x >= context2.input.width || y >= context2.input.height) return;
  const index = x + y * context2.input.width;
  const destination = context2.input.pixels[index];
  context2.input.pixels[index] = blend2 === 0 ? color : blend2 === 2 ? blendPixel(color, destination, "average") : blend2 === 3 ? blendLine(color, destination, context2.line.blendMode, context2.line.adjustableAlpha) : blendPixel(color, destination, "additive");
}
function registerCustomBpm(registry, options) {
  const states = /* @__PURE__ */ new Map();
  const now = () => Math.trunc(options.now?.() ?? defaultNow()) >>> 0;
  registry.registerBuiltin(33, (context2) => {
    const config = decodeAvsCustomBpm(context2.component.payload);
    if (!config.enabled || context2.preinit) return;
    let state = states.get(context2.component.path);
    if (!state) {
      state = { lastTick: now(), skipped: 0, inputBeats: 0 };
      states.set(context2.component.path, state);
    }
    if (context2.beat) state.inputBeats++;
    if (config.skipFirst !== 0 && state.inputBeats <= config.skipFirst) {
      return context2.beat ? { beat: false } : void 0;
    }
    if (config.arbitrary) {
      const current = now();
      const deadline = state.lastTick + config.arbitraryMilliseconds >>> 0;
      if (current > deadline) {
        state.lastTick = current;
        return { beat: true };
      }
      return { beat: false };
    }
    if (config.skip) {
      if (context2.beat && ++state.skipped >= config.skipCount + 1) {
        state.skipped = 0;
        return { beat: true };
      }
      return { beat: false };
    }
    if (config.invert) return { beat: !context2.beat };
    return;
  });
}
function randomModulo33(state, hook) {
  const value = hook ? Math.trunc(hook()) >>> 0 : nextRandom2(state);
  return value % 33;
}
function randomBound(state, hook, bound) {
  if (bound <= 0) return 0;
  const value = hook ? Math.trunc(hook()) >>> 0 : nextStarRandom(state);
  return value % bound;
}
function nextRandom2(state) {
  let value = state.randomState || 1831565813;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.randomState = value >>> 0;
  return state.randomState;
}
function nextStarRandom(state) {
  let value = state.randomState || 1831565813;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.randomState = value >>> 0;
  return state.randomState;
}
function defaultNow() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
function i324(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function f32(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat32(offset, true) : fallback;
}
function hashPath4(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/bump.ts
var TEXT2 = new TextDecoder("windows-1252");
function decodeAvsBump(payload) {
  let offset = 0;
  const read = (fallback) => {
    const value = i325(payload, offset, fallback);
    offset += 4;
    return value;
  };
  const enabled = read(1) !== 0;
  const onBeat = read(0) !== 0;
  const beatDurationFrames = read(15);
  const depth = read(30);
  const beatDepth = read(100);
  const additive = read(0) !== 0;
  const average = read(0) !== 0;
  const scripts = [];
  for (let i = 0; i < 3; i++) {
    const decoded = readString(payload, offset);
    scripts.push(decoded.value);
    offset = decoded.next;
  }
  const showLight = read(0) !== 0;
  const invertDepth = read(0) !== 0;
  const oldStyle = offset + 4 <= payload.length ? read(0) !== 0 : true;
  const buffer = read(0);
  return {
    enabled,
    onBeat,
    beatDurationFrames,
    depth,
    beatDepth,
    additive,
    average,
    frame: scripts[0],
    beat: scripts[1],
    init: scripts[2],
    showLight,
    invertDepth,
    oldStyle,
    buffer
  };
}
function registerAvsBump(registry) {
  const states = /* @__PURE__ */ new Map();
  registry.registerBuiltin(29, (context2) => {
    const config = decodeAvsBump(context2.component.payload);
    if (!config.enabled) return;
    let state = states.get(context2.component.path);
    if (!state) {
      const vm = new AvsEelVm({ global: registry.eelGlobal, seed: hashPath5(context2.component.path) });
      vm.set("bi", 1);
      state = {
        vm,
        frame: compileOrNull2(config.frame),
        beat: compileOrNull2(config.beat),
        init: compileOrNull2(config.init),
        initialized: false,
        currentDepth: config.depth,
        beatFrames: 0
      };
      states.set(context2.component.path, state);
    }
    if (context2.preinit) return;
    const depthSurface = config.buffer === 0 ? context2.input : context2.buffers.get(config.buffer - 1, context2.input.width, context2.input.height, false);
    if (!depthSurface) return;
    configureVm(state.vm, context2);
    if (!state.initialized) {
      execute2(state.init, state.vm);
      state.initialized = true;
    }
    execute2(state.frame, state.vm);
    if (context2.beat) execute2(state.beat, state.vm);
    state.vm.set("isbeat", context2.beat ? -1 : 1);
    state.vm.set("islbeat", state.beatFrames ? -1 : 1);
    if (config.onBeat && context2.beat) {
      state.currentDepth = config.beatDepth;
      state.beatFrames = config.beatDurationFrames;
    } else if (!state.beatFrames) state.currentDepth = config.depth;
    context2.output.clear();
    const lightX = clamp5(Math.trunc(state.vm.get("x") * context2.input.width / (config.oldStyle ? 100 : 1)), 0, context2.input.width);
    const lightY = clamp5(Math.trunc(state.vm.get("y") * context2.input.height / (config.oldStyle ? 100 : 1)), 0, context2.input.height);
    if (config.showLight && lightX < context2.input.width && lightY < context2.input.height) {
      context2.output.pixels[lightX + lightY * context2.input.width] = 16777215;
    }
    const intensity = clamp5(state.vm.get("bi"), 0, 1);
    state.vm.set("bi", intensity);
    state.currentDepth = Math.trunc(state.currentDepth * intensity);
    shadeBump(context2, depthSurface.pixels, config, state.currentDepth, lightX, lightY);
    if (state.beatFrames) {
      state.beatFrames--;
      if (state.beatFrames) {
        const step = Math.trunc(Math.abs(config.depth - config.beatDepth) / config.beatDurationFrames);
        state.currentDepth += step * (config.beatDepth > config.depth ? -1 : 1);
      }
    }
    return { swap: true };
  });
  return registry;
}
function shadeBump(context2, depthPixels, config, currentDepth, lightX, lightY) {
  const { width, height } = context2.input;
  const source = context2.input.pixels;
  const output = context2.output.pixels;
  const currentDepthBuffer = depthPixels === source;
  const scaledDepth = Math.trunc((currentDepth << 8) / 100);
  for (let y = 1; y < height - 1; y++) {
    const relativeY = y - lightY;
    for (let x = 1; x < width - 1; x++) {
      const index = x + y * width;
      const left = depthPixels[index - 1];
      const right = depthPixels[index + 1];
      const above = depthPixels[index - width];
      const below = depthPixels[index + width];
      if (currentDepthBuffer && !(left || right || above || below)) continue;
      let horizontal = depthOf(right, config.invertDepth) - depthOf(left, config.invertDepth) - (x - lightX);
      let vertical = depthOf(below, config.invertDepth) - depthOf(above, config.invertDepth) - relativeY;
      horizontal = 127 - Math.abs(horizontal);
      vertical = 127 - Math.abs(vertical);
      const original = source[index];
      const lit = horizontal <= 0 || vertical <= 0 ? clamp254(original) : addLight(original, horizontal * vertical * scaledDepth >> 14);
      output[index] = config.additive ? blendPixel(lit, original, "additive") : config.average ? blendPixel(lit, original, "average") : lit;
    }
  }
}
function depthOf(pixel, invert) {
  const depth = Math.max(pixel & 255, pixel >>> 8 & 255, pixel >>> 16 & 255);
  return invert ? 255 - depth : depth;
}
function addLight(pixel, amount) {
  return Math.min((pixel & 255) + amount, 254) | Math.min((pixel >>> 8 & 255) + amount, 254) << 8 | Math.min((pixel >>> 16 & 255) + amount, 254) << 16;
}
function clamp254(pixel) {
  return Math.min(pixel & 255, 254) | Math.min(pixel >>> 8 & 255, 254) << 8 | Math.min(pixel >>> 16 & 255, 254) << 16;
}
function configureVm(vm, context2) {
  vm.setHost({
    getosc: (band, width, channel) => avsAudioSample(context2.audio, "osc", band, width, channel),
    getspec: (band, width, channel) => avsAudioSample(context2.audio, "spec", band, width, channel)
  });
}
function readString(payload, offset) {
  if (offset + 4 > payload.length) return { value: "", next: payload.length };
  const length = i325(payload, offset, 0);
  const start = offset + 4;
  if (length <= 0 || start + length > payload.length) return { value: "", next: start };
  return { value: nulText3(payload.subarray(start, start + length)), next: start + length };
}
function compileOrNull2(source) {
  if (!source.trim()) return null;
  try {
    return compileAvsEel(source);
  } catch {
    return null;
  }
}
function execute2(program, vm) {
  return program ? vm.execute(program) : 0;
}
function i325(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function nulText3(bytes) {
  const end = bytes.indexOf(0);
  return TEXT2.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp5(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath5(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/dynamic-movement.ts
var TEXT3 = new TextDecoder("windows-1252");
function decodeAvsDynamicMovement(payload) {
  let offset = 0;
  let scripts = ["", "", "", ""];
  if (payload[0] === 1) {
    offset = 1;
    for (let i = 0; i < 4; i++) {
      const value = readString2(payload, offset);
      scripts[i] = value.value;
      offset = value.next;
    }
  } else if (payload.length >= 1024) {
    scripts = [0, 256, 512, 768].map((start) => nulText4(payload.subarray(start, start + 256)));
    offset = 1024;
  }
  const read = (fallback) => {
    const value = i326(payload, offset, fallback);
    offset += 4;
    return value;
  };
  return {
    point: scripts[0],
    frame: scripts[1],
    beat: scripts[2],
    init: scripts[3],
    bilinear: read(1) !== 0,
    rectangular: read(0) !== 0,
    gridWidth: read(16),
    gridHeight: read(16),
    blend: read(0) !== 0,
    wrap: read(0) !== 0,
    buffer: read(0),
    noMove: read(0) !== 0
  };
}
function registerAvsDynamicMovement(registry) {
  const states = /* @__PURE__ */ new Map();
  registry.registerBuiltin(43, (context2) => {
    let state = states.get(context2.component.path);
    if (!state) {
      const config = decodeAvsDynamicMovement(context2.component.payload);
      const vm = new AvsEelVm({ global: registry.eelGlobal, seed: hashPath6(context2.component.path) });
      state = {
        config,
        vm,
        programs: [
          compileOrNull3(config.point),
          compileOrNull3(config.frame),
          compileOrNull3(config.beat),
          compileOrNull3(config.init)
        ],
        gridX: new Float64Array(0),
        gridY: new Float64Array(0),
        gridAlpha: new Float64Array(0),
        cellX: new Uint16Array(0),
        fractionX: new Float64Array(0),
        cellY: new Uint16Array(0),
        fractionY: new Float64Array(0),
        initialized: false
      };
      states.set(context2.component.path, state);
    }
    if (context2.preinit) return;
    return renderDynamicMovement(context2, state.config, state);
  });
  return registry;
}
function renderDynamicMovement(context2, config, state) {
  const source = config.buffer === 0 ? context2.input : context2.buffers.get(config.buffer - 1, context2.input.width, context2.input.height, false);
  if (!source) return;
  const vm = state.vm;
  vm.setHost({
    getosc: (band, width2, channel) => avsAudioSample(context2.audio, "osc", band, width2, channel),
    getspec: (band, width2, channel) => avsAudioSample(context2.audio, "spec", band, width2, channel)
  });
  vm.set("w", context2.input.width);
  vm.set("h", context2.input.height);
  vm.set("b", context2.beat ? 1 : 0);
  vm.set("alpha", 0.5);
  if (!state.initialized) {
    execute3(state.programs[3], vm);
    state.initialized = true;
  }
  execute3(state.programs[1], vm);
  if (context2.beat) execute3(state.programs[2], vm);
  const columns = clamp6(Math.trunc(config.gridWidth) + 1, 2, 256);
  const rows = clamp6(Math.trunc(config.gridHeight) + 1, 2, 256);
  const gridSize = columns * rows;
  if (state.gridX.length !== gridSize) {
    state.gridX = new Float64Array(gridSize);
    state.gridY = new Float64Array(gridSize);
    state.gridAlpha = new Float64Array(gridSize);
  }
  const gridX = state.gridX;
  const gridY = state.gridY;
  const gridAlpha = state.gridAlpha;
  const width = context2.input.width;
  const height = context2.input.height;
  prepareInterpolationAxis(state, width, height, columns, rows);
  const radius = Math.sqrt(width * width + height * height) * 0.5;
  for (let gy = 0; gy < rows; gy++) {
    const screenY = gy * height / (rows - 1);
    const normalizedY = (screenY - height * 0.5) * (2 / height);
    for (let gx = 0; gx < columns; gx++) {
      const screenX = gx * width / (columns - 1);
      const normalizedX = (screenX - width * 0.5) * (2 / width);
      vm.set("x", normalizedX);
      vm.set("y", normalizedY);
      vm.set("d", Math.hypot(screenX - width * 0.5, screenY - height * 0.5) / radius);
      vm.set("r", Math.atan2(screenY - height * 0.5, screenX - width * 0.5) + Math.PI * 0.5);
      execute3(state.programs[0], vm);
      let x;
      let y;
      if (config.rectangular) {
        x = (vm.get("x") + 1) * width * 0.5;
        y = (vm.get("y") + 1) * height * 0.5;
      } else {
        const distance = vm.get("d") * radius;
        const angle = vm.get("r") - Math.PI * 0.5;
        x = width * 0.5 + Math.cos(angle) * distance;
        y = height * 0.5 + Math.sin(angle) * distance;
      }
      const index = gx + gy * columns;
      gridX[index] = x;
      gridY[index] = y;
      gridAlpha[index] = clamp6(vm.get("alpha"), 0, 1);
    }
  }
  const cellXs = state.cellX;
  const fractionXs = state.fractionX;
  const cellYs = state.cellY;
  const fractionYs = state.fractionY;
  if (!config.noMove && !config.bilinear) {
    renderNearestGrid(
      context2,
      config,
      source.pixels,
      gridX,
      gridY,
      gridAlpha,
      cellXs,
      fractionXs,
      cellYs,
      fractionYs,
      columns
    );
    return { swap: true };
  }
  for (let y = 0; y < height; y++) {
    const cellY = cellYs[y];
    const fy = fractionYs[y];
    for (let x = 0; x < width; x++) {
      const cellX = cellXs[x];
      const fx = fractionXs[x];
      const topLeft = cellX + cellY * columns;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      const mappedX = bilerp(gridX[topLeft], gridX[topRight], gridX[bottomLeft], gridX[bottomRight], fx, fy);
      const mappedY = bilerp(gridY[topLeft], gridY[topRight], gridY[bottomLeft], gridY[bottomRight], fx, fy);
      const alpha = config.noMove || config.blend ? Math.trunc(clamp6(bilerp(
        gridAlpha[topLeft],
        gridAlpha[topRight],
        gridAlpha[bottomLeft],
        gridAlpha[bottomRight],
        fx,
        fy
      ), 0, 1) * 255) : 0;
      const index = x + y * width;
      if (config.noMove) {
        const maskSource = config.buffer === 0 ? 0 : source.pixels[index];
        context2.input.pixels[index] = blendPixel(maskSource, context2.input.pixels[index], "adjustable", alpha);
        continue;
      }
      const sampled = sample(source.pixels, width, height, mappedX, mappedY, config.wrap, config.bilinear);
      context2.output.pixels[index] = config.blend ? blendPixel(sampled, context2.input.pixels[index], "adjustable", alpha) : sampled;
    }
  }
  return config.noMove ? void 0 : { swap: true };
}
function renderNearestGrid(context2, config, source, gridX, gridY, gridAlpha, cellXs, fractionXs, cellYs, fractionYs, columns) {
  const width = context2.input.width;
  const height = context2.input.height;
  const destination = context2.output.pixels;
  const input = context2.input.pixels;
  const maxX = width - 1;
  const maxY = height - 1;
  const spanX = Math.max(1, maxX);
  const spanY = Math.max(1, maxY);
  const blendTable = AVS_BLEND_TABLE;
  let index = 0;
  for (let y = 0; y < height; y++) {
    const cellY = cellYs[y];
    const fy = fractionYs[y];
    const inverseY = 1 - fy;
    const row = cellY * columns;
    for (let x = 0; x < width; x++, index++) {
      const fx = fractionXs[x];
      const topLeft = cellXs[x] + row;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      let mappedX = (gridX[topLeft] + (gridX[topRight] - gridX[topLeft]) * fx) * inverseY + (gridX[bottomLeft] + (gridX[bottomRight] - gridX[bottomLeft]) * fx) * fy;
      let mappedY = (gridY[topLeft] + (gridY[topRight] - gridY[topLeft]) * fx) * inverseY + (gridY[bottomLeft] + (gridY[bottomRight] - gridY[bottomLeft]) * fx) * fy;
      if (config.wrap) {
        mappedX = (mappedX % spanX + spanX) % spanX;
        mappedY = (mappedY % spanY + spanY) % spanY;
      } else {
        mappedX = clamp6(mappedX, 0, maxX);
        mappedY = clamp6(mappedY, 0, maxY);
      }
      const sampled = source[Math.trunc(mappedX) + Math.trunc(mappedY) * width];
      if (!config.blend) {
        destination[index] = sampled;
        continue;
      }
      const rawAlpha = (gridAlpha[topLeft] + (gridAlpha[topRight] - gridAlpha[topLeft]) * fx) * inverseY + (gridAlpha[bottomLeft] + (gridAlpha[bottomRight] - gridAlpha[bottomLeft]) * fx) * fy;
      const alpha = Math.trunc(clamp6(rawAlpha, 0, 1) * 255);
      const inverse = 255 - alpha;
      const current = input[index];
      const low = blendTable[(sampled & 255) << 8 | alpha] + blendTable[(current & 255) << 8 | inverse];
      const middle = blendTable[(sampled >>> 8 & 255) << 8 | alpha] + blendTable[(current >>> 8 & 255) << 8 | inverse];
      const high = blendTable[(sampled >>> 16 & 255) << 8 | alpha] + blendTable[(current >>> 16 & 255) << 8 | inverse];
      destination[index] = low | middle << 8 | high << 16;
    }
  }
}
function prepareInterpolationAxis(state, width, height, columns, rows) {
  let rebuildX = false;
  if (state.cellX.length !== width) {
    state.cellX = new Uint16Array(width);
    state.fractionX = new Float64Array(width);
    rebuildX = true;
  }
  let rebuildY = false;
  if (state.cellY.length !== height) {
    state.cellY = new Uint16Array(height);
    state.fractionY = new Float64Array(height);
    rebuildY = true;
  }
  if (rebuildX) {
    for (let x = 0; x < width; x++) {
      const coordinate = x * (columns - 1) / width;
      const cell = Math.min(columns - 2, Math.trunc(coordinate));
      state.cellX[x] = cell;
      state.fractionX[x] = coordinate - cell;
    }
  }
  if (rebuildY) {
    for (let y = 0; y < height; y++) {
      const coordinate = y * (rows - 1) / height;
      const cell = Math.min(rows - 2, Math.trunc(coordinate));
      state.cellY[y] = cell;
      state.fractionY[y] = coordinate - cell;
    }
  }
}
function sample(pixels, width, height, rawX, rawY, wrap, bilinear3) {
  const maxX = bilinear3 ? Math.max(0, width - 2) : width - 1;
  const maxY = bilinear3 ? Math.max(0, height - 2) : height - 1;
  let x = rawX;
  let y = rawY;
  if (wrap) {
    const spanX = Math.max(1, maxX);
    const spanY = Math.max(1, maxY);
    x = (x % spanX + spanX) % spanX;
    y = (y % spanY + spanY) % spanY;
  } else {
    x = clamp6(x, 0, maxX);
    y = clamp6(y, 0, maxY);
  }
  const ix = Math.trunc(x);
  const iy = Math.trunc(y);
  if (!bilinear3 || width < 2 || height < 2) return pixels[ix + iy * width];
  const fx = Math.trunc((x - ix) * 256) & 255;
  const fy = Math.trunc((y - iy) * 256) & 255;
  const inverseX = 255 - fx;
  const inverseY = 255 - fy;
  const w0 = table3(inverseX, inverseY);
  const w1 = table3(fx, inverseY);
  const w2 = table3(inverseX, fy);
  const w3 = table3(fx, fy);
  const offset = ix + iy * width;
  const p0 = pixels[offset];
  const p1 = pixels[offset + 1];
  const p2 = pixels[offset + width];
  const p3 = pixels[offset + width + 1];
  const low = table3(p0 & 255, w0) + table3(p1 & 255, w1) + table3(p2 & 255, w2) + table3(p3 & 255, w3);
  const middle = table3(p0 >>> 8 & 255, w0) + table3(p1 >>> 8 & 255, w1) + table3(p2 >>> 8 & 255, w2) + table3(p3 >>> 8 & 255, w3);
  const high = table3(p0 >>> 16 & 255, w0) + table3(p1 >>> 16 & 255, w1) + table3(p2 >>> 16 & 255, w2) + table3(p3 >>> 16 & 255, w3);
  return low & 255 | (middle & 255) << 8 | (high & 255) << 16;
}
function readString2(payload, offset) {
  if (offset + 4 > payload.length) return { value: "", next: payload.length };
  const length = u323(payload, offset, 0);
  const start = offset + 4;
  const end = Math.min(payload.length, start + length);
  return { value: nulText4(payload.subarray(start, end)), next: end };
}
function compileOrNull3(source) {
  if (!source.trim()) return null;
  try {
    return compileAvsEel(source);
  } catch {
    return null;
  }
}
function execute3(program, vm) {
  return program ? vm.execute(program) : 0;
}
function i326(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function u323(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(offset, true) : fallback;
}
function nulText4(bytes) {
  const end = bytes.indexOf(0);
  return TEXT3.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function bilerp(a, b, c, d, x, y) {
  return (a + (b - a) * x) * (1 - y) + (c + (d - c) * x) * y;
}
function table3(x, y) {
  return AVS_BLEND_TABLE[x << 8 | y];
}
function clamp6(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath6(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/final-low-count-builtins.ts
function registerAvsFinalLowCountBuiltins(registry = new AvsEffectRegistry()) {
  const rotoStates = /* @__PURE__ */ new Map();
  const interferenceStates = /* @__PURE__ */ new Map();
  const fountainStates = /* @__PURE__ */ new Map();
  registry.registerBuiltin(9, (context2) => {
    if (context2.preinit) return;
    const zoom = int4(context2, 0, 31), direction = int4(context2, 4, 31), blend2 = int4(context2, 8, 0) !== 0;
    const beatReverse = int4(context2, 12, 0) !== 0, beatSpeed = int4(context2, 16, 0);
    const beatZoom = int4(context2, 20, 31), beatScale = int4(context2, 24, 0) !== 0, subpixel = int4(context2, 28, 0) !== 0;
    let state = rotoStates.get(context2.component.path);
    if (!state) {
      state = { reverse: 1, reversePosition: 1, scalePosition: zoom };
      rotoStates.set(context2.component.path, state);
    }
    if (context2.beat && beatReverse) state.reverse = -state.reverse;
    if (!beatReverse) state.reverse = 1;
    state.reversePosition += (state.reverse - state.reversePosition) / (1 + beatSpeed * 4);
    if (state.reverse > 0 && state.reversePosition > state.reverse) state.reversePosition = state.reverse;
    if (state.reverse < 0 && state.reversePosition < state.reverse) state.reversePosition = state.reverse;
    if (context2.beat && beatScale) state.scalePosition = beatZoom;
    let scale;
    if (zoom < beatZoom) {
      scale = Math.max(state.scalePosition, zoom);
      if (state.scalePosition > zoom) state.scalePosition -= 3;
    } else {
      scale = Math.min(state.scalePosition, zoom);
      if (state.scalePosition < zoom) state.scalePosition += 3;
    }
    rotoBlit(context2, 1 + (scale - 31) / 31, (direction - 32) * state.reversePosition, blend2, subpixel);
    return { swap: true };
  });
  registry.registerBuiltin(19, (context2) => {
    if (context2.preinit) return;
    let state = fountainStates.get(context2.component.path);
    if (!state) {
      state = createFountain(int4(context2, 28, 0) / 32);
      fountainStates.set(context2.component.path, state);
    }
    renderFountain(context2, state, int4(context2, 0, 16), readFiveColors(context2), int4(context2, 24, -20));
  });
  registry.registerBuiltin(41, (context2) => {
    if (context2.preinit || int4(context2, 0, 1) === 0) return;
    const count = Math.max(0, Math.min(8, int4(context2, 4, 2)));
    if (count === 0) return;
    let state = interferenceStates.get(context2.component.path);
    if (!state) {
      state = { rotation: int4(context2, 8, 0), status: Math.PI };
      interferenceStates.set(context2.component.path, state);
    }
    const onBeat = int4(context2, 48, 1) !== 0;
    if (onBeat && context2.beat && state.status >= Math.PI) state.status = 0;
    const wave = Math.sin(state.status);
    const rotationIncrement = int4(context2, 20, 0) + Math.trunc((int4(context2, 40, 25) - int4(context2, 20, 0)) * wave);
    const alpha = int4(context2, 16, 128) + Math.trunc((int4(context2, 36, 192) - int4(context2, 16, 128)) * wave);
    const distance = int4(context2, 12, 10) + Math.trunc((int4(context2, 32, 32) - int4(context2, 12, 10)) * wave);
    const points = Array.from({ length: count }, (_, index) => {
      const angle = state.rotation / 255 * Math.PI * 2 + Math.PI * 2 * index / count;
      return [Math.trunc(Math.cos(angle) * distance), Math.trunc(Math.sin(angle) * distance)];
    });
    interference(context2, points, alpha, int4(context2, 44, 1) !== 0);
    state.rotation += rotationIncrement;
    state.rotation = state.rotation > 255 ? state.rotation - 255 : state.rotation < -255 ? state.rotation + 255 : state.rotation;
    state.status = Math.min(Math.PI, state.status + float(context2, 52, 0.2));
    if (state.status < -Math.PI) state.status = Math.PI;
    const additive = int4(context2, 24, 0) !== 0, average = int4(context2, 28, 0) !== 0;
    if (!additive && !average) return { swap: true };
    const blockLength = Math.trunc(context2.input.pixels.length / 4) * 4;
    for (let i = 0; i < blockLength; i++) context2.input.pixels[i] = blendPixel(context2.output.pixels[i], context2.input.pixels[i], average ? "average" : "additive");
  });
  return registry;
}
function rotoBlit(context2, zoom, degrees, blend2, subpixel) {
  const width = context2.input.width, height = context2.input.height;
  const ds = width - 1 << 16, dt = height - 1 << 16;
  if (ds === 0 || dt === 0) {
    context2.output.copyFrom(context2.input);
    return;
  }
  const cosine = Math.cos(degrees * Math.PI / 180) * zoom, sine = Math.sin(degrees * Math.PI / 180) * zoom;
  const dsDx = Math.trunc(cosine * 65536), dtDy = Math.trunc(cosine * 65536);
  const dsDy = -Math.trunc(sine * 65536), dtDx = Math.trunc(sine * 65536);
  if (dsDx <= -ds || dsDx >= ds || dtDx <= -dt || dtDx >= dt) return;
  let sStart = -Math.trunc((width - 1) / 2) * dsDx - Math.trunc((height - 1) / 2) * dsDy + (width - 1) * (32768 + (1 << 20));
  let tStart = -Math.trunc((width - 1) / 2) * dtDx - Math.trunc((height - 1) / 2) * dtDy + (height - 1) * (32768 + (1 << 20));
  let output = 0;
  for (let row = height; row > 0; row--) {
    let s = modulo3(sStart, ds), t = modulo3(tStart, dt);
    for (let x = width; x > 0; x--) {
      const sample2 = subpixel ? bilinear2(context2, s, t) : context2.input.pixels[(s >> 16) + (t >> 16) * width];
      context2.output.pixels[output] = blend2 ? blendPixel(sample2, context2.input.pixels[output], "average") : sample2;
      output++;
      s = modulo3(s + dsDx, ds);
      t = modulo3(t + dtDx, dt);
    }
    sStart += dsDy;
    tStart += dtDy;
  }
}
function bilinear2(context2, s, t) {
  const x = s >> 16, y = t >> 16, fx = s >> 8 & 255, fy = t >> 8 & 255, width = context2.input.width;
  const pixels = context2.input.pixels, base = x + y * width;
  const weights = [table4(255 - fx, 255 - fy), table4(fx, 255 - fy), table4(255 - fx, fy), table4(fx, fy)];
  const samples = [pixels[base], pixels[base + 1], pixels[base + width], pixels[base + width + 1]];
  return channels(samples, weights);
}
function interference(context2, points, alpha, rgb2) {
  const width = context2.input.width, height = context2.input.height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rgb2 && (points.length === 3 || points.length === 6)) {
      const values = [0, 0, 0];
      for (let index = 0; index < points.length; index++) {
        const pixel = displaced(context2, x, y, points[index]);
        const channel = index % 3;
        values[channel] = Math.min(255, values[channel] + table4(pixel >>> channel * 8 & 255, alpha));
      }
      context2.output.pixels[x + y * width] = values[0] | values[1] << 8 | values[2] << 16;
    } else {
      let red = 0, green = 0, blue = 0;
      for (const point of points) {
        const pixel = displaced(context2, x, y, point);
        blue += table4(pixel & 255, alpha);
        green += table4(pixel >>> 8 & 255, alpha);
        red += table4(pixel >>> 16 & 255, alpha);
      }
      context2.output.pixels[x + y * width] = Math.min(255, blue) | Math.min(255, green) << 8 | Math.min(255, red) << 16;
    }
  }
}
function displaced(context2, x, y, point) {
  const sx = x - point[0], sy = y - point[1];
  return sx >= 0 && sy >= 0 && sx < context2.input.width && sy < context2.input.height ? context2.input.pixels[sx + sy * context2.input.width] : 0;
}
function createFountain(rotation) {
  const length = 256 * 30;
  return { rotation, radius: new Float32Array(length), radialVelocity: new Float32Array(length), height: new Float32Array(length), heightVelocity: new Float32Array(length), axisX: new Float32Array(length), axisY: new Float32Array(length), color: new Uint32Array(length) };
}
function renderFountain(context2, state, velocity, colors, tilt) {
  const columns = 30;
  for (let row = 254; row >= 0; row--) for (let column = 0; column < columns; column++) {
    const source = row * columns + column, target = source + columns, acceleration = 1.3 / (row + 100);
    state.radius[target] = state.radius[source] + state.radialVelocity[source];
    state.heightVelocity[target] = state.heightVelocity[source] + 0.05;
    state.radialVelocity[target] = state.radialVelocity[source] + acceleration;
    state.height[target] = state.height[source] + state.heightVelocity[target];
    state.axisX[target] = state.axisX[source];
    state.axisY[target] = state.axisY[source];
    state.color[target] = state.color[source];
  }
  const colorTable = fountainColors(colors);
  for (let column = 0; column < columns; column++) {
    let energy = Math.trunc((context2.audio.waveform[0][column] ^ 128) * 5 / 4) - 64;
    if (context2.beat) energy += 128;
    energy = Math.min(255, energy);
    const radial = Math.abs(energy / 200) + 1, index = column;
    state.radius[index] = 1;
    state.height[index] = 250;
    state.heightVelocity[index] = -radial * (100 + (state.heightVelocity[index] - state.heightVelocity[index])) / 100 * 2.8;
    state.color[index] = colorTable[Math.min(63, Math.trunc(energy / 4))] ?? 0;
    const angle = column * Math.PI * 2 / columns;
    state.axisX[index] = Math.sin(angle);
    state.axisY[index] = Math.cos(angle);
    state.radialVelocity[index] = 0;
  }
  const rotateZ = rotationMatrix(2, state.rotation), rotateY = rotationMatrix(1, tilt), translated = translationMatrix(0, -20, 400);
  const matrix = multiplyMatrices(multiplyMatrices(rotateZ, rotateY), translated);
  const projection = Math.min(context2.input.width * 440 / 640, context2.input.height * 440 / 480);
  for (let index = 0; index < state.radius.length; index++) {
    const [x, y, z] = applyMatrix(matrix, state.axisX[index] * state.radius[index], state.height[index], state.axisY[index] * state.radius[index]);
    const scale = projection / z;
    if (scale <= 1e-7) continue;
    const px = Math.trunc(x * scale) + Math.trunc(context2.input.width / 2), py = Math.trunc(y * scale) + Math.trunc(context2.input.height / 2);
    if (px >= 0 && py >= 0 && px < context2.input.width && py < context2.input.height) {
      const at = px + py * context2.input.width;
      context2.input.pixels[at] = blendLine(state.color[index], context2.input.pixels[at], context2.line.blendMode, context2.line.adjustableAlpha);
    }
  }
  state.rotation += velocity / 5;
  if (state.rotation >= 360) state.rotation -= 360;
  if (state.rotation < 0) state.rotation += 360;
}
function fountainColors(colors) {
  const tableOut = new Uint32Array(64);
  for (let segment = 0; segment < 4; segment++) for (let step = 0; step < 16; step++) tableOut[segment * 16 + step] = mixColor(colors[segment], colors[segment + 1], step, 16);
  return tableOut;
}
function readFiveColors(context2) {
  const defaults = [1862424, 16714275, 2760052, 9451225, 7047423];
  return defaults.map((fallback, index) => int4(context2, 4 + index * 4, fallback) & 16777215);
}
function rotationMatrix(axis, degrees) {
  const m = new Array(16).fill(0), m1 = axis % 3, m2 = (m1 + 1) % 3, c = Math.cos(degrees * Math.PI / 180), s = Math.sin(degrees * Math.PI / 180);
  m[(axis - 1) * 4 + axis - 1] = 1;
  m[15] = 1;
  m[m1 * 4 + m1] = c;
  m[m1 * 4 + m2] = s;
  m[m2 * 4 + m2] = c;
  m[m2 * 4 + m1] = -s;
  return m;
}
function translationMatrix(x, y, z) {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}
function multiplyMatrices(destination, source) {
  const out = new Array(16);
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) out[row * 4 + column] = source[row * 4] * destination[column] + source[row * 4 + 1] * destination[4 + column] + source[row * 4 + 2] * destination[8 + column] + source[row * 4 + 3] * destination[12 + column];
  return out;
}
function applyMatrix(m, x, y, z) {
  return [x * m[0] + y * m[1] + z * m[2] + m[3], x * m[4] + y * m[5] + z * m[6] + m[7], x * m[8] + y * m[9] + z * m[10] + m[11]];
}
function channels(samples, weights) {
  let out = 0;
  for (let channel = 0; channel < 3; channel++) {
    let value = 0;
    for (let i = 0; i < 4; i++) value += table4(samples[i] >>> channel * 8 & 255, weights[i]);
    out |= (value & 255) << channel * 8;
  }
  return out;
}
function mixColor(a, b, numerator, denominator) {
  let out = 0;
  for (let channel = 0; channel < 3; channel++) out |= Math.trunc(((a >>> channel * 8 & 255) * (denominator - numerator) + (b >>> channel * 8 & 255) * numerator) / denominator) << channel * 8;
  return out;
}
function table4(x, y) {
  return Math.trunc(x / 255 * y);
}
function modulo3(value, divisor) {
  const result = value % divisor;
  return result < 0 ? result + divisor : result;
}
function int4(context2, offset, fallback) {
  return offset + 4 <= context2.component.payload.length ? new DataView(context2.component.payload.buffer, context2.component.payload.byteOffset, context2.component.payload.byteLength).getInt32(offset, true) : fallback;
}
function float(context2, offset, fallback) {
  return offset + 4 <= context2.component.payload.length ? new DataView(context2.component.payload.buffer, context2.component.payload.byteOffset, context2.component.payload.byteLength).getFloat32(offset, true) : fallback;
}

// src/avs/effects/movement.ts
var TEXT4 = new TextDecoder("windows-1252");
var CUSTOM_EFFECT = 32767;
var LAST_BUILTIN_EFFECT = 23;
var OFFSET_MASK = (1 << 22) - 1;
var EVALUATED_BUILTINS = {
  18: {
    source: "d=d*(1-(sin((r-$pi*.5)*7)*.03));r=r+(cos(d*12)*.03)",
    rectangular: false
  },
  19: {
    source: "d=d*(1-(sin((r-$pi*.5)*12)*.05));r=r+(cos(d*18)*.05);d=d*(1-((d-.4)*.03));r=r+((d-.4)*.13)",
    rectangular: false
  },
  20: { source: "x=x+(cos(y*18)*.02);y=y+(sin(x*14)*.03)", rectangular: true },
  21: {
    source: "x=x+(cos(abs(y-.5)*8)*.02);y=y+(sin(abs(x-.5)*8)*.05);x=x*.95;y=y*.95",
    rectangular: true
  },
  22: {
    source: "y=y*(1+(sin(r+$pi/2)*.3));x=x*(1+(cos(r+$pi/2)*.3));x=x*.995;y=y*.995",
    rectangular: true
  },
  23: { source: "y=(r*6)/$pi;x=d", rectangular: true }
};
function decodeAvsMovement(payload) {
  let offset = 0;
  let effect = readI322(payload, offset, 1);
  offset += 4;
  let expression = "";
  let rectangular = false;
  if (effect === CUSTOM_EFFECT) {
    if (asciiEquals(payload, offset, "!rect ")) {
      offset += 6;
      rectangular = true;
    }
    if (payload[offset] === 1) {
      offset++;
      const length = readI322(payload, offset, 0);
      offset += 4;
      if (length > 0 && offset + length <= payload.length) {
        expression = nulText5(payload.subarray(offset, offset + length));
        offset += length;
      }
    } else {
      const length = 256 - (rectangular ? 6 : 0);
      if (offset + length <= payload.length) {
        expression = nulText5(payload.subarray(offset, offset + length));
        offset += length;
      }
    }
  }
  const blend2 = readI322(payload, offset, 0) !== 0;
  offset += 4;
  const sourceMapped = readI322(payload, offset, 0);
  offset += 4;
  rectangular = readI322(payload, offset, rectangular ? 1 : 0) !== 0;
  offset += 4;
  const subpixel = readI322(payload, offset, 0) !== 0;
  offset += 4;
  const wrap = readI322(payload, offset, 0) !== 0;
  offset += 4;
  if (effect === 0 && offset + 4 <= payload.length) effect = readI322(payload, offset, 0);
  if (effect !== CUSTOM_EFFECT && effect > LAST_BUILTIN_EFFECT || effect < 0) effect = 0;
  return { effect, expression, blend: blend2, sourceMapped, rectangular, subpixel, wrap };
}
function registerAvsMovement(registry, global = new AvsEelGlobalState()) {
  const states = /* @__PURE__ */ new Map();
  registry.registerBuiltin(15, (context2) => {
    let state = states.get(context2.component.path);
    if (!state) {
      const config = decodeAvsMovement(context2.component.payload);
      state = {
        config,
        program: movementProgram(config),
        sourceMapped: config.sourceMapped,
        width: 0,
        height: 0,
        table: null,
        randomState: hashPath7(context2.component.path)
      };
      states.set(context2.component.path, state);
    }
    if (state.config.effect === 0) return;
    if (!state.table || state.width !== context2.input.width || state.height !== context2.input.height) {
      state.table = buildMovementTable(context2, state, global);
      state.width = context2.input.width;
      state.height = context2.input.height;
    }
    if (context2.preinit) return;
    if ((state.sourceMapped & 2) !== 0 && context2.beat) state.sourceMapped ^= 1;
    if ((state.sourceMapped & 1) !== 0) renderForward(context2, state.table, state.config.blend);
    else renderInverse(context2, state.table, state.config.blend);
    return { swap: true };
  });
  return registry;
}
function movementProgram(config) {
  const source = config.effect === CUSTOM_EFFECT ? config.expression : EVALUATED_BUILTINS[config.effect]?.source;
  if (!source?.trim()) return null;
  try {
    return compileAvsEel(source);
  } catch {
    return null;
  }
}
function buildMovementTable(context2, state, global) {
  const { width, height } = context2.input;
  const count = width * height;
  const config = state.config;
  const bilinear3 = config.subpixel && width > 1 && height > 1 && count < 1 << 22 && (config.effect === CUSTOM_EFFECT || config.effect >= 3 && config.effect <= 23 && config.effect !== 7);
  const table6 = {
    offsets: new Uint32Array(count),
    xWeights: new Uint8Array(count),
    yWeights: new Uint8Array(count),
    bilinear: bilinear3
  };
  if (config.effect === 1) {
    for (let i = 0; i < count; i++) {
      const dx = nextRandom3(state) % 3 - 1;
      const dy = nextRandom3(state) % 3 - 1;
      table6.offsets[i] = clamp7(i + dx + dy * width, 0, count - 1);
    }
    return table6;
  }
  if (config.effect === 2) {
    const shift = Math.trunc(width / 64);
    for (let y = 0; y < height; y++) {
      let sourceX = shift;
      for (let x = 0; x < width; x++) {
        table6.offsets[x + y * width] = sourceX + y * width;
        sourceX++;
        if (sourceX >= width) sourceX -= width;
      }
    }
    return table6;
  }
  if (config.effect === 7) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sourceX = x;
        let sourceY = y;
        if ((x & 2) === 0 && (y & 2) === 0) {
          sourceX = Math.trunc(width / 2 + ((x & ~1) - width / 2) * 7 / 8);
          sourceY = Math.trunc(height / 2 + ((y & ~1) - height / 2) * 7 / 8);
        }
        table6.offsets[x + y * width] = clamp7(sourceX, 0, width - 1) + clamp7(sourceY, 0, height - 1) * width;
      }
    }
    return table6;
  }
  if (state.program) buildEvaluatedTable(context2, state, table6, global);
  else if (config.effect >= 3 && config.effect <= 17) buildNativeTable(state, table6, width, height);
  else fillIdentity(table6, width, height);
  return table6;
}
function buildNativeTable(state, table6, width, height) {
  const halfWidth = Math.trunc(width / 2);
  const halfHeight = Math.trunc(height / 2);
  const maxDistance = Math.sqrt(width * width + height * height) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xd = x - halfWidth;
      const yd = y - halfHeight;
      let distance = Math.hypot(xd, yd);
      let angle = Math.atan2(yd, xd);
      let xOffset = 0;
      switch (state.config.effect) {
        case 3:
          angle += 0.1 - 0.2 * distance / maxDistance;
          distance *= 0.96;
          break;
        case 4:
          distance *= 0.99 * (1 - Math.sin(angle) / 32);
          angle += 0.03 * Math.sin(distance / maxDistance * Math.PI * 4);
          break;
        case 5:
          distance *= 0.94 + Math.cos(angle * 32) * 0.06;
          break;
        case 6:
          distance *= 1.01 + Math.cos(angle * 4) * 0.04;
          angle += 0.03 * Math.sin(distance / maxDistance * Math.PI * 4);
          break;
        case 8:
          angle += 0.1 * Math.sin(distance / maxDistance * Math.PI * 5);
          break;
        case 9: {
          const t = Math.sin(distance / maxDistance * Math.PI);
          distance -= 8 * t ** 5;
          break;
        }
        case 10: {
          const t = Math.sin(distance / maxDistance * Math.PI);
          distance -= 8 * t ** 5;
          const swirl = Math.cos(distance / maxDistance * Math.PI / 2);
          angle += 0.1 * swirl ** 3;
          break;
        }
        case 11:
          distance *= 0.95 + Math.cos(angle * 5 - Math.PI / 2.5) * 0.03;
          break;
        case 12:
          angle += 0.04;
          distance *= 0.96 + Math.cos(distance / maxDistance * Math.PI) * 0.05;
          break;
        case 13: {
          const t = Math.cos(distance / maxDistance * Math.PI);
          angle += 0.07 * t;
          distance *= 0.98 + t * 0.1;
          break;
        }
        case 14:
          angle += 0.1 - 0.2 * distance / maxDistance;
          distance *= 0.96;
          xOffset = 8;
          break;
        case 15:
          distance = maxDistance * 0.15;
          break;
        case 16:
          angle = Math.cos(angle * 3);
          break;
        case 17:
          distance *= 1 - (distance / maxDistance - 0.35) * 0.5;
          angle += 0.1;
          break;
      }
      const sampleX = halfWidth + Math.cos(angle) * distance + 0.5 + xOffset * width / 256;
      const sampleY = halfHeight + Math.sin(angle) * distance + 0.5;
      storeCoordinate(table6, x + y * width, sampleX, sampleY, width, height, state.config.wrap);
    }
  }
}
function buildEvaluatedTable(context2, state, table6, global) {
  const { width, height } = context2.input;
  const halfWidth = Math.trunc(width / 2);
  const halfHeight = Math.trunc(height / 2);
  const maxDistance = Math.sqrt(width * width + height * height) / 2;
  const vm = new AvsEelVm({ global, seed: state.randomState });
  vm.setHost({
    getosc: (band, span, channel) => avsAudioSample(context2.audio, "osc", band, span, channel),
    getspec: (band, span, channel) => avsAudioSample(context2.audio, "spec", band, span, channel)
  });
  vm.set("sw", width);
  vm.set("sh", height);
  const rectangular = state.config.effect === CUSTOM_EFFECT ? state.config.rectangular : EVALUATED_BUILTINS[state.config.effect]?.rectangular === true;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xd = x - halfWidth;
      const yd = y - halfHeight;
      vm.set("x", halfWidth === 0 ? 0 : xd / halfWidth);
      vm.set("y", halfHeight === 0 ? 0 : yd / halfHeight);
      vm.set("d", maxDistance === 0 ? 0 : Math.hypot(xd, yd) / maxDistance);
      vm.set("r", Math.atan2(yd, xd) + Math.PI / 2);
      vm.execute(state.program);
      let sampleX;
      let sampleY;
      if (rectangular) {
        sampleX = (vm.get("x") + 1) * halfWidth;
        sampleY = (vm.get("y") + 1) * halfHeight;
      } else {
        const distance = vm.get("d") * maxDistance;
        const angle = vm.get("r") - Math.PI / 2;
        sampleX = halfWidth + Math.cos(angle) * distance;
        sampleY = halfHeight + Math.sin(angle) * distance;
      }
      if (!table6.bilinear) {
        sampleX += 0.5;
        sampleY += 0.5;
      }
      storeCoordinate(table6, x + y * width, sampleX, sampleY, width, height, state.config.wrap);
    }
  }
}
function storeCoordinate(table6, destination, rawX, rawY, width, height, wrap) {
  if (!table6.bilinear) {
    let x2 = Math.trunc(rawX);
    let y2 = Math.trunc(rawY);
    if (wrap) {
      x2 = modulo4(x2, width);
      y2 = modulo4(y2, height);
    } else {
      x2 = clamp7(x2, 0, width - 1);
      y2 = clamp7(y2, 0, height - 1);
    }
    table6.offsets[destination] = x2 + y2 * width;
    return;
  }
  let x = Math.trunc(rawX);
  let y = Math.trunc(rawY);
  let xPartial = Math.trunc(32 * (rawX - x));
  let yPartial = Math.trunc(32 * (rawY - y));
  if (wrap) {
    x = modulo4(x, width - 1);
    y = modulo4(y, height - 1);
  } else {
    if (x < 0) {
      x = 0;
      xPartial = 0;
    } else if (x >= width - 1) {
      x = width - 2;
      xPartial = 31;
    }
    if (y < 0) {
      y = 0;
      yPartial = 0;
    } else if (y >= height - 1) {
      y = height - 2;
      yPartial = 31;
    }
  }
  const packed = (x + y * width | yPartial << 22 | xPartial << 27) >>> 0;
  table6.offsets[destination] = packed & OFFSET_MASK;
  table6.xWeights[destination] = packed >>> 24 & 31 << 3;
  table6.yWeights[destination] = packed >>> 19 & 31 << 3;
}
function renderInverse(context2, table6, blend2) {
  const source = context2.input.pixels;
  const output = context2.output.pixels;
  const width = context2.input.width;
  if (table6.bilinear) {
    if (blend2) {
      for (let i = 0; i < output.length; i++) {
        output[i] = averagePixel3(source[i], sampleBilinear(
          source,
          table6.offsets[i],
          width,
          table6.xWeights[i],
          table6.yWeights[i]
        ));
      }
    } else {
      for (let i = 0; i < output.length; i++) {
        output[i] = sampleBilinear(source, table6.offsets[i], width, table6.xWeights[i], table6.yWeights[i]);
      }
    }
  } else if (blend2) {
    for (let i = 0; i < output.length; i++) output[i] = averagePixel3(source[i], source[table6.offsets[i]]);
  } else {
    for (let i = 0; i < output.length; i++) output[i] = source[table6.offsets[i]];
  }
}
function renderForward(context2, table6, blend2) {
  const source = context2.input.pixels;
  const output = context2.output.pixels;
  if (blend2) output.set(source);
  else output.fill(0);
  for (let i = 0; i < source.length; i++) {
    const destination = table6.offsets[i];
    output[destination] = maximumPixel2(source[i], output[destination]);
  }
  if (blend2) {
    for (let i = 0; i < output.length; i++) output[i] = averagePixel3(output[i], source[i]);
  }
}
function sampleBilinear(source, offset, width, xp, yp) {
  const blendTable = AVS_BLEND_TABLE;
  const inverseX = 255 - xp;
  const inverseY = 255 - yp;
  const w0 = blendTable[inverseX << 8 | inverseY];
  const w1 = blendTable[xp << 8 | inverseY];
  const w2 = blendTable[inverseX << 8 | yp];
  const w3 = blendTable[xp << 8 | yp];
  const p0 = source[offset];
  const p1 = source[offset + 1];
  const p2 = source[offset + width];
  const p3 = source[offset + width + 1];
  const low = blendTable[(p0 & 255) << 8 | w0] + blendTable[(p1 & 255) << 8 | w1] + blendTable[(p2 & 255) << 8 | w2] + blendTable[(p3 & 255) << 8 | w3];
  const middle = blendTable[(p0 >>> 8 & 255) << 8 | w0] + blendTable[(p1 >>> 8 & 255) << 8 | w1] + blendTable[(p2 >>> 8 & 255) << 8 | w2] + blendTable[(p3 >>> 8 & 255) << 8 | w3];
  const high = blendTable[(p0 >>> 16 & 255) << 8 | w0] + blendTable[(p1 >>> 16 & 255) << 8 | w1] + blendTable[(p2 >>> 16 & 255) << 8 | w2] + blendTable[(p3 >>> 16 & 255) << 8 | w3];
  return low & 255 | (middle & 255) << 8 | (high & 255) << 16;
}
function fillIdentity(table6, width, height) {
  for (let i = 0; i < width * height; i++) table6.offsets[i] = i;
}
function averagePixel3(a, b) {
  return (a >>> 1 & 8355711) + (b >>> 1 & 8355711) & 16777215;
}
function maximumPixel2(a, b) {
  return Math.max(a & 255, b & 255) | Math.max(a >>> 8 & 255, b >>> 8 & 255) << 8 | Math.max(a >>> 16 & 255, b >>> 16 & 255) << 16;
}
function nextRandom3(state) {
  let x = state.randomState || 1831565813;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.randomState = x >>> 0;
  return state.randomState;
}
function modulo4(value, modulus) {
  if (modulus <= 0) return 0;
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
}
function readI322(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function asciiEquals(payload, offset, value) {
  if (offset + value.length > payload.length) return false;
  for (let i = 0; i < value.length; i++) if (payload[offset + i] !== value.charCodeAt(i)) return false;
  return true;
}
function nulText5(bytes) {
  const end = bytes.indexOf(0);
  return TEXT4.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp7(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath7(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/low-count-builtins.ts
function registerAvsLowCountBuiltins(registry = new AvsEffectRegistry()) {
  const simpleStates = /* @__PURE__ */ new Map();
  const ringStates = /* @__PURE__ */ new Map();
  const gridStates = /* @__PURE__ */ new Map();
  const grainStates = /* @__PURE__ */ new Map();
  registry.registerBuiltin(0, (context2) => {
    if (context2.preinit) return;
    const colors = colorList(context2, 4);
    if (colors.length === 0) return;
    const state = simpleStates.get(context2.component.path) ?? { colorPosition: 0 };
    simpleStates.set(context2.component.path, state);
    const color = cycleColor(colors, state);
    renderSimple(context2, int5(context2, 0, 40), color);
  });
  registry.registerBuiltin(14, (context2) => {
    if (context2.preinit) return;
    const count = int5(context2, 4, 1);
    const colors = readColors(context2, 8, count);
    if (colors.length === 0) return;
    const state = ringStates.get(context2.component.path) ?? { colorPosition: 0 };
    ringStates.set(context2.component.path, state);
    const tail = 8 + colors.length * 4;
    renderRing(context2, int5(context2, 0, 40), cycleColor(colors, state), int5(context2, tail, 8), int5(context2, tail + 4, 0));
  });
  registry.registerBuiltin(17, (context2) => {
    if (context2.preinit) return;
    const colors = colorList(context2, 0);
    if (colors.length === 0) return;
    let state = gridStates.get(context2.component.path);
    if (!state) {
      state = { colorPosition: 0, x: 0, y: 0 };
      gridStates.set(context2.component.path, state);
    }
    const tail = 4 + colors.length * 4;
    const spacing = Math.max(2, int5(context2, tail, 8));
    while (state.x < 0) state.x += spacing * 256;
    while (state.y < 0) state.y += spacing * 256;
    const sx = (state.x >>> 8) % spacing;
    const sy = (state.y >>> 8) % spacing;
    const color = cycleColor(colors, state);
    const blend2 = int5(context2, tail + 12, 3);
    for (let y = sy; y < context2.input.height; y += spacing) for (let x = sx; x < context2.input.width; x += spacing) {
      const index = x + y * context2.input.width;
      const destination = context2.input.pixels[index];
      context2.input.pixels[index] = blend2 === 1 ? blendPixel(color, destination, "additive") : blend2 === 2 ? blendPixel(color, destination, "average") : blend2 === 3 ? blendLine(color, destination, context2.line.blendMode, context2.line.adjustableAlpha) : color;
    }
    state.x += int5(context2, tail + 4, 128);
    state.y += int5(context2, tail + 8, 128);
  });
  registry.registerBuiltin(24, (context2) => {
    if (context2.preinit || int5(context2, 0, 1) === 0) return;
    let state = grainStates.get(context2.component.path);
    if (!state || state.width !== context2.input.width || state.height !== context2.input.height) {
      const random = hashPath8(context2.component.path);
      state = { width: context2.input.width, height: context2.input.height, depth: new Uint8Array(context2.input.pixels.length * 2), random };
      for (let i = 0; i < state.depth.length; i += 2) {
        state.random = xorshift322(state.random);
        state.depth[i] = state.random % 255;
        state.random = xorshift322(state.random);
        state.depth[i + 1] = state.random % 100;
      }
      grainStates.set(context2.component.path, state);
    }
    const staticGrain = int5(context2, 16, 0) !== 0;
    const threshold = Math.trunc(int5(context2, 12, 100) * 255 / 100);
    for (let i = 0; i < context2.input.pixels.length; i++) {
      const pixel = context2.input.pixels[i];
      if (pixel === 0) continue;
      let gate;
      let scale;
      if (staticGrain) {
        scale = state.depth[i * 2];
        gate = state.depth[i * 2 + 1];
      } else {
        state.random = xorshift322(state.random);
        gate = state.random & 255;
        state.random = xorshift322(state.random);
        scale = state.random & 255;
      }
      const grain = gate < threshold ? scalePixel(pixel, scale) : 0;
      context2.input.pixels[i] = int5(context2, 4, 0) !== 0 ? blendPixel(grain, pixel, "additive") : int5(context2, 8, 0) !== 0 ? blendPixel(grain, pixel, "average") : grain;
    }
  });
  return registry;
}
function renderSimple(context2, effect, color) {
  const width = context2.input.width;
  const height = context2.input.height;
  const yScale = height / 512;
  const channel = effect >>> 2 & 3;
  const vertical = effect >>> 4 & 3;
  const source = (effect & 3) > 1 ? context2.audio.waveform : context2.audio.spectrum;
  const data = selectChannel(source, channel);
  const point = (x, y) => plot(context2, x, y, color);
  if ((effect & 64) !== 0) {
    if ((effect & 2) !== 0) {
      const center = vertical === 2 ? height / 4 : vertical * height / 2;
      for (let x = 0; x < width; x++) point(x, Math.trunc(center + interpolateSigned(data, x * 288 / width) * yScale));
    } else {
      const { center, scale, adjust } = analyzerVertical(vertical, height, yScale);
      for (let x = 0; x < width; x++) point(x, Math.trunc(center + adjust + interpolate(data, x * 200 / width) * scale - 1));
    }
    return;
  }
  switch (effect & 3) {
    case 0: {
      const { center, scale, adjust } = analyzerVertical(vertical, height, yScale);
      for (let x = 0; x < width; x++) drawLine(context2, x, center - adjust, x, Math.trunc(center + adjust + interpolate(data, x * 200 / width) * scale - 1), color);
      break;
    }
    case 1: {
      const { center, scale } = analyzerVertical(vertical, height, yScale);
      let lx = 0, ly = Math.trunc(center + data[0] * scale);
      for (let x = 1; x < 200; x++) {
        const ox = Math.trunc(x * width / 200);
        const oy = Math.trunc(center + data[x] * scale);
        drawLine(context2, lx, ly, ox, oy, color);
        lx = ox;
        ly = oy;
      }
      break;
    }
    case 2: {
      const center = vertical === 2 ? height / 4 : vertical * height / 2;
      let lx = 0, ly = Math.trunc(center + (data[0] ^ 128) * yScale);
      for (let x = 1; x < 288; x++) {
        const ox = Math.trunc(x * width / 288);
        const oy = Math.trunc(center + (data[x] ^ 128) * yScale);
        drawLine(context2, lx, ly, ox, oy, color);
        lx = ox;
        ly = oy;
      }
      break;
    }
    case 3: {
      const center = vertical === 2 ? height / 4 : vertical * height / 2;
      const start = Math.trunc(center + yScale * 128) - 1;
      for (let x = 0; x < width; x++) drawLine(context2, x, start, x, Math.trunc(center + interpolateSigned(data, x * 288 / width) * yScale), color);
      break;
    }
  }
}
function renderRing(context2, effect, color, size, spectrumMode) {
  const channel = effect >>> 2 & 3;
  const horizontal = effect >>> 4;
  const source = spectrumMode ? context2.audio.spectrum : context2.audio.waveform;
  const data = selectChannel(source, channel);
  const radius = Math.min(context2.input.height * size / 32, context2.input.width * size / 32);
  const cx = horizontal === 2 ? context2.input.width / 2 : horizontal === 0 ? context2.input.width / 4 : context2.input.width * 3 / 4;
  const cy = context2.input.height / 2;
  const amplitude = (q) => spectrumMode ? 0.1 + (data[q * 2] / 2 + data[q * 2 + 1] / 2) / 255 * 0.9 : 0.1 + (data[q] ^ 128) / 255 * 0.9;
  let lastX = Math.trunc(cx + radius * amplitude(0));
  let lastY = Math.trunc(cy);
  for (let q = 1; q <= 80; q++) {
    const index = q > 40 ? 80 - q : q;
    const angle = -Math.PI * 2 * q / 80;
    const scale = amplitude(index);
    const x = Math.trunc(cx + Math.cos(angle) * radius * scale);
    const y = Math.trunc(cy + Math.sin(angle) * radius * scale);
    drawLine(context2, x, y, lastX, lastY, color);
    lastX = x;
    lastY = y;
  }
}
function colorList(context2, offset) {
  return readColors(context2, offset + 4, int5(context2, offset, 1));
}
function readColors(context2, offset, count) {
  if (count < 1 || count > 16) return [];
  const result = [];
  for (let i = 0; i < count && offset + i * 4 + 4 <= context2.component.payload.length; i++) result.push(int5(context2, offset + i * 4, 0) & 16777215);
  return result;
}
function cycleColor(colors, state) {
  state.colorPosition = (state.colorPosition + 1) % (colors.length * 64);
  const index = Math.trunc(state.colorPosition / 64);
  const fraction = state.colorPosition & 63;
  return channels23(colors[index], colors[(index + 1) % colors.length], (a, b) => Math.trunc((a * (63 - fraction) + b * fraction) / 64));
}
function selectChannel(source, channel) {
  if (channel < 2) return source[channel];
  const center = new Uint8Array(576);
  for (let i = 0; i < 576; i++) center[i] = Math.trunc(signed(source[0][i]) / 2) + Math.trunc(signed(source[1][i]) / 2) & 255;
  return center;
}
function analyzerVertical(position, height, yScale) {
  let center = height / 2, scale = yScale, adjust = 1;
  if (position !== 1) {
    scale = -scale;
    adjust = 0;
  }
  if (position === 2) center -= scale * 128;
  return { center: Math.trunc(center), scale, adjust };
}
function interpolate(data, at) {
  const i = Math.trunc(at), f = at - i;
  return data[i] * (1 - f) + data[i + 1] * f;
}
function interpolateSigned(data, at) {
  const i = Math.trunc(at), f = at - i;
  return (data[i] ^ 128) * (1 - f) + (data[i + 1] ^ 128) * f;
}
function signed(value) {
  return value << 24 >> 24;
}
function plot(context2, x, y, color) {
  x = Math.trunc(x);
  y = Math.trunc(y);
  if (x < 0 || y < 0 || x >= context2.input.width || y >= context2.input.height) return;
  const index = x + y * context2.input.width;
  context2.input.pixels[index] = blendLine(color, context2.input.pixels[index], context2.line.blendMode, context2.line.adjustableAlpha);
}
function drawLine(context2, x0, y0, x1, y1, color) {
  x0 = Math.trunc(x0);
  y0 = Math.trunc(y0);
  x1 = Math.trunc(x1);
  y1 = Math.trunc(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  while (x0 !== x1 || y0 !== y1) {
    plot(context2, x0, y0, color);
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x0 += sx;
    }
    if (twice <= dx) {
      error += dx;
      y0 += sy;
    }
  }
}
function scalePixel(pixel, scale) {
  return channels23(pixel, 0, (value) => value * scale >>> 8);
}
function channels23(a, b, fn) {
  return fn(a & 255, b & 255) | fn(a >>> 8 & 255, b >>> 8 & 255) << 8 | fn(a >>> 16 & 255, b >>> 16 & 255) << 16;
}
function int5(context2, offset, fallback) {
  return offset + 4 <= context2.component.payload.length ? new DataView(context2.component.payload.buffer, context2.component.payload.byteOffset, context2.component.payload.byteLength).getInt32(offset, true) : fallback;
}
function hashPath8(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}
function xorshift322(value) {
  let state = value || 1831565813;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

// src/avs/effects/multifilter.ts
var AVS_MULTIFILTER_APE_ID = "Jheriko : MULTIFILTER";
function decodeAvsMultiFilterConfig(payload) {
  const native = new Uint8Array(16);
  const view = new DataView(native.buffer);
  view.setInt32(0, 1, true);
  if (payload.length <= native.length) native.set(payload);
  return {
    enabled: view.getInt32(0, true) !== 0,
    effect: view.getInt32(4, true),
    toggleOnBeat: view.getInt32(8, true) !== 0,
    reactiveAlpha: view.getInt32(12, true) !== 0
  };
}
function registerAvsMultiFilter(registry = new AvsEffectRegistry()) {
  let toggleState = false;
  registry.registerApe(AVS_MULTIFILTER_APE_ID, (context2) => {
    const config = decodeAvsMultiFilterConfig(context2.component.payload);
    if (!config.enabled) return;
    if (config.toggleOnBeat && (context2.beat || context2.preinit)) toggleState = !toggleState;
    if (config.toggleOnBeat && !toggleState && !config.reactiveAlpha) return;
    if (config.effect >= 0 && config.effect <= 2) {
      if (config.reactiveAlpha) return;
      chrome(context2, config.effect + 1);
      return;
    }
    if (config.effect === 3) return infiniteRootBorder(context2);
  });
  return registry;
}
function chrome(context2, repetitions) {
  for (let index = 0; index < context2.input.pixels.length; index++) {
    let pixel = context2.input.pixels[index];
    for (let pass = 0; pass < repetitions; pass++) {
      let next = 0;
      for (let shift = 0; shift <= 24; shift += 8) {
        const value = pixel >>> shift & 255;
        const doubled = Math.min(255, value + value);
        const folded = Math.max(0, doubled - value);
        next |= Math.min(255, folded + folded) << shift;
      }
      pixel = next >>> 0;
    }
    context2.input.pixels[index] = pixel;
  }
}
function infiniteRootBorder(context2) {
  const source = context2.input.pixels;
  const target = context2.output.pixels;
  const width = context2.input.width;
  for (let y = 0; y < context2.input.height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      target[index] = 0;
      if ((source[index] | 0) > 0) {
        target[index] = 4294967295;
        if (x > 0) target[index - 1] = 4294967295;
        if (y > 0) target[index - width] = 4294967295;
      }
    }
  }
  return { swap: true };
}

// src/avs/effects/named-apes.ts
var AVS_CHANNEL_SHIFT_APE_ID = "Channel Shift";
var AVS_COLOR_REDUCTION_APE_ID = "Color Reduction";
var AVS_MULTIPLIER_APE_ID = "Multiplier";
var CHANNEL_MODES = [1183, 1020, 1018, 1022, 1019, 1021];
function decodeAvsChannelShift(payload) {
  const native = new Uint8Array(8);
  const view = new DataView(native.buffer);
  view.setInt32(0, 1020, true);
  view.setInt32(4, 1, true);
  if (payload.length <= native.length) native.set(payload);
  return {
    mode: view.getInt32(0, true),
    randomizeOnBeat: view.getInt32(4, true) !== 0
  };
}
function decodeAvsColorReduction(payload) {
  if (payload.length !== 264) return { legacyFilename: "", levels: 0 };
  return {
    legacyFilename: nulText6(payload.subarray(0, 260)),
    levels: readI323(payload, 260, 0)
  };
}
function decodeAvsMultiplier(payload) {
  return { mode: payload.length === 4 ? readI323(payload, 0, 0) : 0 };
}
function registerAvsNamedApeEffects(registry = new AvsEffectRegistry()) {
  const shifts = /* @__PURE__ */ new Map();
  registry.registerApe(AVS_CHANNEL_SHIFT_APE_ID, (context2) => {
    if (context2.preinit) return;
    const config = decodeAvsChannelShift(context2.component.payload);
    let state = shifts.get(context2.component.path);
    if (!state) {
      state = { mode: config.mode, randomState: hashPath9(context2.component.path) };
      shifts.set(context2.component.path, state);
    }
    if (context2.beat && config.randomizeOnBeat) {
      state.randomState = xorshift323(state.randomState);
      state.mode = CHANNEL_MODES[state.randomState % CHANNEL_MODES.length];
    }
    shiftChannels(context2, state.mode);
  });
  registry.registerApe(AVS_COLOR_REDUCTION_APE_ID, (context2) => {
    if (context2.preinit) return;
    reduceColors(context2, decodeAvsColorReduction(context2.component.payload).levels);
  });
  registry.registerApe(AVS_MULTIPLIER_APE_ID, (context2) => {
    if (context2.preinit) return;
    multiplyColors(context2, decodeAvsMultiplier(context2.component.payload).mode);
  });
  return registry;
}
function shiftChannels(context2, mode) {
  if (mode === 1183 || !CHANNEL_MODES.includes(mode)) return;
  for (let i = 0; i < context2.input.pixels.length; i++) {
    const pixel = context2.input.pixels[i];
    const red = pixel >>> 16 & 255;
    const green = pixel >>> 8 & 255;
    const blue = pixel & 255;
    let next;
    switch (mode) {
      case 1020:
        next = [red, blue, green];
        break;
      // RBG
      case 1018:
        next = [green, blue, red];
        break;
      // GBR
      case 1022:
        next = [green, red, blue];
        break;
      // GRB
      case 1019:
        next = [blue, red, green];
        break;
      // BRG
      case 1021:
        next = [blue, green, red];
        break;
      // BGR
      default:
        next = [red, green, blue];
        break;
    }
    context2.input.pixels[i] = next[0] << 16 | next[1] << 8 | next[2];
  }
}
function reduceColors(context2, rawLevels) {
  const levels = clamp8(Math.trunc(rawLevels), 0, 8);
  const mask = levels === 0 ? 0 : 255 << 8 - levels & 255;
  const rgbMask = mask | mask << 8 | mask << 16;
  for (let i = 4; i < context2.input.pixels.length; i++) {
    context2.input.pixels[i] = context2.input.pixels[i] & rgbMask;
  }
}
function multiplyColors(context2, mode) {
  const pixels = context2.input.pixels;
  if (mode === 0 || mode === 7) {
    for (let i = pixels.length - 1; i >= 1; i--) {
      const pixel = pixels[i] & 16777215;
      pixels[i] = mode === 0 ? pixel === 0 ? 0 : 16777215 : pixel === 16777215 ? 16777215 : 0;
    }
    return;
  }
  if (mode < 1 || mode > 6) return;
  const end = pixels.length - (pixels.length & 1);
  for (let i = 0; i < end; i++) {
    const pixel = pixels[i];
    if (mode <= 3) {
      const factor = 1 << 4 - mode;
      pixels[i] = channels3(pixel, (value) => Math.min(255, value * factor));
    } else {
      const shift = mode - 3;
      pixels[i] = channels3(pixel, (value) => value >>> shift);
    }
  }
}
function channels3(pixel, fn) {
  const blue = fn(pixel & 255);
  const green = fn(pixel >>> 8 & 255);
  const red = fn(pixel >>> 16 & 255);
  return blue | green << 8 | red << 16;
}
function readI323(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function nulText6(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder("windows-1252").decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp8(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath9(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}
function xorshift323(value) {
  let state = value || 1831565813;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

// src/avs/effects/scripted-transforms.ts
var TEXT5 = new TextDecoder("windows-1252");
function decodeAvsDynamicColorModifier(payload) {
  const decoded = decodeScripts(payload, 4);
  return {
    level: decoded.scripts[0],
    frame: decoded.scripts[1],
    beat: decoded.scripts[2],
    init: decoded.scripts[3],
    recompute: i327(payload, decoded.offset, 1) !== 0
  };
}
function decodeAvsDynamicShift(payload) {
  const decoded = decodeScripts(payload, 3);
  return {
    init: decoded.scripts[0],
    frame: decoded.scripts[1],
    beat: decoded.scripts[2],
    blend: i327(payload, decoded.offset, 0) !== 0,
    subpixel: i327(payload, decoded.offset + 4, 1) !== 0
  };
}
function decodeAvsDynamicDistanceModifier(payload) {
  const decoded = decodeScripts(payload, 4);
  return {
    point: decoded.scripts[0],
    frame: decoded.scripts[1],
    beat: decoded.scripts[2],
    init: decoded.scripts[3],
    blend: i327(payload, decoded.offset, 0) !== 0,
    subpixel: i327(payload, decoded.offset + 4, 0) !== 0
  };
}
function decodeAvsUniqueTone(payload) {
  return {
    enabled: i327(payload, 0, 1) !== 0,
    color: i327(payload, 4, 16777215) & 16777215,
    additive: i327(payload, 8, 0) !== 0,
    average: i327(payload, 12, 0) !== 0,
    invert: i327(payload, 16, 0) !== 0
  };
}
function registerAvsScriptedTransforms(registry) {
  registerDynamicColorModifier(registry);
  registerDynamicShift(registry);
  registerDynamicDistanceModifier(registry);
  registerUniqueTone(registry);
  return registry;
}
function registerDynamicColorModifier(registry) {
  const states = /* @__PURE__ */ new Map();
  registry.registerBuiltin(45, (context2) => {
    const config = decodeAvsDynamicColorModifier(context2.component.payload);
    let state = states.get(context2.component.path);
    if (!state) {
      state = {
        vm: createVm(registry, context2.component.path),
        programs: compilePrograms([config.level, config.frame, config.beat, config.init]),
        initialized: false,
        red: new Uint8Array(256),
        green: new Uint8Array(256),
        blue: new Uint8Array(256),
        tableValid: false
      };
      states.set(context2.component.path, state);
    }
    if (context2.preinit) return;
    configureVm2(state.vm, context2);
    state.vm.set("beat", context2.beat ? 1 : 0);
    if (!state.initialized) {
      execute4(state.programs[3], state.vm);
      state.initialized = true;
    }
    execute4(state.programs[1], state.vm);
    if (context2.beat) execute4(state.programs[2], state.vm);
    if (config.recompute || !state.tableValid) {
      for (let value = 0; value < 256; value++) {
        const normalized = value / 255;
        state.vm.set("red", normalized);
        state.vm.set("green", normalized);
        state.vm.set("blue", normalized);
        execute4(state.programs[0], state.vm);
        state.red[value] = eelChannel(state.vm.get("red"));
        state.green[value] = eelChannel(state.vm.get("green"));
        state.blue[value] = eelChannel(state.vm.get("blue"));
      }
      state.tableValid = true;
    }
    const pixels = context2.input.pixels;
    for (let i = 0; i < pixels.length; i++) {
      const pixel = pixels[i];
      pixels[i] = state.blue[pixel & 255] | state.green[pixel >>> 8 & 255] << 8 | state.red[pixel >>> 16 & 255] << 16;
    }
  });
}
function registerDynamicShift(registry) {
  const states = /* @__PURE__ */ new Map();
  registry.registerBuiltin(42, (context2) => {
    const config = decodeAvsDynamicShift(context2.component.payload);
    let state = states.get(context2.component.path);
    if (!state) {
      state = {
        vm: createVm(registry, context2.component.path),
        programs: compilePrograms([config.init, config.frame, config.beat]),
        initialized: false,
        width: 0,
        height: 0
      };
      states.set(context2.component.path, state);
    }
    configureVm2(state.vm, context2);
    state.vm.set("w", context2.input.width);
    state.vm.set("h", context2.input.height);
    state.vm.set("b", context2.beat ? 1 : 0);
    if (context2.preinit) return;
    if (!state.initialized || state.width !== context2.input.width || state.height !== context2.input.height) {
      state.width = context2.input.width;
      state.height = context2.input.height;
      state.vm.set("x", 0);
      state.vm.set("y", 0);
      state.vm.set("alpha", 0.5);
      execute4(state.programs[0], state.vm);
      state.initialized = true;
    }
    execute4(state.programs[1], state.vm);
    if (context2.beat) execute4(state.programs[2], state.vm);
    let doBlend = config.blend;
    const alpha = Math.trunc(state.vm.get("alpha") * 255);
    if (doBlend && alpha <= 0) return;
    if (doBlend && alpha >= 255) doBlend = false;
    if (config.subpixel && context2.input.width > 1 && context2.input.height > 1) {
      renderSubpixelShift(context2, state.vm.get("x"), state.vm.get("y"), doBlend, alpha);
    } else {
      renderNearestShift(context2, Math.trunc(state.vm.get("x")), Math.trunc(state.vm.get("y")), doBlend, alpha);
    }
    return { swap: true };
  });
}
function renderNearestShift(context2, shiftX, shiftY, blend2, alpha) {
  const { width, height } = context2.input;
  const source = context2.input.pixels;
  const output = context2.output.pixels;
  for (let y = 0; y < height; y++) {
    const sourceY = y - shiftY;
    for (let x = 0; x < width; x++) {
      const index = x + y * width;
      const sourceX = x - shiftX;
      const shifted = sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height ? source[sourceX + sourceY * width] : 0;
      output[index] = blend2 ? blendPixel(shifted, source[index], "adjustable", alpha) : shifted;
    }
  }
}
function renderSubpixelShift(context2, vx, vy, blend2, alpha) {
  const { width, height } = context2.input;
  const source = context2.input.pixels;
  const output = context2.output.pixels;
  let shiftX = Math.trunc(vx);
  let shiftY = Math.trunc(vy);
  let xPartial = Math.trunc((vx - shiftX) * 255);
  let yPartial = Math.trunc((vy - shiftY) * 255);
  if (xPartial < 0) xPartial = -xPartial;
  else {
    shiftX++;
    xPartial = 255 - xPartial;
  }
  if (yPartial < 0) yPartial = -yPartial;
  else {
    shiftY++;
    yPartial = 255 - yPartial;
  }
  xPartial = clamp9(xPartial, 0, 255);
  yPartial = clamp9(yPartial, 0, 255);
  shiftX = clamp9(shiftX, 1 - width, width - 1);
  shiftY = clamp9(shiftY, 1 - height, height - 1);
  const endX = clamp9(width - 1 + shiftX, 0, width - 1);
  const endY = clamp9(height - 1 + shiftY, 0, height - 1);
  const startX = Math.max(0, shiftX);
  const startY = Math.max(0, shiftY);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = x + y * width;
      let shifted = 0;
      if (x >= startX && x < endX && y >= startY && y < endY) {
        const sourceX = x - shiftX;
        const sourceY = y - shiftY;
        shifted = sampleBilinear2(source, sourceX + sourceY * width, width, xPartial, yPartial);
      }
      output[index] = blend2 ? blendPixel(shifted, source[index], "adjustable", alpha) : shifted;
    }
  }
}
function registerDynamicDistanceModifier(registry) {
  const states = /* @__PURE__ */ new Map();
  registry.registerBuiltin(35, (context2) => {
    const config = decodeAvsDynamicDistanceModifier(context2.component.payload);
    let state = states.get(context2.component.path);
    if (!state) {
      state = {
        vm: createVm(registry, context2.component.path),
        programs: compilePrograms([config.point, config.frame, config.beat, config.init]),
        initialized: false
      };
      states.set(context2.component.path, state);
    }
    if (context2.preinit) return;
    configureVm2(state.vm, context2);
    state.vm.set("b", context2.beat ? 1 : 0);
    if (!state.initialized) {
      execute4(state.programs[3], state.vm);
      state.initialized = true;
    }
    execute4(state.programs[1], state.vm);
    if (context2.beat) execute4(state.programs[2], state.vm);
    renderDynamicDistance(context2, config, state);
    return { swap: true };
  });
}
function renderDynamicDistance(context2, config, state) {
  const { width, height } = context2.input;
  const maxDistance = Math.sqrt((width * width + height * height) / 4);
  const tableLength = Math.max(33, Math.trunc(maxDistance + 32.9));
  const distanceTable = new Int32Array(tableLength);
  if (state.programs[0]) {
    const computed = tableLength - 32;
    for (let distance = 0; distance < computed; distance++) {
      state.vm.set("d", distance / (maxDistance - 1));
      execute4(state.programs[0], state.vm);
      distanceTable[distance] = Math.trunc(state.vm.get("d") * 256 * maxDistance / (distance + 1));
    }
    const last = distanceTable[Math.max(0, computed - 1)];
    for (let distance = computed; distance < tableLength; distance++) distanceTable[distance] = last;
  }
  const source = context2.input.pixels;
  const output = context2.output.pixels;
  const halfWidth = Math.trunc(width / 2);
  const halfHeight = Math.trunc(height / 2);
  const bilinear3 = config.subpixel && width > 1 && height > 1;
  for (let y = 0; y < height; y++) {
    const relativeY = y - halfHeight;
    let radiusSquared = halfWidth * halfWidth + halfWidth + relativeY * relativeY + 256;
    let radiusDelta = -2 * halfWidth;
    let relativeX = -halfWidth;
    for (let x = 0; x < width; x++) {
      const scale = distanceTable[Math.min(tableLength - 1, avsIntegerSquareRoot(radiusSquared))];
      const scaledX = scale * relativeX + 128;
      const scaledY = scale * relativeY + 128;
      let sourceX = halfWidth + (scaledX >> 8);
      let sourceY = halfHeight + (scaledY >> 8);
      let sampled;
      if (bilinear3) {
        sourceX = clamp9(sourceX, 0, width - 2);
        sourceY = clamp9(sourceY, 0, height - 2);
        sampled = sampleBilinear2(source, sourceX + sourceY * width, width, scaledX & 255, scaledY & 255);
      } else {
        sourceX = clamp9(sourceX, 0, width - 1);
        sourceY = clamp9(sourceY, 0, height - 1);
        sampled = source[sourceX + sourceY * width];
      }
      const index = x + y * width;
      output[index] = config.blend ? averagePixel4(sampled, source[index]) : sampled;
      radiusSquared += radiusDelta;
      radiusDelta += 2;
      relativeX++;
    }
  }
}
function registerUniqueTone(registry) {
  registry.registerBuiltin(38, (context2) => {
    const config = decodeAvsUniqueTone(context2.component.payload);
    if (!config.enabled || context2.preinit) return;
    const red = config.color >>> 16 & 255;
    const green = config.color >>> 8 & 255;
    const blue = config.color & 255;
    const pixels = context2.input.pixels;
    for (let i = 0; i < pixels.length; i++) {
      const original = pixels[i];
      let depth = Math.max(original & 255, original >>> 8 & 255, original >>> 16 & 255);
      if (config.invert) depth = 255 - depth;
      const tone = table5(depth, blue) | table5(depth, green) << 8 | table5(depth, red) << 16;
      pixels[i] = config.additive ? blendPixel(tone, original, "additive") : config.average ? averagePixel4(original, tone) : tone;
    }
  });
}
function createVm(registry, path) {
  return new AvsEelVm({ global: registry.eelGlobal, seed: hashPath10(path) });
}
function configureVm2(vm, context2) {
  vm.setHost({
    getosc: (band, width, channel) => avsAudioSample(context2.audio, "osc", band, width, channel),
    getspec: (band, width, channel) => avsAudioSample(context2.audio, "spec", band, width, channel)
  });
}
function decodeScripts(payload, count) {
  const scripts = new Array(count).fill("");
  if (payload[0] === 1) {
    let offset = 1;
    for (let i = 0; i < count; i++) {
      if (offset + 4 > payload.length) return { scripts, offset: payload.length };
      const length = i327(payload, offset, 0);
      offset += 4;
      if (length > 0 && offset + length <= payload.length) {
        scripts[i] = nulText7(payload.subarray(offset, offset + length));
        offset += length;
      }
    }
    return { scripts, offset };
  }
  const bytes = count * 256;
  if (payload.length >= bytes) {
    for (let i = 0; i < count; i++) scripts[i] = nulText7(payload.subarray(i * 256, (i + 1) * 256));
    return { scripts, offset: bytes };
  }
  return { scripts, offset: 0 };
}
function compilePrograms(sources) {
  return sources.map((source) => {
    if (!source.trim()) return null;
    try {
      return compileAvsEel(source);
    } catch {
      return null;
    }
  });
}
function execute4(program, vm) {
  return program ? vm.execute(program) : 0;
}
function avsIntegerSquareRoot(value) {
  const n = value >>> 0;
  const sq = (index) => Math.trunc(Math.sqrt(index) * 16);
  if (n >= 65536) {
    if (n >= 16777216) {
      if (n >= 268435456) return n >= 1073741824 ? sq(n >>> 24) << 8 : sq(n >>> 22) << 7;
      return n >= 67108864 ? sq(n >>> 20) << 6 : sq(n >>> 18) << 5;
    }
    if (n >= 1048576) return n >= 4194304 ? sq(n >>> 16) << 4 : sq(n >>> 14) << 3;
    return n >= 262144 ? sq(n >>> 12) << 2 : sq(n >>> 10) << 1;
  }
  if (n >= 256) {
    if (n >= 4096) return n >= 16384 ? sq(n >>> 8) : sq(n >>> 6) >>> 1;
    return n >= 1024 ? sq(n >>> 4) >>> 2 : sq(n >>> 2) >>> 3;
  }
  return Math.trunc(Math.sqrt(n));
}
function sampleBilinear2(source, offset, width, xp, yp) {
  const weights = [table5(255 - xp, 255 - yp), table5(xp, 255 - yp), table5(255 - xp, yp), table5(xp, yp)];
  const pixels = [source[offset], source[offset + 1], source[offset + width], source[offset + width + 1]];
  let result = 0;
  for (let shift = 0; shift <= 16; shift += 8) {
    let value = 0;
    for (let i = 0; i < 4; i++) value += table5(pixels[i] >>> shift & 255, weights[i]);
    result |= (value & 255) << shift;
  }
  return result;
}
function eelChannel(value) {
  return clamp9(Math.trunc(value * 255 + 0.5), 0, 255);
}
function averagePixel4(a, b) {
  return (a >>> 1 & 8355711) + (b >>> 1 & 8355711) & 16777215;
}
function table5(x, y) {
  return Math.trunc(x / 255 * y);
}
function i327(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function nulText7(bytes) {
  const end = bytes.indexOf(0);
  return TEXT5.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp9(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath10(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/superscope.ts
var TEXT6 = new TextDecoder("windows-1252");
var MAX_POINTS = 128 * 1024;
function decodeAvsSuperScope(payload) {
  let offset = 0;
  let scripts = ["", "", "", ""];
  if (payload[0] === 1) {
    offset = 1;
    for (let i = 0; i < 4; i++) {
      const decoded = readString3(payload, offset);
      scripts[i] = decoded.value;
      offset = decoded.next;
    }
  } else if (payload.length >= 1024) {
    scripts = [0, 256, 512, 768].map((start) => nulText8(payload.subarray(start, start + 256)));
    offset = 1024;
  }
  const channel = readI324(payload, offset, 2);
  offset += 4;
  const declaredColors = readI324(payload, offset, 1);
  offset += 4;
  const colors = [];
  if (declaredColors >= 0 && declaredColors <= 16) {
    for (let i = 0; i < declaredColors && offset + 4 <= payload.length; i++, offset += 4) {
      colors.push(readI324(payload, offset, 0) & 16777215);
    }
  }
  const mode = readI324(payload, offset, 0);
  return {
    point: scripts[0],
    frame: scripts[1],
    beat: scripts[2],
    init: scripts[3],
    channel,
    colors,
    lines: mode !== 0
  };
}
function registerAvsSuperScope(registry, global = registry.eelGlobal) {
  const states = /* @__PURE__ */ new Map();
  registry.registerBuiltin(36, (context2) => {
    let state = states.get(context2.component.path);
    if (!state) {
      const config = decodeAvsSuperScope(context2.component.payload);
      const vm = new AvsEelVm({ global, seed: hashPath11(context2.component.path) });
      vm.set("n", 100);
      state = {
        config,
        vm,
        programs: [
          compileOrNull4(config.point),
          compileOrNull4(config.frame),
          compileOrNull4(config.beat),
          compileOrNull4(config.init)
        ],
        initialized: false,
        colorPosition: 0,
        centeredAudio: new Uint8Array(576),
        variables: bindVariables(vm)
      };
      states.set(context2.component.path, state);
    }
    if (context2.preinit) return;
    renderSuperScope(context2, state.config, state);
  });
  return registry;
}
function renderSuperScope(context2, config, state) {
  if (config.colors.length === 0) return;
  const { vm } = state;
  const variables = state.variables;
  vm.setHost({
    getosc: (band, width, channel) => avsAudioSample(context2.audio, "osc", band, width, channel),
    getspec: (band, width, channel) => avsAudioSample(context2.audio, "spec", band, width, channel)
  });
  state.colorPosition++;
  if (state.colorPosition >= config.colors.length * 64) state.colorPosition = 0;
  const color = interpolatedColor(config.colors, state.colorPosition);
  setBinding(variables.h, context2.input.height);
  setBinding(variables.w, context2.input.width);
  setBinding(variables.b, context2.beat ? 1 : 0);
  setBinding(variables.blue, (color & 255) / 255);
  setBinding(variables.green, (color >>> 8 & 255) / 255);
  setBinding(variables.red, (color >>> 16 & 255) / 255);
  setBinding(variables.skip, 0);
  setBinding(variables.linesize, context2.line.lineWidth >>> 0 & 255);
  setBinding(variables.drawmode, config.lines ? 1 : 0);
  if (!state.initialized) {
    execute5(state.programs[3], vm);
    state.initialized = true;
  }
  execute5(state.programs[1], vm);
  if (context2.beat) execute5(state.programs[2], vm);
  if (!state.programs[0]) return;
  const count = Math.min(MAX_POINTS, Math.trunc(getBinding(variables.n)));
  if (count <= 0) return;
  const data = scopeChannel(context2, config.channel, state.centeredAudio);
  const xor = (config.channel & 4) !== 0 ? 0 : 128;
  let canDraw = false;
  let lastX = 0;
  let lastY = 0;
  for (let index = 0; index < count; index++) {
    const audioPosition = index * 576 / count;
    const sourceIndex = Math.trunc(audioPosition);
    const fraction = audioPosition - sourceIndex;
    const a = data[Math.min(575, sourceIndex)] ^ xor;
    const b = data[Math.min(575, sourceIndex + 1)] ^ xor;
    setBinding(variables.v, (a * (1 - fraction) + b * fraction) / 128 - 1);
    setBinding(variables.i, count === 1 ? 0 : index / (count - 1));
    setBinding(variables.skip, 0);
    state.programs[0].execute(vm);
    const x = Math.trunc((getBinding(variables.x) + 1) * context2.input.width * 0.5);
    const y = Math.trunc((getBinding(variables.y) + 1) * context2.input.height * 0.5);
    if (getBinding(variables.skip) < 1e-5) {
      const drawColor = makeByte(getBinding(variables.blue)) | makeByte(getBinding(variables.green)) << 8 | makeByte(getBinding(variables.red)) << 16;
      if (getBinding(variables.drawmode) < 1e-5) {
        drawPoint(context2, x, y, drawColor);
      } else if (canDraw && (drawColor !== 0 || context2.line.blendMode !== 1)) {
        drawLine2(context2, lastX, lastY, x, y, drawColor, Math.trunc(getBinding(variables.linesize) + 0.5));
      }
    }
    canDraw = true;
    lastX = x;
    lastY = y;
  }
}
function scopeChannel(context2, selection, centered) {
  const source = (selection & 4) !== 0 ? context2.audio.spectrum : context2.audio.waveform;
  const channel = selection & 3;
  if (channel < 2) return source[channel];
  for (let i = 0; i < centered.length; i++) {
    centered[i] = Math.trunc(signed2(source[0][i]) / 2) + Math.trunc(signed2(source[1][i]) / 2) & 255;
  }
  return centered;
}
function drawPoint(context2, x, y, color) {
  if (x < 0 || y < 0 || x >= context2.input.width || y >= context2.input.height) return;
  const index = x + y * context2.input.width;
  context2.input.pixels[index] = blendLine(color, context2.input.pixels[index], context2.line.blendMode, context2.line.adjustableAlpha);
}
function drawLine2(context2, x1, y1, x2, y2, color, requestedWidth) {
  const width = context2.input.width;
  const height = context2.input.height;
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const lineWidth = clamp10(requestedWidth, 1, 255);
  const half = Math.trunc(lineWidth / 2);
  const plot2 = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = x + y * width;
    context2.input.pixels[index] = blendLine(color, context2.input.pixels[index], context2.line.blendMode, context2.line.adjustableAlpha);
  };
  if (dx === 0) {
    for (let y = Math.max(Math.min(y1, y2), 0); y < Math.min(Math.max(y1, y2), height - 1); y++) {
      for (let x = x1 - half; x < x1 - half + lineWidth; x++) plot2(x, y);
    }
    return;
  }
  if (y1 === y2) {
    for (let y = y1 - half; y < y1 - half + lineWidth; y++) {
      for (let x = Math.max(Math.min(x1, x2), 0); x < Math.min(Math.max(x1, x2), width - 1); x++) plot2(x, y);
    }
    return;
  }
  if (dy <= dx) {
    if (x2 < x1) {
      [x1, x2] = [x2, x1];
      [y1, y2] = [y2, y1];
    }
    const yIncrement = y2 > y1 ? 1 : -1;
    let y = y1 - half;
    let decision = 2 * dy - dx;
    const east = 2 * dy;
    const northEast = decision - dx;
    while (x1 < x2) {
      for (let py = y; py < y + lineWidth; py++) plot2(x1, py);
      if (decision < 0) decision += east;
      else {
        decision += northEast;
        y += yIncrement;
      }
      x1++;
    }
  } else {
    if (y2 < y1) {
      [x1, x2] = [x2, x1];
      [y1, y2] = [y2, y1];
    }
    const xIncrement = x2 > x1 ? 1 : -1;
    let x = x1 - half;
    let decision = 2 * dx - dy;
    const east = 2 * dx;
    const northEast = decision - dy;
    while (y1 < y2) {
      for (let px = x; px < x + lineWidth; px++) plot2(px, y1);
      if (decision < 0) decision += east;
      else {
        decision += northEast;
        x += xIncrement;
      }
      y1++;
    }
  }
}
function execute5(program, vm) {
  return program ? vm.execute(program) : 0;
}
function bindVariables(vm) {
  return {
    n: vm.bindVariable("n"),
    h: vm.bindVariable("h"),
    w: vm.bindVariable("w"),
    b: vm.bindVariable("b"),
    blue: vm.bindVariable("blue"),
    green: vm.bindVariable("green"),
    red: vm.bindVariable("red"),
    skip: vm.bindVariable("skip"),
    linesize: vm.bindVariable("linesize"),
    drawmode: vm.bindVariable("drawmode"),
    v: vm.bindVariable("v"),
    i: vm.bindVariable("i"),
    x: vm.bindVariable("x"),
    y: vm.bindVariable("y")
  };
}
function getBinding(binding) {
  return binding.values[binding.index] ?? 0;
}
function setBinding(binding, value) {
  binding.values[binding.index] = Number.isFinite(value) ? value : 0;
}
function compileOrNull4(source) {
  if (!source.trim()) return null;
  try {
    return compileAvsEel(source);
  } catch {
    return null;
  }
}
function interpolatedColor(colors, position) {
  const index = Math.trunc(position / 64);
  const fraction = position & 63;
  const first = colors[index];
  const second = colors[(index + 1) % colors.length];
  const channel = (shift) => Math.trunc(
    ((first >>> shift & 255) * (63 - fraction) + (second >>> shift & 255) * fraction) / 64
  );
  return channel(0) | channel(8) << 8 | channel(16) << 16;
}
function readString3(payload, offset) {
  if (offset + 4 > payload.length) return { value: "", next: payload.length };
  const length = readU32(payload, offset, 0);
  const start = offset + 4;
  const end = Math.min(payload.length, start + length);
  return { value: nulText8(payload.subarray(start, end)), next: end };
}
function readI324(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function readU32(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(offset, true) : fallback;
}
function nulText8(bytes) {
  const end = bytes.indexOf(0);
  return TEXT6.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function signed2(value) {
  return value < 128 ? value : value - 256;
}
function makeByte(value) {
  return value <= 0 ? 0 : value >= 1 ? 255 : Math.trunc(value * 255);
}
function clamp10(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath11(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/text.ts
var WINDOWS_1252 = new TextDecoder("windows-1252");
var CHOOSEFONT32_BYTES = 60;
var LOGFONTA_BYTES = 60;
function decodeAvsText(payload) {
  let offset = 0;
  const read = (fallback) => {
    const value = i328(payload, offset, fallback);
    offset += 4;
    return value;
  };
  const enabled = read(1) !== 0;
  const color = read(16777215) & 16777215;
  const additive = read(0) !== 0;
  const average = read(0) !== 0;
  const onBeat = read(0) !== 0;
  const insertBlank = read(0) !== 0;
  const randomPosition = read(0) !== 0;
  const verticalAlign = read(4);
  const horizontalAlign = read(1);
  const beatFrames = read(15);
  const normalFrames = read(15);
  const chooseFont = fixedBytes(payload, offset, CHOOSEFONT32_BYTES);
  offset += CHOOSEFONT32_BYTES;
  const logFont = fixedBytes(payload, offset, LOGFONTA_BYTES);
  offset += LOGFONTA_BYTES;
  const textLength = read(0);
  let text = "";
  if (textLength > 0 && offset + textLength <= payload.length) {
    text = nulText9(payload.subarray(offset, offset + textLength));
    offset += textLength;
  }
  return {
    enabled,
    color,
    additive,
    average,
    onBeat,
    insertBlank,
    randomPosition,
    verticalAlign,
    horizontalAlign,
    beatFrames,
    normalFrames,
    font: decodeFont(chooseFont, logFont),
    text,
    outline: read(0) !== 0,
    outlineColor: read(0) & 16777215,
    horizontalShiftPercent: read(0),
    verticalShiftPercent: read(0),
    outlineSize: read(1),
    randomWord: read(0) !== 0,
    shadow: read(0) !== 0
  };
}
function registerAvsText(registry, options = {}) {
  const states = /* @__PURE__ */ new Map();
  const rasterize = options.rasterize ?? rasterizePortableText;
  registry.registerBuiltin(28, (context2) => {
    const config = decodeAvsText(context2.component.payload);
    if (!config.enabled || context2.preinit) return;
    let state = states.get(context2.component.path);
    if (!state) {
      state = {
        currentWord: 0,
        beatFrames: 0,
        normalFrames: 0,
        oddEven: 0,
        horizontalAlign: config.horizontalAlign,
        verticalAlign: config.verticalAlign,
        horizontalShift: config.horizontalShiftPercent,
        verticalShift: config.verticalShiftPercent,
        randomState: hashPath12(context2.component.path)
      };
      states.set(context2.component.path, state);
    }
    const shouldAdvance = !config.onBeat && state.normalFrames >= config.normalFrames || config.onBeat && context2.beat && state.beatFrames === 0;
    const words = config.text.split(";");
    if (shouldAdvance) {
      if (!(config.insertBlank && state.oddEven % 2 === 0)) {
        state.currentWord = config.randomWord ? randomBound2(state, options.random, words.length) : (state.currentWord + 1) % words.length;
      }
      state.oddEven = (state.oddEven + 1) % 2;
    }
    if (config.onBeat && context2.beat && state.beatFrames === 0) state.beatFrames = config.beatFrames;
    let text = expandText(words[state.currentWord] ?? "", registry, options);
    if (config.insertBlank && state.oddEven === 0) text = "";
    if (shouldAdvance) {
      state.normalFrames = 0;
      if (config.randomPosition) {
        const measured = rasterize({
          ...request(config, context2, text, 0, 0),
          horizontalAlign: 0,
          verticalAlign: 0
        });
        state.horizontalAlign = 0;
        state.verticalAlign = 0;
        if (measured.textWidth < context2.input.width) {
          const bound = Math.trunc((context2.input.width - measured.textWidth) / context2.input.width * 100);
          state.horizontalShift = randomBound2(state, options.random, bound);
        }
        if (measured.textHeight < context2.input.height) {
          const bound = Math.trunc((context2.input.height - measured.textHeight) / context2.input.height * 100);
          state.verticalShift = randomBound2(state, options.random, bound);
        }
      } else {
        state.horizontalAlign = config.horizontalAlign;
        state.verticalAlign = config.verticalAlign;
        state.horizontalShift = config.horizontalShiftPercent;
        state.verticalShift = config.verticalShiftPercent;
      }
    }
    if (!(config.onBeat && state.beatFrames === 0)) {
      const bitmap = rasterize(request(
        config,
        context2,
        text,
        state.horizontalShift,
        state.verticalShift,
        state.horizontalAlign,
        state.verticalAlign
      ));
      if (bitmap.pixels.length !== context2.input.pixels.length || bitmap.mask.length !== bitmap.pixels.length) {
        throw new RangeError("AVS Text rasterizer returned a bitmap with the wrong dimensions");
      }
      for (let i = 0; i < bitmap.pixels.length; i++) {
        if (!bitmap.mask[i]) continue;
        const rendered = bitmap.pixels[i];
        const original = context2.input.pixels[i];
        context2.input.pixels[i] = config.additive ? blendPixel(rendered, original, "additive") : config.average ? blendPixel(rendered, original, "average") : rendered;
      }
    }
    if (!config.onBeat) state.normalFrames++;
    if (config.onBeat && state.beatFrames) state.beatFrames--;
  });
  return registry;
}
function request(config, context2, text, horizontalShiftPercent, verticalShiftPercent, horizontalAlign = config.horizontalAlign, verticalAlign = config.verticalAlign) {
  return {
    width: context2.input.width,
    height: context2.input.height,
    text,
    color: config.color,
    outline: config.outline,
    shadow: config.shadow,
    outlineColor: config.outlineColor,
    outlineSize: config.outlineSize,
    horizontalAlign,
    verticalAlign,
    horizontalShiftPercent,
    verticalShiftPercent,
    font: config.font
  };
}
function expandText(text, registry, options) {
  return text.replace(/\$\(([^)]*)\)/gi, (whole, body) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("playpos")) return formatTime(options.playbackPositionMs?.() ?? 0, lower);
    if (lower.startsWith("playlen")) return formatTime(options.playbackLengthMs?.() ?? 0, lower);
    if (lower.startsWith("title")) {
      let title = (options.title?.() ?? "").replace(/\s*- Winamp\s*$/i, "");
      const specification = lower.slice(5);
      const noNumber = specification.startsWith(":n");
      if (!noNumber) title = title.replace(/^\d+\.\s+/, "");
      const maximum = Number.parseInt(specification.replace(/^:n?/, ""), 10);
      return maximum > 0 ? title.slice(0, maximum) : title;
    }
    const register = /^reg(\d\d)(?::([0-9]*)(?:\.([0-9]+))?)?$/.exec(lower);
    if (register) {
      const value = registry.eelGlobal.registers[Number(register[1])] ?? 0;
      const precision = register[3] === void 0 ? 6 : Number(register[3]);
      const formatted = value.toFixed(precision);
      const width = Number(register[2] ?? 0);
      return width > formatted.length ? formatted.padStart(width) : formatted;
    }
    return whole;
  }).slice(0, 255);
}
function formatTime(milliseconds, specification) {
  const digits = clamp11(Number.parseInt(specification.split(".")[1] ?? "0", 10) || 0, 0, 3);
  const value = Math.max(0, Math.trunc(milliseconds));
  const base = `${Math.trunc(value / 6e4)}:${String(Math.trunc(value / 1e3) % 60).padStart(2, "0")}`;
  return digits ? `${base}.${String(value % 1e3).padStart(3, "0").slice(0, digits)}` : base;
}
function rasterizePortableText(request2) {
  const pixels = new Uint32Array(request2.width * request2.height);
  const mask = new Uint8Array(pixels.length);
  const scale = Math.max(1, Math.trunc(Math.abs(request2.font.height || 7) / 7));
  const glyphWidth = 6 * scale;
  const textWidth = Math.max(0, request2.text.length * glyphWidth - scale);
  const textHeight = 7 * scale;
  let left = request2.horizontalAlign === 2 ? request2.width - textWidth : request2.horizontalAlign === 1 ? Math.trunc((request2.width - textWidth) / 2) : 0;
  let top = (request2.verticalAlign & 8) !== 0 ? request2.height - textHeight : (request2.verticalAlign & 4) !== 0 ? Math.trunc((request2.height - textHeight) / 2) : 0;
  left += Math.trunc(request2.horizontalShiftPercent * request2.width / 100);
  top += Math.trunc(request2.verticalShiftPercent * request2.height / 100);
  const foreground = new Uint8Array(pixels.length);
  for (let index = 0; index < request2.text.length; index++) {
    const glyph = glyphFor(request2.text[index]);
    for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) {
      if ((glyph[row] >>> 4 - column & 1) === 0) continue;
      fillMask(
        foreground,
        request2.width,
        request2.height,
        left + index * glyphWidth + column * scale,
        top + row * scale,
        scale
      );
    }
  }
  const outlineMask = new Uint8Array(pixels.length);
  if (request2.outline || request2.shadow) {
    const radius = Math.max(1, Math.abs(Math.trunc(request2.outlineSize)));
    for (let y = 0; y < request2.height; y++) for (let x = 0; x < request2.width; x++) {
      if (!foreground[x + y * request2.width]) continue;
      if (request2.shadow) stamp(outlineMask, request2.width, request2.height, x + radius, y + radius, 0);
      else for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        if (dx || dy) stamp(outlineMask, request2.width, request2.height, x + dx, y + dy, 0);
      }
    }
  }
  for (let i = 0; i < pixels.length; i++) {
    if (outlineMask[i]) {
      pixels[i] = request2.outlineColor;
      mask[i] = 1;
    }
    if (foreground[i]) {
      pixels[i] = request2.color;
      mask[i] = 1;
    }
  }
  return { pixels, mask, textWidth, textHeight };
}
function fillMask(mask, width, height, x, y, size) {
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) stamp(mask, width, height, x + dx, y + dy, 1);
}
function stamp(mask, width, height, x, y, value) {
  if (x >= 0 && y >= 0 && x < width && y < height) mask[x + y * width] = value || 1;
}
function glyphFor(character) {
  const glyph = GLYPHS[character.toUpperCase()];
  if (glyph) return glyph;
  const code = character.charCodeAt(0);
  return [31, 17, code >>> 0 & 31, code >>> 2 & 31, code >>> 4 & 31, 17, 31];
}
var GLYPHS = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "!": [4, 4, 4, 4, 4, 0, 4],
  "-": [0, 0, 0, 31, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 6, 6],
  ":": [0, 6, 6, 0, 6, 6, 0],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 1, 14],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 18, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31]
};
function decodeFont(chooseFont, logFont) {
  return {
    height: i328(logFont, 0, 0),
    width: i328(logFont, 4, 0),
    weight: i328(logFont, 16, 0),
    italic: logFont[20] !== 0,
    underline: logFont[21] !== 0,
    strikeout: logFont[22] !== 0,
    face: nulText9(logFont.subarray(28, 60)),
    rawChooseFont: chooseFont,
    rawLogFont: logFont
  };
}
function fixedBytes(payload, offset, length) {
  const bytes = new Uint8Array(length);
  bytes.set(payload.subarray(offset, Math.min(payload.length, offset + length)));
  return bytes;
}
function randomBound2(state, hook, bound) {
  if (bound <= 0) return 0;
  const value = hook ? Math.trunc(hook()) >>> 0 : nextRandom4(state);
  return value % bound;
}
function nextRandom4(state) {
  let value = state.randomState || 1831565813;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.randomState = value >>> 0;
  return state.randomState;
}
function i328(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function nulText9(bytes) {
  const end = bytes.indexOf(0);
  return WINDOWS_1252.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp11(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath12(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/texer.ts
var AVS_TEXER_APE_ID = "Texer";
var AVS_TEXER_II_APE_ID = "Acko.net: Texer II";
var TEXT7 = new TextDecoder("windows-1252");
var MAX_TEXER_II_PARTICLES = 65536;
function decodeAvsTexerConfig(payload) {
  const mode = readI325(payload, 276, 0);
  return {
    image: payload.length >= 276 ? nulText10(payload.subarray(16, 276)) : "",
    addToInput: (mode & 3) === 2,
    colorize: (mode & 12) === 8,
    particles: readI325(payload, 280, 100)
  };
}
function decodeAvsTexer2Config(payload) {
  const rawVersion = readI325(payload, 0, 0);
  let offset = 280;
  const scripts = [];
  for (let index = 0; index < 4; index++) {
    const decoded = readLengthString(payload, offset);
    scripts.push(decoded.value);
    offset = decoded.next;
  }
  return {
    version: rawVersion === 1 ? 1 : 0,
    image: payload.length >= 264 ? nulText10(payload.subarray(4, 264)) : "",
    resize: readI325(payload, 264, 0) !== 0,
    wrap: readI325(payload, 268, 0) !== 0,
    colorize: readI325(payload, 272, 1) !== 0,
    init: scripts[0],
    frame: scripts[1],
    beat: scripts[2],
    point: scripts[3]
  };
}
function registerAvsTexerEffects(registry = new AvsEffectRegistry(), options = {}) {
  registry.registerApe(AVS_TEXER_APE_ID, (context2) => {
    const config = decodeAvsTexerConfig(context2.component.payload);
    const bitmap = options.bitmapResolver?.(config.image);
    if (!bitmap) return;
    renderTexer(context2, config, bitmap);
    return { swap: true };
  });
  const states = /* @__PURE__ */ new Map();
  registry.registerApe(AVS_TEXER_II_APE_ID, (context2) => {
    const config = decodeAvsTexer2Config(context2.component.payload);
    let state = states.get(context2.component.path);
    if (!state) {
      const vm = new AvsEelVm({ global: registry.eelGlobal, seed: hashPath13(context2.component.path) });
      state = {
        vm,
        programs: [
          compileOrNull5(config.init),
          compileOrNull5(config.frame),
          compileOrNull5(config.beat),
          compileOrNull5(config.point)
        ],
        initialized: false
      };
      states.set(context2.component.path, state);
    }
    const bitmap = resolveTexer2Bitmap(config.image, options);
    renderTexer2(context2, config, bitmap, state);
  });
  return registry;
}
function renderTexer(context2, config, bitmap) {
  const source = context2.input.pixels;
  const output = context2.output.pixels;
  if (config.addToInput) output.set(source);
  else output.fill(0);
  let drawn = 0;
  for (let y = 0; y < context2.input.height; y++) {
    for (let x = 0; x < context2.input.width; x++) {
      const mask = source[y * context2.input.width + x] & 16777215;
      if (mask === 0) continue;
      drawTexerStamp(output, context2.input.width, context2.input.height, bitmap, x, y, config.colorize ? mask : null);
      drawn++;
      if (drawn >= config.particles) return;
    }
  }
}
function drawTexerStamp(output, width, height, bitmap, centreX, centreY, mask) {
  const startX = centreX - Math.trunc(bitmap.width / 2);
  const startY = centreY - Math.trunc(bitmap.height / 2);
  for (let imageY = 0; imageY < bitmap.height; imageY++) {
    const y = startY + imageY;
    if (y < 0 || y >= height) continue;
    for (let imageX = 0; imageX < bitmap.width; imageX++) {
      const x = startX + imageX;
      if (x < 0 || x >= width) continue;
      let source = bitmap.pixels[imageY * bitmap.width + imageX];
      if (mask !== null) source = filterPixel(source, mask);
      const index = y * width + x;
      output[index] = blendTexerPixel(source, output[index], 1, 0);
    }
  }
}
function renderTexer2(context2, config, bitmap, state) {
  const { vm } = state;
  vm.setHost({
    getosc: (band, width, channel) => avsAudioSample(context2.audio, "osc", band, width, channel),
    getspec: (band, width, channel) => avsAudioSample(context2.audio, "spec", band, width, channel)
  });
  vm.set("i", 0);
  vm.set("x", 0);
  vm.set("y", 0);
  vm.set("v", 0);
  vm.set("w", context2.input.width);
  vm.set("h", context2.input.height);
  vm.set("b", context2.beat || context2.preinit ? 1 : 0);
  vm.set("iw", bitmap.width);
  vm.set("ih", bitmap.height);
  vm.set("sizex", 1);
  vm.set("sizey", 1);
  vm.set("red", 1);
  vm.set("green", 1);
  vm.set("blue", 1);
  vm.set("skip", 0);
  if (!state.initialized || context2.preinit) {
    vm.set("n", 0);
    execute6(state.programs[0], vm);
    state.initialized = true;
  }
  execute6(state.programs[1], vm);
  if (context2.beat && !context2.preinit) execute6(state.programs[2], vm);
  const count = clamp12(roundEven(vm.get("n")), 0, MAX_TEXER_II_PARTICLES);
  if (count <= 0) return;
  let progress = 0;
  const step = 1 / (count - 1);
  for (let index = 0; index < count; index++) {
    vm.set("i", progress);
    progress += step;
    vm.set("skip", 0);
    const sample2 = Math.trunc(index * 575 / count);
    const left = signedByte2(context2.audio.waveform[0][sample2]);
    const right = signedByte2(context2.audio.waveform[1][sample2]);
    vm.set("v", (left + right) / 256);
    execute6(state.programs[3], vm);
    if (vm.get("skip") !== 0) continue;
    const sizeX = Math.abs(vm.get("sizex"));
    const sizeY = Math.abs(vm.get("sizey"));
    if (sizeX <= 0.01 || sizeY <= 0.01) continue;
    const color = config.colorize ? byteColor(vm.get("blue")) | byteColor(vm.get("green")) << 8 | byteColor(vm.get("red")) << 16 : 16777215;
    const flipX = vm.get("sizex") < 0;
    const flipY = vm.get("sizey") < 0;
    let x = vm.get("x");
    let y = vm.get("y");
    if (config.wrap) {
      let overlapCoordinateX;
      let overlapCoordinateY;
      if (config.version === 0) {
        overlapCoordinateX = x;
        overlapCoordinateY = y;
        x -= x > 1 ? 2 : x < -1 ? -2 : 0;
        y -= y > 1 ? 2 : y < -1 ? -2 : 0;
      } else {
        x -= roundAway(x / 2) * 2;
        y -= roundAway(y / 2) * 2;
        overlapCoordinateX = x;
        overlapCoordinateY = y;
      }
      const overlapX = overlapsEdge(overlapCoordinateX, sizeX, bitmap.width, context2.input.width);
      const overlapY = overlapsEdge(overlapCoordinateY, sizeY, bitmap.height, context2.input.height);
      const shiftX = x > 0 ? 2 : -2;
      const shiftY = y > 0 ? 2 : -2;
      if (overlapX) drawTexer2Particle(context2, config, bitmap, x - shiftX, y, sizeX, sizeY, color, flipX, flipY);
      if (overlapY) drawTexer2Particle(context2, config, bitmap, x, y - shiftY, sizeX, sizeY, color, flipX, flipY);
      if (overlapX && overlapY) {
        drawTexer2Particle(context2, config, bitmap, x - shiftX, y - shiftY, sizeX, sizeY, color, flipX, flipY);
      }
    }
    drawTexer2Particle(context2, config, bitmap, x, y, sizeX, sizeY, color, flipX, flipY);
  }
}
function drawTexer2Particle(context2, config, bitmap, x, y, sizeX, sizeY, color, flipX, flipY) {
  if (config.resize) drawScaledParticle(context2, bitmap, x, y, sizeX, sizeY, color, flipX, flipY);
  else drawUnscaledParticle(context2, bitmap, x, y, color, config.colorize, flipX, flipY);
}
function drawUnscaledParticle(context2, bitmap, x, y, color, colorize, flipX, flipY) {
  const screenMaxX = context2.input.width - 1;
  const screenMaxY = context2.input.height - 1;
  const imageMaxX = bitmap.width - 1;
  const imageMaxY = bitmap.height - 1;
  let left = roundEven((x * 0.5 + 0.5) * screenMaxX) - Math.trunc(imageMaxX / 2);
  let top = roundEven((y * 0.5 + 0.5) * screenMaxY) - Math.trunc(imageMaxY / 2);
  let right = left + imageMaxX - 1;
  let bottom = top + imageMaxY - 1;
  if (right < 0 || left > screenMaxX || bottom < 0 || top > screenMaxY) return;
  let textureX = left < 0 && right !== left ? roundEven(-left / (right - left) * imageMaxX) : 0;
  let textureY = top < 0 && bottom !== top ? roundEven(-top / (bottom - top) * imageMaxY) : 0;
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(screenMaxX, right);
  bottom = Math.min(screenMaxY, bottom);
  if (right <= left || bottom <= top) return;
  for (let drawY = top; drawY <= bottom; drawY++, textureY++) {
    let tx = textureX;
    for (let drawX = left; drawX <= right; drawX++, tx++) {
      let source = sampleBitmap(bitmap, tx, textureY, flipX, flipY);
      if (colorize) source = filterPixel(source, color);
      const destination = drawY * context2.input.width + drawX;
      context2.input.pixels[destination] = blendTexerPixel(
        source,
        context2.input.pixels[destination],
        context2.line.blendMode,
        context2.line.adjustableAlpha
      );
    }
  }
}
function drawScaledParticle(context2, bitmap, x, y, sizeX, sizeY, color, flipX, flipY) {
  const screenMaxX = context2.input.width - 1;
  const screenMaxY = context2.input.height - 1;
  const imageMaxX = bitmap.width - 1;
  const imageMaxY = bitmap.height - 1;
  const centreX = (x * 0.5 + 0.5) * screenMaxX;
  const centreY = (y * 0.5 + 0.5) * screenMaxY;
  const leftF = -imageMaxX * 0.5 * sizeX + 0.5 + centreX;
  const topF = -imageMaxY * 0.5 * sizeY + 0.5 + centreY;
  const rightF = (imageMaxX - 1) * 0.5 * sizeX + 0.5 + centreX;
  const bottomF = (imageMaxY - 1) * 0.5 * sizeY + 0.5 + centreY;
  let left = roundEven(leftF);
  let top = roundEven(topF);
  let right = roundEven(rightF);
  let bottom = roundEven(bottomF);
  if (right < 0 || left > screenMaxX || bottom < 0 || top > screenMaxY) return;
  let x0 = (0.5 - fractional(leftF + 0.5)) / (rightF - leftF);
  let y0 = (0.5 - fractional(topF + 0.5)) / (bottomF - topF);
  if (leftF < 0) x0 = -leftF / (rightF - leftF);
  if (topF < 0) y0 = -topF / (bottomF - topF);
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(screenMaxX, right);
  bottom = Math.min(screenMaxY, bottom);
  if (right <= left || bottom <= top) return;
  const fx0 = x0 * imageMaxX;
  const fy0 = y0 * imageMaxY;
  let cx = (roundEven(fx0) << 16) + 65535 - Math.trunc((0.5 - (fx0 - roundEven(fx0))) * 65536);
  let cy = (roundEven(fy0) << 16) + 65535 - Math.trunc((0.5 - (fy0 - roundEven(fy0))) * 65536);
  const stepX = Math.trunc((imageMaxX - 1) / (rightF - leftF + 1) * 65536);
  const stepY = Math.trunc((imageMaxY - 1) / (bottomF - topF + 1) * 65536);
  if (cx < 0) {
    cx += stepX;
    left++;
  }
  if (cy < 0) {
    cy += stepY;
    top++;
  }
  if (right <= left || bottom <= top) return;
  for (let drawY = top, fy = cy; drawY <= bottom; drawY++, fy += stepY) {
    for (let drawX = left, fx = cx; drawX <= right; drawX++, fx += stepX) {
      const source = filterPixel(sampleBilinearFixed(bitmap, fx, fy, flipX, flipY), color);
      const destination = drawY * context2.input.width + drawX;
      context2.input.pixels[destination] = blendTexerPixel(
        source,
        context2.input.pixels[destination],
        context2.line.blendMode,
        context2.line.adjustableAlpha
      );
    }
  }
}
function sampleBilinearFixed(bitmap, fx, fy, flipX, flipY) {
  const x = clamp12(fx >> 16, 0, Math.max(0, bitmap.width - 2));
  const y = clamp12(fy >> 16, 0, Math.max(0, bitmap.height - 2));
  const dx = fx >>> 8 & 255;
  const dy = fy >>> 8 & 255;
  let result = 0;
  for (let shift = 0; shift <= 16; shift += 8) {
    const a = sampleBitmap(bitmap, x, y, flipX, flipY) >>> shift & 255;
    const b = sampleBitmap(bitmap, x + 1, y, flipX, flipY) >>> shift & 255;
    const c = sampleBitmap(bitmap, x, y + 1, flipX, flipY) >>> shift & 255;
    const d = sampleBitmap(bitmap, x + 1, y + 1, flipX, flipY) >>> shift & 255;
    const upper = (a * (255 - dx) >>> 8) + (b * dx >>> 8);
    const lower = (c * (255 - dx) >>> 8) + (d * dx >>> 8);
    result |= ((upper * (255 - dy) >>> 8) + (lower * dy >>> 8) & 255) << shift;
  }
  return result;
}
function sampleBitmap(bitmap, x, y, flipX, flipY) {
  const sx = flipX ? bitmap.width - x - 1 : x;
  const sy = flipY ? bitmap.height - y - 1 : y;
  return bitmap.pixels[clamp12(sy, 0, bitmap.height - 1) * bitmap.width + clamp12(sx, 0, bitmap.width - 1)];
}
function filterPixel(pixel, color) {
  return channels5(pixel, color, (source, mask) => source * mask >>> 8);
}
function blendTexerPixel(source, destination, mode, amount) {
  source &= 16777215;
  destination &= 16777215;
  switch (mode) {
    case 1:
      return channels5(source, destination, (s, d) => Math.min(255, s + d));
    case 2:
      return channels5(source, destination, Math.max);
    case 3:
      return (source >>> 1 & 8355711) + (destination >>> 1 & 8355711);
    case 4:
      return channels5(source, destination, (s, d) => Math.max(0, d - s));
    case 5:
      return channels5(source, destination, (s, d) => Math.max(0, s - d));
    case 6:
      return channels5(source, destination, (s, d) => s * d >>> 8);
    case 7: {
      const alpha = clamp12(amount, 0, 255);
      return channels5(source, destination, (s, d) => (s * alpha >>> 8) + (d * (256 - alpha) >>> 8));
    }
    case 8:
      return (source ^ destination) & 16777215;
    case 9:
      return channels5(source, destination, Math.min);
    default:
      return source;
  }
}
function channels5(a, b, fn) {
  return fn(a & 255, b & 255) & 255 | (fn(a >>> 8 & 255, b >>> 8 & 255) & 255) << 8 | (fn(a >>> 16 & 255, b >>> 16 & 255) & 255) << 16;
}
function resolveTexer2Bitmap(name, options) {
  if (name && name !== "(default image)") {
    const resolved = options.bitmapResolver?.(name);
    if (resolved) return resolved;
  }
  return options.defaultTexer2Bitmap ?? defaultTexer2Bitmap();
}
var defaultBitmap;
function defaultTexer2Bitmap() {
  if (defaultBitmap) return defaultBitmap;
  const encoded = "AAAAAAAAAAAAAAAAAAAAAAAAAAADAwMICAgNDQ0QEBASEhIQEBANDQ0ICAgDAwMBAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMLCwsWFhYhISEqKiovLy8yMjIvLy8qKiohISEWFhYLCwsDAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAFBQUSEhIiIiIyMjJBQUFNTU1UVFRXV1dUVFRNTU1BQUEyMjIiIiISEhIFBQUAAAAAAAAAAAAAAAAAAAAFBQUUFBQoKCg+Pj5TU1NlZWV0dHR9fX2AgIB9fX10dHRmZmZTU1M+Pj4oKCgUFBQFBQUAAAAAAAAAAAADAwMREREoKChCQkJdXV13d3eNjY2cnJylpaWoqKilpaWcnJyNjY13d3ddXV1CQkIoKCgREREDAwMAAAAAAAAKCgohISE+Pj5dXV19fX2ampqvr6/AwMDKysrNzc3KysrAwMCvr6+ampp9fX1dXV0+Pj4hISEKCgoAAAADAwMVFRUxMTFTU1N2dnaZmZm2trbOzs7e3t7o6Ojr6+vo6Oje3t7Nzc22traZmZl2dnZTU1MxMTEVFRUDAwMHBwcfHx9AQEBlZWWMjIyvr6/Nzc3l5eXy8vL4+Pj6+vr4+Pjy8vLl5eXNzc2vr6+MjIxlZWVAQEAfHx8HBwcMDAwoKChMTExzc3Obm5u/v7/d3d3y8vL6+vr9/f3+/v79/f36+vry8vLd3d2/v7+bm5tzc3NMTEwoKCgLCwsPDw8uLi5TU1N8fHykpKTIyMjn5+f4+Pj9/f3////////////9/f34+Pjn5+fIyMikpKR8fHxTU1MuLi4PDw8QEBAwMDBVVVV+fn6mpqbLy8vp6en5+fn+/v7////////////+/v75+fnp6enLy8umpqZ+fn5VVVUwMDAQEBAPDw8tLS1SUlJ7e3ujo6PHx8fm5ub39/f9/f3+/v7////+/v79/f339/fm5ubHx8ejo6N7e3tSUlItLS0PDw8LCwsoKChKSkpxcXGampq9vb3c3Nzx8fH6+vr9/f3+/v79/f36+vrx8fHc3Ny9vb2amppxcXFKSkooKCgLCwsGBgYfHx8/Pz9jY2OKioqtra3Ly8vj4+Px8fH39/f5+fn39/fx8fHj4+PLy8utra2KiopjY2M/Pz8fHx8GBgYDAwMUFBQwMDBQUFB0dHSWlpazs7PKysrb29vl5eXo6Ojl5eXb29vLy8uzs7OWlpZ0dHRQUFAwMDAUFBQCAgIAAAAJCQkgICA8PDxaWlp6enqWlpasrKy8vLzGxsbJycnGxsa8vLysrKyWlpZ6enpaWlo8PDwgICAJCQkAAAAAAAACAgIQEBAmJiY/Pz9aWlpzc3OJiYmZmZmhoaGkpKShoaGZmZmJiYlzc3NaWlpAQEAmJiYQEBACAgIAAAAAAAAAAAAEBAQSEhImJiY7OztQUFBiYmJwcHB5eXl8fHx5eXlwcHBiYmJQUFA7OzsmJiYSEhIEBAQAAAAAAAAAAAAAAAAAAAAEBAQPDw8fHx8vLy8+Pj5JSUlQUFBTU1NQUFBJSUk+Pj4vLy8fHx8PDw8EBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgIJCQkTExMeHh4mJiYsLCwuLi4sLCwmJiYdHR0TExMJCQkCAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgIGBgYKCgoODg4PDw8ODg4KCgoGBgYDAwMAAAAAAAAAAAAAAAAAAAAA";
  const raw = atob(encoded);
  const pixels = new Uint32Array(21 * 21);
  for (let index = 0; index < pixels.length; index++) {
    const offset = index * 3;
    pixels[index] = raw.charCodeAt(offset) | raw.charCodeAt(offset + 1) << 8 | raw.charCodeAt(offset + 2) << 16;
  }
  defaultBitmap = { width: 21, height: 21, pixels };
  return defaultBitmap;
}
function overlapsEdge(coordinate, size, imagePixels, screenPixels) {
  const half = size * (imagePixels - 1) / screenPixels;
  const absolute = Math.abs(coordinate);
  return absolute + half > 1 && absolute - half < 1;
}
function readLengthString(payload, offset) {
  if (offset + 4 > payload.length) return { value: "", next: payload.length };
  const length = readU322(payload, offset, 0);
  const start = offset + 4;
  const end = Math.min(payload.length, start + length);
  return { value: nulText10(payload.subarray(start, end)), next: end };
}
function nulText10(bytes) {
  const end = bytes.indexOf(0);
  return TEXT7.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function readI325(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function readU322(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(offset, true) : fallback;
}
function compileOrNull5(source) {
  if (!source.trim()) return null;
  try {
    return compileAvsEel(source);
  } catch {
    return null;
  }
}
function execute6(program, vm) {
  return program ? vm.execute(program) : 0;
}
function signedByte2(value) {
  return value < 128 ? value : value - 256;
}
function byteColor(value) {
  return clamp12(roundEven(value * 255), 0, 255);
}
function roundEven(value) {
  if (!Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return (floor & 1) === 0 ? floor : floor + 1;
}
function roundAway(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
function fractional(value) {
  return value - Math.trunc(value);
}
function clamp12(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath13(path) {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// src/avs/effects/registry.ts
function createAvsCompatibilityRegistry(classicOptions = {}, texerOptions = {}) {
  const registry = new AvsEffectRegistry();
  registerAvsAddBorders(registry);
  registerAvsCoreEffects(registry);
  registerAvsBasicTransforms(registry);
  registerAvsBeatParticleEffects(registry);
  registerAvsBump(registry);
  registerAvsClassicEffects(registry, classicOptions);
  registerAvsColorMap(registry);
  registerAvsConvolutionFilter(registry);
  registerAvsMovement(registry);
  registerAvsLowCountBuiltins(registry);
  registerAvsMultiFilter(registry);
  registerAvsDynamicMovement(registry);
  registerAvsFinalLowCountBuiltins(registry);
  registerAvsNamedApeEffects(registry);
  registerAvsScriptedTransforms(registry);
  registerAvsSuperScope(registry);
  registerAvsText(registry);
  registerAvsTexerEffects(registry, texerOptions);
  return registry;
}

// src/avs/runtime.ts
var AvsCompatibilityRuntime = class {
  preset;
  registry;
  executor;
  hostAudio = new AvsAudioAccumulator();
  pcmAudio = new AvsAudioAnalyser();
  surface;
  constructor(preset, width, height, registry = createAvsCompatibilityRegistry()) {
    this.preset = "components" in preset ? preset : parseAvsPreset(preset);
    this.registry = registry;
    this.executor = new AvsExecutor(this.preset, registry);
    this.surface = new AvsFramebuffer(width, height);
  }
  get framebuffer() {
    return this.surface;
  }
  resize(width, height) {
    if (this.surface.width === width && this.surface.height === height) return;
    this.surface = new AvsFramebuffer(width, height);
    this.executor.reset();
  }
  pushHostAudio(waveform, spectrum) {
    this.hostAudio.push(waveform, spectrum);
  }
  renderHostFrame(preinit = false) {
    return this.render(this.hostAudio.consume(), preinit);
  }
  renderPcm(pcm, preinit = false) {
    return this.render(this.pcmAudio.analyse(pcm), preinit);
  }
  render(audio = emptyAudio(), preinit = false) {
    const stats = this.executor.render(this.surface, audio, preinit);
    return { framebuffer: this.surface, stats };
  }
  /** Browser-ready RGBA8 copy. Packed AVS RGB is B,G,R in byte order on LE. */
  rgbaBytes(alpha = 255) {
    const rgba = new Uint8ClampedArray(this.surface.pixels.length * 4);
    for (let i = 0; i < this.surface.pixels.length; i++) {
      const pixel = this.surface.pixels[i];
      rgba[i * 4] = pixel >>> 16 & 255;
      rgba[i * 4 + 1] = pixel >>> 8 & 255;
      rgba[i * 4 + 2] = pixel & 255;
      rgba[i * 4 + 3] = alpha;
    }
    return rgba;
  }
  reset() {
    this.executor.reset();
    this.hostAudio.reset();
    this.pcmAudio.reset();
    this.surface.clear();
  }
};
function emptyAudio() {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat: false,
    beatLevel: 0
  };
}

// assets/avs/avsres_texer_circle_edgeonly_19x19.bmp
var avsres_texer_circle_edgeonly_19x19_default = "./avs/avsres_texer_circle_edgeonly_19x19-2AU2Z2B4.bmp";

// assets/avs/avsres_texer_circle_edgeonly_29x29.bmp
var avsres_texer_circle_edgeonly_29x29_default = "./avs/avsres_texer_circle_edgeonly_29x29-AEV25G5H.bmp";

// assets/avs/avsres_texer_circle_heavyblur_19x19.bmp
var avsres_texer_circle_heavyblur_19x19_default = "./avs/avsres_texer_circle_heavyblur_19x19-XCIMZX4U.bmp";

// assets/avs/avsres_texer_circle_heavyblur_21x21.bmp
var avsres_texer_circle_heavyblur_21x21_default = "./avs/avsres_texer_circle_heavyblur_21x21-DZ5ZZ76B.bmp";

// assets/avs/avsres_texer_circle_sharp_19x19.bmp
var avsres_texer_circle_sharp_19x19_default = "./avs/avsres_texer_circle_sharp_19x19-BXF25YUK.bmp";

// assets/avs/flow3.0-5.bmp
var flow3_0_5_default = "./avs/flow3.0-5-I6AULOEX.bmp";

// assets/avs/skupers_lp6_02.bmp
var skupers_lp6_02_default = "./avs/skupers_lp6_02-HFOTKZGN.bmp";

// assets/avs/skupers_lp7_01.bmp
var skupers_lp7_01_default = "./avs/skupers_lp7_01-NIIPBEPY.bmp";

// assets/avs/sv_architectimage_256.bmp
var sv_architectimage_256_default = "./avs/sv_architectimage_256-X6GDU76I.bmp";

// assets/avs/sv_architectimage_buffer.bmp
var sv_architectimage_buffer_default = "./avs/sv_architectimage_buffer-KS7TL4M3.bmp";

// assets/avs/sv_texer_simplefade.bmp
var sv_texer_simplefade_default = "./avs/sv_texer_simplefade-UNROLEGO.bmp";

// assets/avs/tug_3dpack_texer4.bmp
var tug_3dpack_texer4_default = "./avs/tug_3dpack_texer4-Z5RSPR47.bmp";

// assets/avs/tug_bit2_texer5.bmp
var tug_bit2_texer5_default = "./avs/tug_bit2_texer5-ZZPSCHKO.bmp";

// assets/avs/tug_ti_texer2.bmp
var tug_ti_texer2_default = "./avs/tug_ti_texer2-6UGAP5LW.bmp";

// assets/avs/whacko6-06.bmp
var whacko6_06_default = "./avs/whacko6-06-5BTGWY46.bmp";

// assets/avs/whacko6-07.bmp
var whacko6_07_default = "./avs/whacko6-07-F2MCLU2T.bmp";

// src/avs/bundled-bitmaps.ts
var BUNDLED = {
  "avsres_texer_circle_edgeonly_19x19.bmp": avsres_texer_circle_edgeonly_19x19_default,
  "avsres_texer_circle_edgeonly_29x29.bmp": avsres_texer_circle_edgeonly_29x29_default,
  "avsres_texer_circle_heavyblur_19x19.bmp": avsres_texer_circle_heavyblur_19x19_default,
  "avsres_texer_circle_heavyblur_21x21.bmp": avsres_texer_circle_heavyblur_21x21_default,
  "avsres_texer_circle_sharp_19x19.bmp": avsres_texer_circle_sharp_19x19_default,
  "flow3.0-5.bmp": flow3_0_5_default,
  "skupers_lp6_02.bmp": skupers_lp6_02_default,
  "skupers_lp7_01.bmp": skupers_lp7_01_default,
  "sv_architectimage_256.bmp": sv_architectimage_256_default,
  "sv_architectimage_buffer.bmp": sv_architectimage_buffer_default,
  "sv_texer_simplefade.bmp": sv_texer_simplefade_default,
  "tug_3dpack_texer4.bmp": tug_3dpack_texer4_default,
  "tug_bit2_texer5.bmp": tug_bit2_texer5_default,
  "tug_ti_texer2.bmp": tug_ti_texer2_default,
  "whacko6-06.bmp": whacko6_06_default,
  "whacko6-07.bmp": whacko6_07_default
};
var bundledResolver;
function loadBundledAvsBitmapResolver() {
  bundledResolver ??= Promise.all(Object.entries(BUNDLED).map(async ([name, url]) => {
    const response = await fetch(new URL(url, import.meta.url));
    if (!response.ok) throw new Error(`Could not load AVS bitmap ${name}: HTTP ${response.status}`);
    return [name, new Uint8Array(await response.arrayBuffer())];
  })).then((entries) => createAvsBitmapResolver(new Map(entries)));
  return bundledResolver;
}

// src/avs-presentation.ts
var LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function copyAvsPixelsToRgba(source, rgba, rgbaWords) {
  if (rgba.length !== source.length * 4) {
    throw new RangeError(`RGBA buffer has ${rgba.length} bytes, expected ${source.length * 4}`);
  }
  if (LITTLE_ENDIAN) {
    const words = rgbaWords ?? new Uint32Array(rgba.buffer, rgba.byteOffset, source.length);
    if (words.length !== source.length) throw new RangeError("RGBA word view has the wrong length");
    for (let i = 0; i < source.length; i++) {
      const pixel = source[i];
      words[i] = 4278190080 | (pixel & 255) << 16 | pixel & 65280 | pixel >>> 16 & 255;
    }
    return;
  }
  for (let i = 0; i < source.length; i++) {
    const pixel = source[i];
    const offset = i * 4;
    rgba[offset] = pixel >>> 16 & 255;
    rgba[offset + 1] = pixel >>> 8 & 255;
    rgba[offset + 2] = pixel & 255;
    rgba[offset + 3] = 255;
  }
}

// src/avs-render.worker.ts
var scope = globalThis;
var runtime = null;
var generation = 0;
var surface = null;
var context = null;
var image = null;
var imageWords = null;
scope.onmessage = (event) => {
  void handle(event.data).catch((error) => {
    scope.postMessage({
      type: "error",
      generation,
      message: error instanceof Error ? error.message : String(error),
      fatal: true
    });
  });
};
async function handle(message) {
  if (message.type === "clear") {
    generation = message.generation;
    runtime = null;
    image = null;
    imageWords = null;
    return;
  }
  if (message.type === "load") {
    generation = message.generation;
    const resolver = await loadBundledAvsBitmapResolver();
    if (generation !== message.generation) return;
    const registry = createAvsCompatibilityRegistry({}, { bitmapResolver: resolver });
    runtime = new AvsCompatibilityRuntime(message.preset, message.width, message.height, registry);
    const warmup = runtime.render(void 0, true);
    ensureSurface(warmup.framebuffer.width, warmup.framebuffer.height);
    scope.postMessage({ type: "ready", generation, unsupported: warmup.stats.unsupported });
    return;
  }
  if (message.generation !== generation || !runtime) {
    const blank = new OffscreenCanvas(1, 1).transferToImageBitmap();
    scope.postMessage({
      type: "frame",
      generation: message.generation,
      sequence: message.sequence,
      pcm: message.pcm,
      bitmap: blank,
      width: 1,
      height: 1,
      unsupported: 0,
      renderMs: 0
    }, [message.pcm, blank]);
    return;
  }
  const started = performance.now();
  runtime.resize(message.width, message.height);
  const pcm = new Float32Array(message.pcm);
  const frame = runtime.renderPcm({ left: pcm.subarray(0, 576), right: pcm.subarray(576) });
  ensureSurface(frame.framebuffer.width, frame.framebuffer.height);
  copyAvsPixelsToRgba(frame.framebuffer.pixels, image.data, imageWords);
  context.putImageData(image, 0, 0);
  const bitmap = surface.transferToImageBitmap();
  const renderMs = performance.now() - started;
  scope.postMessage({
    type: "frame",
    generation,
    sequence: message.sequence,
    pcm: message.pcm,
    bitmap,
    width: frame.framebuffer.width,
    height: frame.framebuffer.height,
    unsupported: frame.stats.unsupported,
    renderMs
  }, [message.pcm, bitmap]);
}
function ensureSurface(width, height) {
  if (!surface) {
    surface = new OffscreenCanvas(width, height);
    context = surface.getContext("2d", { alpha: false });
    if (!context) throw new Error("OffscreenCanvas 2D is unavailable");
  }
  if (surface.width !== width || surface.height !== height) {
    surface.width = width;
    surface.height = height;
    image = null;
    imageWords = null;
  }
  if (!image) {
    image = new ImageData(width, height);
    imageWords = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height);
  }
}
