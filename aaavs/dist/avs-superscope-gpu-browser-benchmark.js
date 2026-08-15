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
    let children2 = [];
    if (effectId === EFFECT_LIST_ID && payload.length > 0) {
      list = readListSettings(payload, payloadStart);
      let childOffset = list.byteLength;
      const codeRecord = readEffectListCode(payload, childOffset, payloadStart);
      if (codeRecord) {
        listCode = codeRecord.code;
        childOffset = codeRecord.nextOffset;
      }
      children2 = readComponents(payload, childOffset, payload.length, path, absoluteBase + payloadStart);
    }
    components.push({
      effectId,
      apeId,
      payload,
      fileOffset: absoluteBase + cursor,
      path,
      children: children2,
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
  const readString2 = () => {
    if (cursor + 4 > raw.length) return "";
    const length = u32(raw, cursor);
    cursor += 4;
    const end = Math.min(raw.length, cursor + length);
    const value = nulText(raw.subarray(cursor, end));
    cursor = end;
    return value;
  };
  return { enabled, init: readString2(), frame: readString2() };
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
      this.lines.push(`const ${result}=${this.assignment(operator, left, rightTemp)};`);
      this.lines.push(`${targetAccess}=${result};`);
      return result;
    }
    if (isMemoryCall(target)) {
      const address = this.store(this.expression(target.args[0]));
      const right = this.store(this.expression(valueNode));
      const global = target.name === "gmegabuf";
      const left = this.store(`vm.readMemory(${global},${address})`);
      const result = this.temp();
      this.lines.push(`const ${result}=${this.assignment(operator, left, right)};`);
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
  /** Inline the compile-time-known assignment operator in hot point scripts. */
  assignment(operator, left, right) {
    switch (operator) {
      case "=":
        return `H.finite(${right})`;
      case "+=":
        return `H.finite((${left})+(${right}))`;
      case "-=":
        return `H.finite((${left})-(${right}))`;
      case "*=":
        return `H.finite((${left})*(${right}))`;
      case "/=":
        return `H.divide(${left},${right})`;
      case "%=":
        return `H.modulo(${left},${right})`;
      case "|=":
        return `(H.integer(${left})|H.integer(${right}))`;
      case "&=":
        return `(H.integer(${left})&H.integer(${right}))`;
      case "^=":
        return `(H.integer(${left})^H.integer(${right}))`;
      case "**=":
        return `H.finite(Math.pow(${left},${right}))`;
      default:
        throw new UnsupportedJitNode();
    }
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
  const bind = (vm) => bindJit ? bindJit(vm) : () => fallback(vm);
  let boundVm;
  let boundExecute;
  const execute = (vm) => {
    if (vm !== boundVm) {
      boundVm = vm;
      boundExecute = bind(vm);
    }
    return boundExecute();
  };
  return { source: ast.source, ast, bind, execute };
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
var AVS_BLEND_TABLE = (() => {
  const values = new Uint8Array(256 * 256);
  for (let x = 0; x < 256; x++) {
    const row = x << 8;
    for (let y = 0; y < 256; y++) values[row | y] = Math.trunc(x / 255 * y);
  }
  return values;
})();

// src/avs/effects/convolution.ts
var AVS_CONVOLUTION_KERNEL_SIZE = 7;
var KERNEL_CELLS = AVS_CONVOLUTION_KERNEL_SIZE ** 2;
var CORE_BYTES = (4 + KERNEL_CELLS + 2) * 4;

// src/avs/effects/bump.ts
var TEXT2 = new TextDecoder("windows-1252");

// src/avs/effects/dynamic-movement.ts
var TEXT3 = new TextDecoder("windows-1252");

// src/avs/effects/movement.ts
var TEXT4 = new TextDecoder("windows-1252");
var OFFSET_MASK = (1 << 22) - 1;
var BILINEAR_WEIGHTS = (() => {
  const weights = [
    new Uint8Array(32 * 32),
    new Uint8Array(32 * 32),
    new Uint8Array(32 * 32),
    new Uint8Array(32 * 32)
  ];
  for (let x = 0; x < 32; x++) {
    const xp = x << 3;
    const inverseX = 255 - xp;
    for (let y = 0; y < 32; y++) {
      const yp = y << 3;
      const inverseY = 255 - yp;
      const key = x << 5 | y;
      weights[0][key] = AVS_BLEND_TABLE[inverseX << 8 | inverseY];
      weights[1][key] = AVS_BLEND_TABLE[xp << 8 | inverseY];
      weights[2][key] = AVS_BLEND_TABLE[inverseX << 8 | yp];
      weights[3][key] = AVS_BLEND_TABLE[xp << 8 | yp];
    }
  }
  return weights;
})();

// src/avs/effects/scripted-transforms.ts
var TEXT5 = new TextDecoder("windows-1252");

// src/avs/effects/superscope.ts
var TEXT6 = new TextDecoder("windows-1252");
var MAX_POINTS = 128 * 1024;
function decodeAvsSuperScope(payload) {
  let offset = 0;
  let scripts = ["", "", "", ""];
  if (payload[0] === 1) {
    offset = 1;
    for (let i = 0; i < 4; i++) {
      const decoded = readString(payload, offset);
      scripts[i] = decoded.value;
      offset = decoded.next;
    }
  } else if (payload.length >= 1024) {
    scripts = [0, 256, 512, 768].map((start) => nulText2(payload.subarray(start, start + 256)));
    offset = 1024;
  }
  const channel = readI32(payload, offset, 2);
  offset += 4;
  const declaredColors = readI32(payload, offset, 1);
  offset += 4;
  const colors = [];
  if (declaredColors >= 0 && declaredColors <= 16) {
    for (let i = 0; i < declaredColors && offset + 4 <= payload.length; i++, offset += 4) {
      colors.push(readI32(payload, offset, 0) & 16777215);
    }
  }
  const mode = readI32(payload, offset, 0);
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
function readString(payload, offset) {
  if (offset + 4 > payload.length) return { value: "", next: payload.length };
  const length = readU32(payload, offset, 0);
  const start = offset + 4;
  const end = Math.min(payload.length, start + length);
  return { value: nulText2(payload.subarray(start, end)), next: end };
}
function readI32(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function readU32(payload, offset, fallback) {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(offset, true) : fallback;
}
function nulText2(bytes) {
  const end = bytes.indexOf(0);
  return TEXT6.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

// src/avs/effects/text.ts
var WINDOWS_1252 = new TextDecoder("windows-1252");

// src/avs/effects/texer.ts
var TEXT7 = new TextDecoder("windows-1252");

// src/avs/effects/superscope-gpu.ts
var AVS_ENHANCED_SUPERSCOPE_GPU_CAPABILITY = {
  id: "enhanced-superscope-f32-generator",
  backend: "webgpu",
  lane: "120",
  byteExact: false,
  reason: "Parallel f32 point evaluation changes classic AVS f64 rounding and cannot preserve point-to-point mutation."
};
var INPUTS = /* @__PURE__ */ new Set(["i", "v"]);
var OUTPUTS = ["x", "y", "red", "green", "blue", "skip", "drawmode", "linesize"];
var WORKGROUP_SIZE = 256;
var OUTPUT_STRIDE = 16;
function compileEnhancedSuperScopeGpu(source) {
  let ast;
  try {
    ast = parseAvsEel(source);
  } catch (error) {
    return { eligible: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const analysis = analysePointProgram(ast.body);
  if (!analysis.ok) return { eligible: false, reason: analysis.reason };
  try {
    const builder = new WgslBuilder(analysis.uniformNames);
    const body = builder.program(ast.body);
    return {
      eligible: true,
      program: {
        source,
        wgsl: shaderSource(body, analysis.uniformNames, builder.localNames),
        uniformNames: analysis.uniformNames,
        workgroupSize: WORKGROUP_SIZE,
        outputStrideBytes: OUTPUT_STRIDE,
        usesHostAudio: analysis.usesHostAudio
      }
    };
  } catch (error) {
    return { eligible: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
var EnhancedSuperScopeGpuGenerator = class {
  capability = AVS_ENHANCED_SUPERSCOPE_GPU_CAPABILITY;
  program;
  maxPoints;
  device;
  pipeline;
  audioBuffer;
  hostAudioBuffer;
  variableBuffer;
  paramsBuffer;
  outputBuffer;
  bindGroup;
  packedAudio = new Uint32Array(576);
  packedHostAudio = new Uint32Array(576 * 4);
  packedVariables;
  packedParams = new Uint32Array(8);
  destroyed = false;
  constructor(device, program, maxPoints = 128 * 1024) {
    if (!Number.isInteger(maxPoints) || maxPoints <= 0) throw new RangeError(`Invalid SuperScope point capacity ${maxPoints}`);
    const outputBytes = maxPoints * OUTPUT_STRIDE;
    if (outputBytes > Number(device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError(`SuperScope point buffer needs ${outputBytes} bytes; adapter limit is ${device.limits.maxStorageBufferBindingSize}`);
    }
    this.device = device;
    this.program = program;
    this.maxPoints = maxPoints;
    this.packedVariables = new Float32Array(Math.max(4, program.uniformNames.length));
    const module = device.createShaderModule({ label: "AVS enhanced f32 SuperScope generator", code: program.wgsl });
    this.pipeline = device.createComputePipeline({
      label: "AVS enhanced f32 SuperScope generator",
      layout: "auto",
      compute: { module, entryPoint: "superscope_points" }
    });
    this.audioBuffer = storageBuffer(device, "AVS SuperScope audio", this.packedAudio.byteLength, GPUBufferUsage.COPY_DST);
    this.hostAudioBuffer = storageBuffer(device, "AVS SuperScope host audio", this.packedHostAudio.byteLength, GPUBufferUsage.COPY_DST);
    this.variableBuffer = storageBuffer(device, "AVS SuperScope variables", this.packedVariables.byteLength, GPUBufferUsage.COPY_DST);
    this.paramsBuffer = device.createBuffer({
      label: "AVS SuperScope generator params",
      size: this.packedParams.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.outputBuffer = storageBuffer(device, "AVS SuperScope generated points", outputBytes, GPUBufferUsage.COPY_SRC);
    this.bindGroup = device.createBindGroup({
      label: "AVS enhanced SuperScope generator inputs",
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.audioBuffer } },
        { binding: 1, resource: { buffer: this.hostAudioBuffer } },
        { binding: 2, resource: { buffer: this.variableBuffer } },
        { binding: 3, resource: { buffer: this.paramsBuffer } },
        { binding: 4, resource: { buffer: this.outputBuffer } }
      ]
    });
  }
  /** Uploads only 2.3 KiB of audio plus scalar state; generated points stay resident. */
  writeFrame(frame) {
    this.assertActive();
    if (frame.audio.length < 576) throw new RangeError(`SuperScope audio needs 576 samples, got ${frame.audio.length}`);
    const count = clampInt(frame.count, 0, this.maxPoints);
    for (let index = 0; index < 576; index++) this.packedAudio[index] = frame.audio[index];
    for (let index = 0; index < this.program.uniformNames.length; index++) {
      const value = frame.variables[this.program.uniformNames[index]] ?? 0;
      this.packedVariables[index] = Number.isFinite(value) ? value : 0;
    }
    this.packedParams.set([count, frame.width >>> 0, frame.height >>> 0, frame.xor, this.program.uniformNames.length]);
    this.device.queue.writeBuffer(this.audioBuffer, 0, this.packedAudio);
    if (this.program.usesHostAudio) {
      if (!frame.hostAudio) throw new Error("SuperScope GPU point script uses getosc/getspec but no hostAudio was supplied");
      this.packHostAudio(frame.hostAudio);
      this.device.queue.writeBuffer(this.hostAudioBuffer, 0, this.packedHostAudio);
    }
    this.device.queue.writeBuffer(
      this.variableBuffer,
      0,
      this.packedVariables.buffer,
      this.packedVariables.byteOffset,
      this.packedVariables.byteLength
    );
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.packedParams);
    return count;
  }
  encode(encoder, count) {
    this.assertActive();
    const bounded = clampInt(count, 0, this.maxPoints);
    if (bounded !== 0) {
      const pass = encoder.beginComputePass({ label: "AVS enhanced f32 SuperScope points" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.dispatchWorkgroups(Math.ceil(bounded / WORKGROUP_SIZE));
      pass.end();
    }
    return { output: this.outputBuffer, count: bounded, outputStrideBytes: OUTPUT_STRIDE };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.audioBuffer.destroy();
    this.hostAudioBuffer.destroy();
    this.variableBuffer.destroy();
    this.paramsBuffer.destroy();
    this.outputBuffer.destroy();
  }
  assertActive() {
    if (this.destroyed) throw new Error("AVS enhanced SuperScope generator is destroyed");
  }
  packHostAudio(audio) {
    const channels = [audio.waveform[0], audio.waveform[1], audio.spectrum[0], audio.spectrum[1]];
    for (let channel = 0; channel < channels.length; channel++) {
      const source = channels[channel];
      for (let index = 0; index < 576; index++) this.packedHostAudio[channel * 576 + index] = source[index];
    }
  }
};
function analysePointProgram(root) {
  const values = root.kind === "sequence" ? root.values : [root];
  const written = /* @__PURE__ */ new Set();
  collectWrites(root, written);
  const initialized = new Set(INPUTS);
  const reads = /* @__PURE__ */ new Set();
  for (const node of values) {
    const assignment2 = directAssignment(node);
    if (assignment2) {
      const target = normalize(assignment2.target);
      const failure2 = validatePure(assignment2.value, written, initialized, reads);
      if (failure2) return { ok: false, reason: failure2 };
      if (assignment2.operator !== "=" && !initialized.has(target)) {
        return { ok: false, reason: `${target}${assignment2.operator} carries point-to-point state` };
      }
      initialized.add(target);
      continue;
    }
    const failure = validatePure(node, written, initialized, reads);
    if (failure) return { ok: false, reason: failure };
  }
  for (const name of OUTPUTS) {
    if (written.has(name) && !initialized.has(name)) return { ok: false, reason: `${name} is not initialized on every point` };
    if (!initialized.has(name)) reads.add(name);
  }
  const uniformNames = [...reads].filter((name) => !INPUTS.has(name)).sort();
  return { ok: true, uniformNames, usesHostAudio: containsHostAudio(root) };
}
function collectWrites(node, target) {
  if (node.kind === "assign" && node.target.kind === "variable") target.add(normalize(node.target.name));
  if (node.kind === "call" && node.name === "assign" && node.args[0]?.kind === "variable") target.add(normalize(node.args[0].name));
  for (const child of children(node)) collectWrites(child, target);
}
function validatePure(node, written, initialized, reads) {
  if (node.kind === "variable") {
    const name = normalize(node.name);
    if (written.has(name) && !initialized.has(name)) return `${name} is read before per-point initialization`;
    reads.add(name);
    return null;
  }
  if (node.kind === "assign" || node.kind === "call" && node.name === "assign") {
    return "nested or conditional mutation is order-sensitive";
  }
  if (node.kind === "call" && ["loop", "rand", "megabuf", "gmegabuf", "gettime", "getkbmouse"].includes(node.name)) {
    return `${node.name} is not point-independent`;
  }
  for (const child of children(node)) {
    const failure = validatePure(child, written, initialized, reads);
    if (failure) return failure;
  }
  return null;
}
function directAssignment(node) {
  if (node.kind === "assign" && node.target.kind === "variable") {
    return { target: node.target.name, operator: node.operator, value: node.value };
  }
  if (node.kind === "call" && node.name === "assign" && node.args[0]?.kind === "variable" && node.args[1]) {
    return { target: node.args[0].name, operator: "=", value: node.args[1] };
  }
  return null;
}
var WgslBuilder = class {
  localNames = /* @__PURE__ */ new Set();
  temporary = 0;
  uniformIndex = /* @__PURE__ */ new Map();
  constructor(uniformNames) {
    uniformNames.forEach((name, index) => this.uniformIndex.set(name, index));
  }
  program(root) {
    const values = root.kind === "sequence" ? root.values : [root];
    const lines = [];
    for (const node of values) {
      const assignment2 = directAssignment(node);
      if (!assignment2) {
        lines.push(`_result = finite(${this.expression(node)});`);
        continue;
      }
      const target = this.name(assignment2.target);
      this.localNames.add(target);
      const right = this.expression(assignment2.value);
      const next = assignmentExpression(assignment2.operator, target, right);
      lines.push(`${target} = ${next};`, `_result = ${target};`);
    }
    return lines.join("\n  ");
  }
  expression(node) {
    switch (node.kind) {
      case "number":
        return numberLiteral2(node.value);
      case "variable":
        return this.variable(node.name);
      case "unary": {
        const value = this.expression(node.value);
        if (node.operator === "+") return `finite(${value})`;
        if (node.operator === "-") return `finite(-(${value}))`;
        if (node.operator === "!") return `select(1.0,0.0,truth(${value}))`;
        if (node.operator === "~") return `f32(~i32(${value}))`;
        throw new Error(`Unsupported unary ${node.operator}`);
      }
      case "binary":
        return this.binary(node.operator, node.left, node.right);
      case "conditional":
        return `select(${this.expression(node.no)},${this.expression(node.yes)},truth(${this.expression(node.condition)}))`;
      case "call":
        return this.call(node.name, node.args);
      case "sequence": {
        if (node.values.length !== 1) throw new Error("Nested sequence is not GPU-pure");
        return this.expression(node.values[0]);
      }
      case "assign":
        throw new Error("Nested assignment is not GPU-pure");
    }
  }
  binary(operator, leftNode, rightNode) {
    const left = this.expression(leftNode);
    const right = this.expression(rightNode);
    switch (operator) {
      case "+":
        return `finite((${left})+(${right}))`;
      case "-":
        return `finite((${left})-(${right}))`;
      case "*":
        return `finite((${left})*(${right}))`;
      case "/":
        return `divide(${left},${right})`;
      case "%":
        return `modulo(${left},${right})`;
      case "**":
        return `finite(pow(${left},${right}))`;
      case "|":
        return `f32(i32(${left})|i32(${right}))`;
      case "&":
        return `f32(i32(${left})&i32(${right}))`;
      case "^":
        return `f32(i32(${left})^i32(${right}))`;
      case "<<":
        return `f32(i32(${left})<<(u32(i32(${right}))&31u))`;
      case ">>":
        return `f32(i32(${left})>>(u32(i32(${right}))&31u))`;
      case "&&":
        return `select(0.0,select(0.0,1.0,truth(${right})),truth(${left}))`;
      case "||":
        return `select(select(0.0,1.0,truth(${right})),1.0,truth(${left}))`;
      case "==":
        return `select(0.0,1.0,close(${left},${right}))`;
      case "!=":
        return `select(1.0,0.0,close(${left},${right}))`;
      case "===":
        return `select(0.0,1.0,(${left})==(${right}))`;
      case "!==":
        return `select(0.0,1.0,(${left})!=(${right}))`;
      case "<":
      case "<=":
      case ">":
      case ">=":
        return `select(0.0,1.0,(${left})${operator}(${right}))`;
      default:
        throw new Error(`Unsupported binary ${operator}`);
    }
  }
  call(name, nodes) {
    if (name === "if") return `select(${this.expression(nodes[2])},${this.expression(nodes[1])},truth(${this.expression(nodes[0])}))`;
    const args = nodes.map((node) => this.expression(node));
    const one = (fn) => `finite(${fn}(${args[0]}))`;
    const two = (fn) => `finite(${fn}(${args[0]},${args[1]}))`;
    switch (name) {
      case "sin":
      case "cos":
      case "tan":
      case "asin":
      case "acos":
      case "atan":
      case "sqrt":
      case "exp":
      case "log":
      case "log2":
      case "abs":
      case "floor":
      case "ceil":
        return one(name);
      case "atan2":
        return two("atan2");
      case "sqr":
        return `finite((${args[0]})*(${args[0]}))`;
      case "invsqrt":
        return `finite(inverseSqrt(${args[0]}))`;
      case "pow":
      case "min":
      case "max":
        return two(name);
      case "log10":
        return `finite(log2(${args[0]})/log2(10.0))`;
      case "int":
        return `finite(trunc(${args[0]}))`;
      case "sign":
        return `select(select(0.0,1.0,(${args[0]})>0.0),-1.0,(${args[0]})<0.0)`;
      case "equal":
        return `select(0.0,1.0,close(${args[0]},${args[1]}))`;
      case "above":
        return `select(0.0,1.0,(${args[0]})>(${args[1]}))`;
      case "below":
        return `select(0.0,1.0,(${args[0]})<(${args[1]}))`;
      case "band":
        return `select(0.0,1.0,truth(${args[0]})&&truth(${args[1]}))`;
      case "bor":
        return `select(0.0,1.0,truth(${args[0]})||truth(${args[1]}))`;
      case "bnot":
        return `select(1.0,0.0,truth(${args[0]}))`;
      case "getosc":
        return `avs_audio(0u,${args[0]},${args[1]},${args[2]})`;
      case "getspec":
        return `avs_audio(1u,${args[0]},${args[1]},${args[2]})`;
      default:
        throw new Error(`Function ${name} is not supported by enhanced GPU SuperScope`);
    }
  }
  variable(rawName) {
    const raw = normalize(rawName);
    if (raw === "$pi") return "3.14159265358979323846";
    if (raw === "$e") return "2.71828182845904523536";
    if (raw === "$phi") return "1.61803398874989484820";
    const name = this.name(raw);
    if (INPUTS.has(raw) || this.localNames.has(name)) return name;
    const index = this.uniformIndex.get(raw);
    if (index === void 0) throw new Error(`Missing GPU input ${raw}`);
    return `initial[${index}u]`;
  }
  name(rawName) {
    const normalized = normalize(rawName).replace(/^\$/, "");
    return `v_${normalized.replace(/[^a-z0-9_]/g, "_")}`;
  }
};
function shaderSource(body, uniformNames, localNames) {
  const safeLocals = new Set(localNames);
  safeLocals.add("v_x");
  safeLocals.add("v_y");
  safeLocals.add("v_red");
  safeLocals.add("v_green");
  safeLocals.add("v_blue");
  safeLocals.add("v_skip");
  safeLocals.add("v_drawmode");
  safeLocals.add("v_linesize");
  const declarations = [...safeLocals].sort().map((name) => {
    const raw = name.slice(2);
    const index = uniformNames.indexOf(raw);
    return `var ${name}: f32 = ${index < 0 ? "0.0" : `initial[${index}u]`};`;
  }).join("\n  ");
  return (
    /* wgsl */
    `
struct Params { count: u32, width: u32, height: u32, xor_mask: u32, variable_count: u32, _p0: u32, _p1: u32, _p2: u32 };
struct ScopePoint { x: i32, y: i32, color: u32, flags: u32 };
@group(0) @binding(0) var<storage, read> audio: array<u32>;
@group(0) @binding(1) var<storage, read> host_audio: array<u32>;
@group(0) @binding(2) var<storage, read> initial: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<storage, read_write> points: array<ScopePoint>;

fn finite(value: f32) -> f32 { return select(0.0, value, value == value && abs(value) <= 3.402823e38); }
fn truth(value: f32) -> bool { return abs(value) >= 0.00001; }
fn close(a: f32, b: f32) -> bool { return abs(a - b) < 0.00001; }
fn divide(a: f32, b: f32) -> f32 { return select(finite(a / b), 0.0, abs(b) < 1.1920929e-7); }
fn modulo(a: f32, b: f32) -> f32 { return select(finite(a % b), 0.0, abs(b) < 1.1920929e-7); }
fn byte(value: f32) -> u32 { return u32(clamp(value, 0.0, 1.0) * 255.0); }
fn avs_audio(kind: u32, band: f32, width: f32, channel_value: f32) -> f32 {
  let channel = i32(floor(channel_value + 0.5));
  if (channel < 0 || channel > 2) { return 0.0; }
  var centre = i32(band * 576.0);
  var span = max(1, i32(width * 576.0));
  centre -= span / 2;
  if (centre < 0) { span += centre; centre = 0; }
  centre = min(centre, 575);
  span = min(span, 576 - centre);
  if (span <= 0) { return 0.0; }
  var sum = 0.0;
  for (var sample = centre; sample < centre + span; sample++) {
    let base = kind * 1152u;
    let left_byte = host_audio[base + u32(sample)];
    let right_byte = host_audio[base + 576u + u32(sample)];
    var left = f32(left_byte) / 255.0;
    var right = f32(right_byte) / 255.0;
    if (kind == 0u) {
      left = f32(select(i32(left_byte), i32(left_byte) - 256, left_byte >= 128u)) / 127.5;
      right = f32(select(i32(right_byte), i32(right_byte) - 256, right_byte >= 128u)) / 127.5;
    }
    sum += select(select(left, right, channel == 2), (left + right) * 0.5, channel == 0);
  }
  return sum / f32(span);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn superscope_points(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= params.count) { return; }
  let audio_position = f32(index) * 576.0 / f32(params.count);
  let source_index = min(575u, u32(audio_position));
  let fraction = audio_position - f32(source_index);
  let a = f32(audio[source_index] ^ params.xor_mask);
  let b = f32(audio[min(575u, source_index + 1u)] ^ params.xor_mask);
  var v_v = (a * (1.0 - fraction) + b * fraction) / 128.0 - 1.0;
  var v_i = select(f32(index) / f32(params.count - 1u), 0.0, params.count == 1u);
  ${declarations}
  var _result = 0.0;
  ${body}
  let color = byte(v_blue) | (byte(v_green) << 8u) | (byte(v_red) << 16u);
  let skipped = select(0u, 1u, v_skip >= 0.00001);
  let line = select(0u, 2u, v_drawmode >= 0.00001);
  let line_size = u32(clamp(trunc(v_linesize + 0.5), 1.0, 255.0));
  points[index] = ScopePoint(
    i32(trunc((v_x + 1.0) * f32(params.width) * 0.5)),
    i32(trunc((v_y + 1.0) * f32(params.height) * 0.5)),
    color,
    skipped | line | (line_size << 8u),
  );
}`
  );
}
function assignmentExpression(operator, left, right) {
  switch (operator) {
    case "=":
      return `finite(${right})`;
    case "+=":
      return `finite(${left}+(${right}))`;
    case "-=":
      return `finite(${left}-(${right}))`;
    case "*=":
      return `finite(${left}*(${right}))`;
    case "/=":
      return `divide(${left},${right})`;
    case "%=":
      return `modulo(${left},${right})`;
    case "|=":
      return `f32(i32(${left})|i32(${right}))`;
    case "&=":
      return `f32(i32(${left})&i32(${right}))`;
    case "^=":
      return `f32(i32(${left})^i32(${right}))`;
    case "**=":
      return `finite(pow(${left},${right}))`;
    default:
      throw new Error(`Unsupported assignment ${operator}`);
  }
}
function containsHostAudio(node) {
  if (node.kind === "call" && (node.name === "getosc" || node.name === "getspec")) return true;
  return children(node).some(containsHostAudio);
}
function children(node) {
  switch (node.kind) {
    case "number":
    case "variable":
      return [];
    case "unary":
      return [node.value];
    case "binary":
      return [node.left, node.right];
    case "conditional":
      return [node.condition, node.yes, node.no];
    case "assign":
      return [node.target, node.value];
    case "call":
      return node.args;
    case "sequence":
      return node.values;
  }
}
function storageBuffer(device, label, size, extra) {
  return device.createBuffer({ label, size: Math.max(16, align(size, 16)), usage: GPUBufferUsage.STORAGE | extra });
}
function normalize(name) {
  return name.toLowerCase().slice(0, 8);
}
function numberLiteral2(value) {
  if (!Number.isFinite(value)) return "0.0";
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}
function clampInt(value, minimum, maximum) {
  const integer2 = Number.isFinite(value) ? Math.trunc(value) : 0;
  return integer2 < minimum ? minimum : integer2 > maximum ? maximum : integer2;
}
function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

// tools/avs-superscope-gpu-browser-benchmark.ts
var PRESET = "/assets/avs-presets/winamp-5-picks/jheriko%20-%20not%20quite%20a%20bendy%20tunnel%20(skupers%20remix).avs";
var points = 8192;
var frames = 5;
var samples = 5;
void run().catch((error) => finish({ error: errorText(error) }));
async function run() {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const response = await fetch(PRESET);
  if (!response.ok) throw new Error(`Preset fetch failed: ${response.status}`);
  const ast = parseAvsPreset(new Uint8Array(await response.arrayBuffer()));
  const candidates = [];
  visit(ast.components, (component) => {
    if (component.apeId || component.effectId !== 36) return;
    const source = decodeAvsSuperScope(component.payload).point;
    const compiled2 = compileEnhancedSuperScopeGpu(source);
    if (compiled2.eligible) candidates.push({ source, bytes: source.length });
  });
  candidates.sort((a, b) => b.bytes - a.bytes);
  const selected = candidates[0];
  if (!selected) throw new Error("Preset has no enhanced-GPU-eligible SuperScope");
  const compiled = compileEnhancedSuperScopeGpu(selected.source);
  if (!compiled.eligible) throw new Error(compiled.reason);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  const diagnostics = await device.createShaderModule({ code: compiled.program.wgsl }).getCompilationInfo();
  const shaderErrors = diagnostics.messages.filter((message) => message.type === "error");
  if (shaderErrors.length) throw new Error(shaderErrors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join("\n"));
  device.pushErrorScope("validation");
  const generator = new EnhancedSuperScopeGpuGenerator(device, compiled.program, points);
  const validation = await device.popErrorScope();
  if (validation) throw validation;
  const audio = deterministicAudio();
  const variables = Object.fromEntries(compiled.program.uniformNames.map((name) => [name, 0.5]));
  const frame = {
    count: points,
    width: 1920,
    height: 1080,
    xor: 128,
    audio: audio.waveform[0],
    hostAudio: audio,
    variables
  };
  const cpu = compileAvsEel(selected.source);
  const vm = new AvsEelVm({ seed: 99539473, host: {
    getosc: (band, width, channel) => avsAudioSample(audio, "osc", band, width, channel),
    getspec: (band, width, channel) => avsAudioSample(audio, "spec", band, width, channel)
  } });
  for (const [name, value] of Object.entries(variables)) vm.set(name, value);
  const execute = cpu.bind(vm);
  const bindings = ["i", "v", "x", "y", "red", "green", "blue", "skip"].map((name) => vm.bindVariable(name));
  let checksum = 0;
  const cpuFrame = () => {
    const [i, v, x, y, red, green, blue, skip] = bindings;
    for (let index = 0; index < points; index++) {
      const position = index * 576 / points;
      const source = Math.trunc(position);
      const fraction = position - source;
      const a = audio.waveform[0][Math.min(575, source)] ^ 128;
      const b = audio.waveform[0][Math.min(575, source + 1)] ^ 128;
      i.values[i.index] = index / (points - 1);
      v.values[v.index] = (a * (1 - fraction) + b * fraction) / 128 - 1;
      execute();
      checksum += (x.values[x.index] ?? 0) + (y.values[y.index] ?? 0) + (red.values[red.index] ?? 0) + (green.values[green.index] ?? 0) + (blue.values[blue.index] ?? 0) + (skip.values[skip.index] ?? 0);
    }
  };
  const gpuBatch = async () => {
    for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
      const count = generator.writeFrame(frame);
      const encoder = device.createCommandEncoder();
      generator.encode(encoder, count);
      device.queue.submit([encoder.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
  };
  cpuFrame();
  await gpuBatch();
  const cpuMs = [];
  const gpuMs = [];
  for (let sample = 0; sample < samples; sample++) {
    let started = performance.now();
    for (let frameIndex = 0; frameIndex < frames; frameIndex++) cpuFrame();
    cpuMs.push((performance.now() - started) / frames);
    started = performance.now();
    await gpuBatch();
    gpuMs.push((performance.now() - started) / frames);
  }
  const cpuMedian = median(cpuMs);
  const gpuMedian = median(gpuMs);
  const differential = await compareOneFrame(generator, device, frame, cpuFrameSnapshot());
  const transferBytes = 576 * 4 + Math.max(16, compiled.program.uniformNames.length * 4) + 32 + (compiled.program.usesHostAudio ? 576 * 4 * 4 : 0);
  generator.destroy();
  device.destroy();
  finish({
    adapter: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description
    },
    preset: PRESET.split("/").at(-1),
    pointScriptBytes: selected.bytes,
    points,
    frames,
    samples,
    cpuMedianMs: cpuMedian,
    gpuMedianMs: gpuMedian,
    speedup: cpuMedian / gpuMedian,
    uploadBytesPerFrame: transferBytes,
    outputBytesResident: points * compiled.program.outputStrideBytes,
    readbackBytesPerFrame: 0,
    differential,
    checksum
  });
  function cpuFrameSnapshot() {
    const result = new Uint32Array(points * 4);
    const [i, v, x, y, red, green, blue, skip] = bindings;
    const drawmode = vm.bindVariable("drawmode");
    const linesize = vm.bindVariable("linesize");
    for (let index = 0; index < points; index++) {
      const position = index * 576 / points;
      const source = Math.trunc(position);
      const fraction = position - source;
      const a = audio.waveform[0][Math.min(575, source)] ^ 128;
      const b = audio.waveform[0][Math.min(575, source + 1)] ^ 128;
      i.values[i.index] = index / (points - 1);
      v.values[v.index] = (a * (1 - fraction) + b * fraction) / 128 - 1;
      execute();
      const xv = x.values[x.index] ?? 0;
      const yv = y.values[y.index] ?? 0;
      const rv = red.values[red.index] ?? 0;
      const gv = green.values[green.index] ?? 0;
      const bv = blue.values[blue.index] ?? 0;
      const skipped = (skip.values[skip.index] ?? 0) >= 1e-5 ? 1 : 0;
      const line = (drawmode.values[drawmode.index] ?? 0) >= 1e-5 ? 2 : 0;
      const size = clamp(Math.trunc((linesize.values[linesize.index] ?? 0) + 0.5), 1, 255);
      result[index * 4] = Math.trunc((xv + 1) * frame.width * 0.5);
      result[index * 4 + 1] = Math.trunc((yv + 1) * frame.height * 0.5);
      result[index * 4 + 2] = byte(bv) | byte(gv) << 8 | byte(rv) << 16;
      result[index * 4 + 3] = skipped | line | size << 8;
    }
    return result;
  }
}
async function compareOneFrame(generator, device, frame, cpu) {
  const count = generator.writeFrame(frame);
  const encoder = device.createCommandEncoder();
  const dispatch = generator.encode(encoder, count);
  const bytes = count * dispatch.outputStrideBytes;
  const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyBufferToBuffer(dispatch.output, 0, readback, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const gpu = new Uint32Array(readback.getMappedRange());
  let coordinateExact = 0;
  let coordinateWithinOne = 0;
  let colorExact = 0;
  let flagsExact = 0;
  let maxCoordinateDelta = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < count; index++) {
    const offset = index * 4;
    const xDelta = Math.abs((gpu[offset] | 0) - (cpu[offset] | 0));
    const yDelta = Math.abs((gpu[offset + 1] | 0) - (cpu[offset + 1] | 0));
    if (xDelta === 0 && yDelta === 0) coordinateExact++;
    if (xDelta <= 1 && yDelta <= 1) coordinateWithinOne++;
    maxCoordinateDelta = Math.max(maxCoordinateDelta, xDelta, yDelta);
    const gpuColor = gpu[offset + 2];
    const cpuColor = cpu[offset + 2];
    if (gpuColor === cpuColor) colorExact++;
    for (const shift of [0, 8, 16]) {
      maxChannelDelta = Math.max(maxChannelDelta, Math.abs((gpuColor >>> shift & 255) - (cpuColor >>> shift & 255)));
    }
    if (gpu[offset + 3] === cpu[offset + 3]) flagsExact++;
  }
  readback.unmap();
  readback.destroy();
  return {
    points: count,
    coordinateExactRatio: coordinateExact / count,
    coordinateWithinOneRatio: coordinateWithinOne / count,
    colorExactRatio: colorExact / count,
    flagsExactRatio: flagsExact / count,
    maxCoordinateDelta,
    maxChannelDelta
  };
}
function deterministicAudio() {
  const waveform = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)];
  const spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)];
  for (let channel = 0; channel < 2; channel++) for (let index = 0; index < AVS_AUDIO_SAMPLES; index++) {
    waveform[channel][index] = Math.trunc(Math.sin(index * (channel ? 0.113 : 0.071)) * 96) & 255;
    spectrum[channel][index] = Math.max(0, 224 - Math.trunc(index * 0.35) - channel * 13);
  }
  return { waveform, spectrum, beat: false, beatLevel: AVS_AUDIO_SAMPLES * 24 };
}
function visit(components, callback) {
  for (const component of components) {
    callback(component);
    visit(component.children, callback);
  }
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.trunc(sorted.length / 2)];
}
function byte(value) {
  return value <= 0 ? 0 : value >= 1 ? 255 : Math.trunc(value * 255);
}
function clamp(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function finish(result) {
  const output = document.querySelector("pre");
  output.textContent = JSON.stringify(result, null, 2);
  document.documentElement.dataset.done = "true";
  console.log(`AAAVS_GPU_BENCHMARK ${JSON.stringify(result)}`);
}
function errorText(error) {
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return String(error);
}
