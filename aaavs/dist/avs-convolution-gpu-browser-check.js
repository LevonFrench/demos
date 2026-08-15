// src/avs/types.ts
var AVS_AUDIO_SAMPLES = 576;
var AVS_FFT_SIZE = 512;
var AVS_FFT_BINS = AVS_FFT_SIZE / 2;

// src/avs/preset.ts
var TEXT = new TextDecoder("windows-1252");

// src/avs/audio.ts
function avsAudioSample(frame, kind, band, width2, channelValue) {
  const channel = Math.floor(channelValue + 0.5);
  if (channel < 0 || channel > 2) return 0;
  let centre = Math.trunc(band * AVS_AUDIO_SAMPLES);
  let span = Math.max(1, Math.trunc(width2 * AVS_AUDIO_SAMPLES));
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
  const execute2 = (vm) => {
    if (vm !== boundVm) {
      boundVm = vm;
      boundExecute = bind(vm);
    }
    return boundExecute();
  };
  return { source: ast.source, ast, bind, execute: execute2 };
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
  constructor(width2, height2, pixels) {
    this.width = width2;
    this.height = height2;
    if (!Number.isInteger(width2) || !Number.isInteger(height2) || width2 <= 0 || height2 <= 0) {
      throw new RangeError(`Invalid AVS framebuffer size ${width2}x${height2}`);
    }
    const length = width2 * height2;
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
      const width2 = this.width;
      for (let y = 0; y < this.height; y += 2) {
        const end = (y + 1) * width2;
        for (let i = y * width2; i < end; i++) destination[i] = input[i];
      }
      return;
    }
    if (mode === "every-other-pixel") {
      const width2 = this.width;
      for (let y = 0; y < this.height; y++) {
        const end = (y + 1) * width2;
        for (let i = y * width2 + (y & 1); i < end; i += 2) destination[i] = input[i];
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
  get(index, width2, height2, create = true) {
    if (!Number.isInteger(index) || index < 0 || index >= 8) return null;
    const current = this.buffers[index];
    if (current?.width === width2 && current.height === height2) return current;
    if (!create) return null;
    const next = new AvsFramebuffer(width2, height2);
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
    this.indexComponents(preset.components, null);
  }
  buffers = new AvsBufferBank();
  stats = { rendered: 0, unsupported: 0, lists: 0 };
  /** Preset-global EEL registers/gmegabuf shared with registered codeable effects. */
  eelGlobal;
  retained = /* @__PURE__ */ new Map();
  alternates = /* @__PURE__ */ new Map();
  beatFrames = /* @__PURE__ */ new Map();
  listEel = /* @__PURE__ */ new Map();
  components = /* @__PURE__ */ new Map();
  parents = /* @__PURE__ */ new Map();
  controlsByPath = /* @__PURE__ */ new Map();
  soloSelection = null;
  /** Current non-default controls, in preset traversal order. */
  get controls() {
    const result = [];
    for (const path of this.components.keys()) {
      const control = this.controlsByPath.get(path);
      if (control) result.push(control);
    }
    return result;
  }
  /**
   * Atomically replaces graph controls. Unknown or duplicate paths are rejected
   * so stale editor state cannot silently control a different preset.
   */
  setControls(controls) {
    const next = /* @__PURE__ */ new Map();
    for (const control of controls) {
      if (!this.components.has(control.path)) throw new RangeError(`Unknown AVS component path ${control.path}`);
      if (next.has(control.path)) throw new RangeError(`Duplicate AVS component control path ${control.path}`);
      const resolved = {
        path: control.path,
        enabled: control.enabled ?? true,
        muted: control.muted ?? false,
        solo: control.solo ?? false
      };
      if (!isDefaultControl(resolved)) next.set(control.path, resolved);
    }
    if (sameControls(this.controlsByPath, next)) return;
    this.controlsByPath = next;
    this.rebuildSoloSelection();
    this.resetControlSensitiveState();
  }
  /** Merge one path's editor state without disturbing controls on other paths. */
  setComponentControl(path, patch) {
    if (!this.components.has(path)) throw new RangeError(`Unknown AVS component path ${path}`);
    const current = this.controlsByPath.get(path) ?? { path, enabled: true, muted: false, solo: false };
    const next = {
      path,
      enabled: patch.enabled ?? current.enabled,
      muted: patch.muted ?? current.muted,
      solo: patch.solo ?? current.solo
    };
    this.setControls([
      ...this.controls.filter((control) => control.path !== path),
      next
    ]);
  }
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
      if (!this.shouldRun(component)) continue;
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
  evaluateListCode(component, audio, width2, height2, preinit, beat, enabled, clear, alphaIn, alphaOut, remainingBeatFrames) {
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
    vm.set("w", width2);
    vm.set("h", height2);
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
  indexComponents(children, parent) {
    for (const component of children) {
      if (this.components.has(component.path)) throw new Error(`Duplicate AVS component path ${component.path}`);
      this.components.set(component.path, component);
      this.parents.set(component.path, parent);
      this.indexComponents(component.children, component.path);
    }
  }
  shouldRun(component) {
    const control = this.controlsByPath.get(component.path);
    if (control && (!control.enabled || control.muted)) return false;
    return this.soloSelection === null || this.soloSelection.has(component.path);
  }
  rebuildSoloSelection() {
    const solos = [...this.controlsByPath.values()].filter((control) => control.solo);
    if (solos.length === 0) {
      this.soloSelection = null;
      return;
    }
    const selected = /* @__PURE__ */ new Set();
    for (const solo of solos) {
      let path = solo.path;
      while (path !== null) {
        selected.add(path);
        path = this.parents.get(path) ?? null;
      }
      const component = this.components.get(solo.path);
      if (component.list) this.selectSubtree(component, selected);
    }
    this.soloSelection = selected;
  }
  selectSubtree(component, selected) {
    selected.add(component.path);
    for (const child of component.children) this.selectSubtree(child, selected);
  }
  resetControlSensitiveState() {
    this.retained.clear();
    this.alternates.clear();
    this.beatFrames.clear();
    this.listEel.clear();
    this.buffers.release();
  }
};
function isDefaultControl(control) {
  return control.enabled && !control.muted && !control.solo;
}
function sameControls(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, a] of left) {
    const b = right.get(path);
    if (!b || a.enabled !== b.enabled || a.muted !== b.muted || a.solo !== b.solo) return false;
  }
  return true;
}
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
  registry.registerApe(AVS_CONVOLUTION_APE_ID, (context) => {
    let state = states.get(context.component.path);
    if (!state) {
      state = prepareConvolution(decodeAvsConvolutionConfig(context.component.payload));
      states.set(context.component.path, state);
    }
    if (!state.config.enabled || context.input.width === 0 || context.input.height === 0) return;
    return renderConvolution(context, state);
  });
  return registry;
}
function prepareConvolution(config2) {
  let firstNonzero = -1;
  const sign = config2.scale < 0 ? -1 : 1;
  const taps = [];
  const rotatedTaps = [];
  for (let index = 0; index < KERNEL_CELLS; index++) {
    const raw = config2.kernel[index];
    if (raw === 0) continue;
    if (firstNonzero < 0) firstNonzero = index;
    const coefficient = Math.imul(raw, sign);
    const dx = index % 7 - 3;
    const dy = Math.floor(index / 7) - 3;
    taps.push({ dx, dy, coefficient });
    rotatedTaps.push({ dx: -dy, dy: dx, coefficient });
  }
  if (firstNonzero < 0 && config2.bias !== 0) firstNonzero = KERNEL_CELLS;
  const sums = coefficientSums(config2.kernel, config2.bias);
  const bias = Math.imul(config2.bias, sign);
  const minimumX = taps.reduce((minimum, tap) => Math.min(minimum, tap.dx), 0);
  const maximumX = taps.reduce((maximum, tap) => Math.max(maximum, tap.dx), 0);
  const divisor = Math.abs(config2.scale) || 1;
  const positiveTaps = taps.filter((tap) => tap.coefficient > 0);
  const negativeTaps = taps.filter((tap) => tap.coefficient < 0);
  const boxCoefficient = taps.length === KERNEL_CELLS && taps.every((tap) => tap.coefficient === taps[0].coefficient) && taps[0].coefficient > 0 ? taps[0].coefficient : 0;
  return {
    config: config2,
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
    negativeCoefficients: Uint16Array.from(negativeTaps, (tap) => -tap.coefficient),
    boxCoefficient,
    boxScratch: null
  };
}
function renderConvolution(context, state) {
  const { config: config2 } = state;
  const swap = state.swap;
  const source = context.input.pixels;
  const target = swap ? context.output.pixels : source;
  const width2 = context.input.width;
  const height2 = context.input.height;
  if (swap && !config2.twoPass && state.bias === 0 && !state.saturatePositive && !state.saturateNegative && (!state.hasNegative || !config2.absolute && !config2.wrap)) {
    if (state.boxCoefficient !== 0) {
      renderBoxConvolution(source, target, width2, height2, state);
      return { swap: true };
    }
    renderFastConvolution(source, target, width2, height2, state);
    return { swap: true };
  }
  const first = new Uint16Array(4);
  const second = new Uint16Array(4);
  for (let y = 0; y < height2; y++) {
    for (let x = 0; x < width2; x++) {
      convolvePass(source, width2, height2, x, y, state.taps, state, first);
      if (config2.twoPass) {
        convolvePass(source, width2, height2, x, y, state.rotatedTaps, state, second);
        for (let channel = 0; channel < 4; channel++) {
          first[channel] = Math.min(65535, first[channel] + second[channel]);
        }
      }
      target[y * width2 + x] = (packByte(scaleWord(first[0], state.divisor)) | packByte(scaleWord(first[1], state.divisor)) << 8 | packByte(scaleWord(first[2], state.divisor)) << 16 | packByte(scaleWord(first[3], state.divisor)) << 24) >>> 0;
    }
  }
  return swap ? { swap: true } : void 0;
}
function renderFastConvolution(source, target, width2, height2, state) {
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
    for (let y = 0; y < height2; y++) {
      const sourceRow = clamp(y + shiftY, 0, height2 - 1) * width2;
      const targetRow = y * width2;
      if (shiftX === 0) {
        target.set(source.subarray(sourceRow, sourceRow + width2), targetRow);
      } else {
        for (let x = 0; x < width2; x++) {
          target[targetRow + x] = source[sourceRow + clamp(x + shiftX, 0, width2 - 1)];
        }
      }
    }
    return;
  }
  const rowBases = new Int32Array(tapCount);
  const negativeRowBases = new Int32Array(negativeTapCount);
  const interiorStart = Math.min(width2, state.leftEdge);
  const interiorEnd = Math.max(interiorStart, width2 - state.rightEdge);
  const shift = state.scaleShift;
  const reciprocal = shift < 0 ? Math.floor(65536 / state.divisor) & 65535 : 0;
  for (let y = 0; y < height2; y++) {
    for (let tap = 0; tap < tapCount; tap++) {
      rowBases[tap] = clamp(y + dy[tap], 0, height2 - 1) * width2;
    }
    for (let tap = 0; tap < negativeTapCount; tap++) {
      negativeRowBases[tap] = clamp(y + negativeDy[tap], 0, height2 - 1) * width2;
    }
    const targetRow = y * width2;
    for (let x = 0; x < width2; x++) {
      let redBlue = 0;
      let green = 0;
      let alpha = 0;
      let negativeRedBlue = 0;
      let negativeGreen = 0;
      let negativeAlpha = 0;
      const interior = x >= interiorStart && x < interiorEnd;
      for (let tap = 0; tap < tapCount; tap++) {
        const sourceX = interior ? x + dx[tap] : clamp(x + dx[tap], 0, width2 - 1);
        const pixel = source[rowBases[tap] + sourceX];
        const coefficient = coefficients[tap];
        redBlue += (pixel & 16711935) * coefficient;
        green += (pixel >>> 8 & 255) * coefficient;
        alpha += (pixel >>> 24) * coefficient;
      }
      for (let tap = 0; tap < negativeTapCount; tap++) {
        const sourceX = interior ? x + negativeDx[tap] : clamp(x + negativeDx[tap], 0, width2 - 1);
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
      if (shift >= 0) {
        blue >>>= shift;
        green >>>= shift;
        red >>>= shift;
        alpha >>>= shift;
      } else {
        blue = Math.floor(blue * reciprocal / 65536) & 65535;
        green = Math.floor(green * reciprocal / 65536) & 65535;
        red = Math.floor(red * reciprocal / 65536) & 65535;
        alpha = Math.floor(alpha * reciprocal / 65536) & 65535;
      }
      blue = packByte(blue);
      green = packByte(green);
      red = packByte(red);
      alpha = packByte(alpha);
      target[targetRow + x] = (blue | green << 8 | red << 16 | alpha << 24) >>> 0;
    }
  }
}
function renderBoxConvolution(source, target, width2, height2, state) {
  let scratch = state.boxScratch;
  if (!scratch || scratch.width !== width2 || scratch.height !== height2) {
    scratch = {
      width: width2,
      height: height2,
      redBlue: new Uint32Array(width2 * height2),
      greenAlpha: new Uint32Array(width2 * height2)
    };
    state.boxScratch = scratch;
  }
  const horizontalRedBlue = scratch.redBlue;
  const horizontalGreenAlpha = scratch.greenAlpha;
  for (let y = 0; y < height2; y++) {
    const row = y * width2;
    const first = source[row];
    let redBlue = (first & 255) * 4 + (first >>> 16 & 255) * 4 * 65536;
    let greenAlpha = (first >>> 8 & 255) * 4 + (first >>> 24) * 4 * 65536;
    for (let x = 1; x <= Math.min(3, width2 - 1); x++) {
      const pixel = source[row + x];
      redBlue += (pixel & 255) + (pixel >>> 16 & 255) * 65536;
      greenAlpha += (pixel >>> 8 & 255) + (pixel >>> 24) * 65536;
    }
    if (width2 < 4) {
      const last = source[row + width2 - 1];
      const missing = 4 - width2;
      redBlue += (last & 255) * missing + (last >>> 16 & 255) * missing * 65536;
      greenAlpha += (last >>> 8 & 255) * missing + (last >>> 24) * missing * 65536;
    }
    for (let x = 0; x < width2; x++) {
      horizontalRedBlue[row + x] = redBlue;
      horizontalGreenAlpha[row + x] = greenAlpha;
      const removeX = x < 3 ? 0 : x - 3;
      const addX = x + 4 >= width2 ? width2 - 1 : x + 4;
      const remove = source[row + removeX];
      const add = source[row + addX];
      redBlue += (add & 255) - (remove & 255) + ((add >>> 16 & 255) - (remove >>> 16 & 255)) * 65536;
      greenAlpha += (add >>> 8 & 255) - (remove >>> 8 & 255) + ((add >>> 24) - (remove >>> 24)) * 65536;
    }
  }
  const coefficient = state.boxCoefficient;
  const reciprocal = state.scaleShift < 0 ? Math.floor(65536 / state.divisor) & 65535 : 0;
  for (let x = 0; x < width2; x++) {
    let redBlue = horizontalRedBlue[x] * 4;
    let greenAlpha = horizontalGreenAlpha[x] * 4;
    for (let y = 1; y <= Math.min(3, height2 - 1); y++) {
      redBlue += horizontalRedBlue[y * width2 + x];
      greenAlpha += horizontalGreenAlpha[y * width2 + x];
    }
    if (height2 < 4) {
      const last = (height2 - 1) * width2 + x;
      const missing = 4 - height2;
      redBlue += horizontalRedBlue[last] * missing;
      greenAlpha += horizontalGreenAlpha[last] * missing;
    }
    for (let y = 0; y < height2; y++) {
      let blue = (redBlue & 65535) * coefficient;
      let red = Math.floor(redBlue / 65536) * coefficient;
      let green = (greenAlpha & 65535) * coefficient;
      let alpha = Math.floor(greenAlpha / 65536) * coefficient;
      if (state.scaleShift >= 0) {
        blue >>>= state.scaleShift;
        green >>>= state.scaleShift;
        red >>>= state.scaleShift;
        alpha >>>= state.scaleShift;
      } else {
        blue = Math.floor(blue * reciprocal / 65536) & 65535;
        green = Math.floor(green * reciprocal / 65536) & 65535;
        red = Math.floor(red * reciprocal / 65536) & 65535;
        alpha = Math.floor(alpha * reciprocal / 65536) & 65535;
      }
      blue = packByte(blue);
      green = packByte(green);
      red = packByte(red);
      alpha = packByte(alpha);
      target[y * width2 + x] = (blue | green << 8 | red << 16 | alpha << 24) >>> 0;
      const removeY = y < 3 ? 0 : y - 3;
      const addY = y + 4 >= height2 ? height2 - 1 : y + 4;
      redBlue += horizontalRedBlue[addY * width2 + x] - horizontalRedBlue[removeY * width2 + x];
      greenAlpha += horizontalGreenAlpha[addY * width2 + x] - horizontalGreenAlpha[removeY * width2 + x];
    }
  }
}
function coefficientSums(kernel2, bias) {
  let positive = 0;
  let negative = 0;
  for (const coefficient of [...kernel2, bias]) {
    if (coefficient > 0) positive = positive + coefficient >>> 0;
    else if (coefficient < 0) negative = negative + (-coefficient >>> 0) >>> 0;
  }
  return { saturatePositive: positive >= 256, saturateNegative: negative >= 256 };
}
function convolvePass(source, width2, height2, x, y, taps, state, output) {
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  let n0 = 0;
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  for (const tap of taps) {
    const sx = clamp(x + tap.dx, 0, width2 - 1);
    const sy = clamp(y + tap.dy, 0, height2 - 1);
    const pixel = source[sy * width2 + sx];
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
    return clamp(signed16(positive) - signed16(negative), -32768, 32767) & 65535 & 32767;
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
  const signed = signed16(value);
  return signed < 0 ? 0 : signed > 255 ? 255 : signed;
}
function clamp(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

// src/avs/effects/movement.ts
var TEXT2 = new TextDecoder("windows-1252");
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

// src/avs/gpu-frame-graph.ts
var AVS_EXACT_POINTWISE_HELPERS_WGSL = (
  /* wgsl */
  `
fn avs_approach(value: i32, target_value: i32, amount: i32) -> u32 {
  if (value <= target_value - amount) { return u32(value + amount) & 255u; }
  if (value >= target_value + amount) { return u32(value - amount) & 255u; }
  return u32(target_value) & 255u;
}
fn avs_pack(low: u32, middle: u32, high: u32) -> u32 { return (low & 255u) | ((middle & 255u) << 8u) | ((high & 255u) << 16u); }
fn avs_adjust(pixel: u32, red_multiplier: u32, green_multiplier: u32, blue_multiplier: u32) -> u32 {
  return avs_pack(min(255u, ((pixel & 255u) * blue_multiplier) / 65536u), min(255u, (((pixel >> 8u) & 255u) * green_multiplier) / 65536u), min(255u, (((pixel >> 16u) & 255u) * red_multiplier) / 65536u));
}
fn avs_add(left: u32, right: u32) -> u32 { return avs_pack(min(255u, (left & 255u) + (right & 255u)), min(255u, ((left >> 8u) & 255u) + ((right >> 8u) & 255u)), min(255u, ((left >> 16u) & 255u) + ((right >> 16u) & 255u))); }
fn avs_in_range(pixel: u32, reference: u32, distance: i32) -> bool {
  return abs(i32(pixel & 255u) - i32(reference & 255u)) <= distance && abs(i32((pixel >> 8u) & 255u) - i32((reference >> 8u) & 255u)) <= distance && abs(i32((pixel >> 16u) & 255u) - i32((reference >> 16u) & 255u)) <= distance;
}`
);
function buildExactAvsPointwiseBody(operations) {
  if (!operations.length) throw new RangeError("Pointwise GPU fragment needs at least one operation");
  return operations.map((operation, index) => pointwiseWgsl(operation, index)).join("\n");
}
function buildExactAvsPointwiseWgsl(operations) {
  if (operations.length === 0) throw new RangeError("Pointwise GPU pass needs at least one operation");
  const body = operations.map((operation, index) => pointwiseWgsl(operation, index)).join("\n");
  return (
    /* wgsl */
    `
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;

fn avs_approach(value: i32, target_value: i32, amount: i32) -> u32 {
  if (value <= target_value - amount) { return u32(value + amount) & 255u; }
  if (value >= target_value + amount) { return u32(value - amount) & 255u; }
  return u32(target_value) & 255u;
}

fn avs_pack(low: u32, middle: u32, high: u32) -> u32 {
  return (low & 255u) | ((middle & 255u) << 8u) | ((high & 255u) << 16u);
}

fn avs_adjust(pixel: u32, red_multiplier: u32, green_multiplier: u32, blue_multiplier: u32) -> u32 {
  let low = min(255u, ((pixel & 255u) * blue_multiplier) / 65536u);
  let middle = min(255u, (((pixel >> 8u) & 255u) * green_multiplier) / 65536u);
  let high = min(255u, (((pixel >> 16u) & 255u) * red_multiplier) / 65536u);
  return avs_pack(low, middle, high);
}

fn avs_add(left: u32, right: u32) -> u32 {
  return avs_pack(
    min(255u, (left & 255u) + (right & 255u)),
    min(255u, ((left >> 8u) & 255u) + ((right >> 8u) & 255u)),
    min(255u, ((left >> 16u) & 255u) + ((right >> 16u) & 255u)),
  );
}

fn avs_in_range(pixel: u32, reference: u32, distance: i32) -> bool {
  return abs(i32(pixel & 255u) - i32(reference & 255u)) <= distance
    && abs(i32((pixel >> 8u) & 255u) - i32((reference >> 8u) & 255u)) <= distance
    && abs(i32((pixel >> 16u) & 255u) - i32((reference >> 16u) & 255u)) <= distance;
}

@compute @workgroup_size(256)
fn pointwise_main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= arrayLength(&source)) { return; }
  var pixel = source[index] & 0x00ffffffu;
${indentWgsl(body, 2)}
  destination[index] = pixel & 0x00ffffffu;
}
`
  );
}
function pointwiseWgsl(operation, index) {
  switch (operation.kind) {
    case "fade": {
      assertIntegerRange(operation.fade, 1, 255, "Fade amount");
      const target = operation.target & 16777215;
      return `// fused ${index}: Fade Out
pixel = avs_pack(avs_approach(i32(pixel & 255u), ${target & 255}i, ${operation.fade}i), avs_approach(i32((pixel >> 8u) & 255u), ${target >>> 8 & 255}i, ${operation.fade}i), avs_approach(i32((pixel >> 16u) & 255u), ${target >>> 16 & 255}i, ${operation.fade}i));`;
    }
    case "invert":
      return `// fused ${index}: Invert
pixel = pixel ^ 0x00ffffffu;`;
    case "fast-brightness":
      if (operation.direction !== 0 && operation.direction !== 1) {
        throw new RangeError(`Fast Brightness direction ${String(operation.direction)} is not exact-GPU eligible`);
      }
      return operation.direction === 0 ? `// fused ${index}: Fast Brightness double
pixel = avs_pack(min(255u, (pixel & 255u) * 2u), min(255u, ((pixel >> 8u) & 255u) * 2u), min(255u, ((pixel >> 16u) & 255u) * 2u));` : `// fused ${index}: Fast Brightness half
pixel = (pixel >> 1u) & 0x007f7f7fu;`;
    case "color-clip": {
      assertIntegerRange(operation.mode, 1, 3, "Color Clip mode");
      assertIntegerRange(operation.distanceSquared, 0, 195075, "Color Clip distance squared");
      const source = operation.source & 16777215;
      const low = source & 255;
      const middle = source >>> 8 & 255;
      const high = source >>> 16 & 255;
      const condition = operation.mode === 1 ? `(pixel & 255u) <= ${low}u && ((pixel >> 8u) & 255u) <= ${middle}u && ((pixel >> 16u) & 255u) <= ${high}u` : operation.mode === 2 ? `(pixel & 255u) >= ${low}u && ((pixel >> 8u) & 255u) >= ${middle}u && ((pixel >> 16u) & 255u) >= ${high}u` : `u32((i32(pixel & 255u) - ${low}i) * (i32(pixel & 255u) - ${low}i) + (i32((pixel >> 8u) & 255u) - ${middle}i) * (i32((pixel >> 8u) & 255u) - ${middle}i) + (i32((pixel >> 16u) & 255u) - ${high}i) * (i32((pixel >> 16u) & 255u) - ${high}i)) <= ${operation.distanceSquared}u`;
      return `// fused ${index}: Color Clip
if (${condition}) { pixel = ${operation.replacement & 16777215}u; }`;
    }
    case "brightness": {
      for (const [name, value] of [
        ["red", operation.redMultiplier],
        ["green", operation.greenMultiplier],
        ["blue", operation.blueMultiplier]
      ]) assertIntegerRange(value, 0, Math.floor(4294967295 / 255), `Brightness ${name} multiplier`);
      assertIntegerRange(operation.distance, -2147483647, 2147483647, "Brightness exclusion distance");
      const adjusted = `adjusted_${index}`;
      const excluded = operation.exclude ? `if (!avs_in_range(pixel, ${operation.reference & 16777215}u, ${operation.distance}i)) {
` : "";
      const close2 = operation.exclude ? "\n}" : "";
      const combine = operation.additive ? `pixel = avs_add(pixel, ${adjusted});` : operation.average ? `pixel = ((pixel >> 1u) & 0x007f7f7fu) + ((${adjusted} >> 1u) & 0x007f7f7fu);` : `pixel = ${adjusted};`;
      return `// fused ${index}: Brightness
${excluded}  let ${adjusted} = avs_adjust(pixel, ${operation.redMultiplier}u, ${operation.greenMultiplier}u, ${operation.blueMultiplier}u);
  ${combine}${close2}`;
    }
  }
}
function assertIntegerRange(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} ${String(value)} is outside ${minimum}..${maximum}`);
  }
}
function indentWgsl(source, spaces) {
  const prefix = " ".repeat(spaces);
  return source.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

// src/avs/effects/convolution-gpu.ts
var AVS_GPU_CONVOLUTION_CAPABILITY = {
  id: "holden03-convolution-packed-u32",
  backend: "webgpu",
  lane: "exact",
  byteExact: true,
  reason: "Parallelizes independent output pixels while preserving native 16-bit integer accumulation; an optional workgroup-tiled kernel is benchmark-only."
};
function assessExactGpuConvolution(config2) {
  if (!config2.enabled) return { eligible: false, reason: "convolution is disabled" };
  const first = config2.kernel.findIndex((value) => value !== 0);
  if (first < 0 || first >= 24) {
    return { eligible: false, reason: "native center/right kernel uses ordered in-place raster feedback" };
  }
  return { eligible: true, reason: "native APE selects a separate output buffer; pixels are independent" };
}
var ExactAvsConvolutionGpuPass = class {
  capability = AVS_GPU_CONVOLUTION_CAPABILITY;
  pipeline;
  groups = /* @__PURE__ */ new WeakMap();
  constructor(device, config2, width2, height2, tiled = false, pointwise2 = []) {
    const eligibility = assessExactGpuConvolution(config2);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    const module = device.createShaderModule({
      label: "AVS exact tiled Convolution",
      code: buildExactAvsConvolutionWgsl(config2, width2, height2, tiled, pointwise2)
    });
    this.pipeline = device.createComputePipeline({
      label: "AVS exact tiled Convolution",
      layout: "auto",
      compute: { module, entryPoint: "main" }
    });
  }
  encode(context) {
    let targets = this.groups.get(context.source);
    if (!targets) {
      targets = /* @__PURE__ */ new WeakMap();
      this.groups.set(context.source, targets);
    }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: "AVS exact tiled Convolution buffers",
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } }
        ]
      });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: "AVS exact tiled Convolution" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(context.width / 16), Math.ceil(context.height / 16));
    pass.end();
  }
};
function buildExactAvsConvolutionWgsl(config2, width2, height2, tiled = true, pointwise2 = []) {
  if (!assessExactGpuConvolution(config2).eligible) throw new Error(assessExactGpuConvolution(config2).reason);
  if (!Number.isInteger(width2) || width2 < 1 || !Number.isInteger(height2) || height2 < 1) {
    throw new RangeError("Convolution dimensions must be positive integers");
  }
  const sign = config2.scale < 0 ? -1 : 1;
  const kernel2 = config2.kernel.map((value) => Math.imul(value, sign));
  const divisor = Math.abs(config2.scale) || 1;
  const reciprocal = Math.floor(65536 / divisor) & 65535;
  const bias = Math.imul(config2.bias, sign);
  const biasProduct = Math.imul(Math.abs(bias) & 65535, 256) & 65535;
  const sums = coefficientSums2(config2.kernel, config2.bias);
  const fused = pointwise2.length ? { helpers: AVS_EXACT_POINTWISE_HELPERS_WGSL, body: buildExactAvsPointwiseBody(pointwise2) } : null;
  const combine = config2.absolute ? "return u32(clamp(signed16(p) - signed16(n), -32768, 32767)) & 0x7fffu;" : config2.wrap ? "return (p - n) & 0xffffu;" : "return select(0u, p - n, p > n);";
  const scale = divisor <= 1 ? "return value & 0xffffu;" : divisor <= 32768 && (divisor & divisor - 1) === 0 ? `return value >> ${Math.log2(divisor)}u;` : `return ((value * ${reciprocal}u) >> 16u) & 0xffffu;`;
  const sample = tiled ? "let pixel = tile[u32(sy) * 22u + u32(sx)];" : "let gx = u32(clamp(i32(origin.x) + sx - 3, 0, i32(WIDTH) - 1)); let gy = u32(clamp(i32(origin.y) + sy - 3, 0, i32(HEIGHT) - 1)); let pixel = source[gy * WIDTH + gx];";
  return (
    /* wgsl */
    `
const WIDTH = ${width2}u; const HEIGHT = ${height2}u;
const KERNEL = array<i32, 49>(${kernel2.map((value) => `${value}i`).join(",")});
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
var<workgroup> tile: array<u32, 484>;
${fused?.helpers ?? ""}

fn add_word(a: u32, b: u32, saturate: bool) -> u32 { return select((a + b) & 0xffffu, min(0xffffu, a + b), saturate); }
fn signed16(v: u32) -> i32 { let low = v & 0xffffu; return select(i32(low), i32(low) - 65536, (low & 0x8000u) != 0u); }
fn combine(p: u32, n: u32) -> u32 { ${combine} }
fn scale_word(value: u32) -> u32 { ${scale} }
fn byte(value: u32) -> u32 { return u32(clamp(signed16(value), 0, 255)); }

fn convolve(origin: vec2u, local: vec2u, rotated: bool) -> vec4u {
  var positive = vec4u(0u); var negative = vec4u(0u);
  for (var tap = 0u; tap < 49u; tap++) {
    let coefficient = KERNEL[tap];
    if (coefficient == 0i) { continue; }
    let dx = i32(tap % 7u) - 3; let dy = i32(tap / 7u) - 3;
    let sx = i32(local.x) + 3 + select(dx, -dy, rotated);
    let sy = i32(local.y) + 3 + select(dy, dx, rotated);
    ${sample}
    let magnitude = select(u32(coefficient), 0u - u32(coefficient), coefficient < 0i) & 0xffffu;
    let product = (vec4u(pixel & 255u, (pixel >> 8u) & 255u, (pixel >> 16u) & 255u, pixel >> 24u) * magnitude) & vec4u(0xffffu);
    if (coefficient > 0i) {
      positive = vec4u(add_word(positive.x, product.x, ${sums.positive}), add_word(positive.y, product.y, ${sums.positive}), add_word(positive.z, product.z, ${sums.positive}), add_word(positive.w, product.w, ${sums.positive}));
    } else {
      negative = vec4u(add_word(negative.x, product.x, ${sums.negative}), add_word(negative.y, product.y, ${sums.negative}), add_word(negative.z, product.z, ${sums.negative}), add_word(negative.w, product.w, ${sums.negative}));
    }
  }
  ${bias > 0 ? `positive = min(vec4u(0xffffu), positive + vec4u(${biasProduct}u));` : ""}
  ${bias < 0 ? `negative = min(vec4u(0xffffu), negative + vec4u(${biasProduct}u));` : ""}
  return vec4u(combine(positive.x, negative.x), combine(positive.y, negative.y), combine(positive.z, negative.z), combine(positive.w, negative.w));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local3: vec3u, @builtin(local_invocation_index) lane: u32) {
  let origin = vec2u(group.xy) * 16u;
  ${tiled ? `
  for (var offset = lane; offset < 484u; offset += 256u) {
    let tx = offset % 22u; let ty = offset / 22u;
    let gx = u32(clamp(i32(origin.x) + i32(tx) - 3, 0, i32(WIDTH) - 1));
    let gy = u32(clamp(i32(origin.y) + i32(ty) - 3, 0, i32(HEIGHT) - 1));
    tile[offset] = source[gy * WIDTH + gx];
  }
  workgroupBarrier();` : ""}
  let local = local3.xy; let global = origin + local;
  if (global.x >= WIDTH || global.y >= HEIGHT) { return; }
  var value = convolve(origin, local, false);
  ${config2.twoPass ? "value = min(vec4u(0xffffu), value + convolve(origin, local, true));" : ""}
  value = vec4u(scale_word(value.x), scale_word(value.y), scale_word(value.z), scale_word(value.w));
  var pixel = byte(value.x) | (byte(value.y) << 8u) | (byte(value.z) << 16u) | (byte(value.w) << 24u);
  ${fused ? `pixel = pixel & 0x00ffffffu;
${fused.body}` : ""}
  destination[global.y * WIDTH + global.x] = pixel${fused ? " & 0x00ffffffu" : ""};
}`
  );
}
function coefficientSums2(kernel2, bias) {
  let positive = 0;
  let negative = 0;
  for (const coefficient of [...kernel2, bias]) {
    if (coefficient > 0) positive = positive + coefficient >>> 0;
    else if (coefficient < 0) negative = negative + (-coefficient >>> 0) >>> 0;
  }
  return { positive: positive >= 256, negative: negative >= 256 };
}

// src/avs/effects/bump.ts
var TEXT3 = new TextDecoder("windows-1252");

// src/avs/effects/dynamic-movement.ts
var TEXT4 = new TextDecoder("windows-1252");

// src/avs/effects/scripted-transforms.ts
var TEXT5 = new TextDecoder("windows-1252");

// src/avs/effects/superscope.ts
var TEXT6 = new TextDecoder("windows-1252");
var MAX_POINTS = 128 * 1024;

// src/avs/effects/text.ts
var WINDOWS_1252 = new TextDecoder("windows-1252");

// src/avs/effects/texer.ts
var TEXT7 = new TextDecoder("windows-1252");

// src/avs/gpu-ordered-draw.ts
var DEFAULT_BUDGET = 64 * 1024 * 1024;
var DEFAULT_MAX_RECORDS = 4 * 128 * 1024;

// tools/avs-convolution-gpu-browser-check.ts
void run().catch((error) => finish({ error: error instanceof Error ? error.stack : String(error) }));
var width = 640;
var height = 360;
var bytes = width * height * 4;
var kernel = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
var config = { enabled: true, wrap: false, absolute: false, twoPass: false, kernel, bias: 0, scale: 16, legacyFilename: "" };
var pointwise = [{ kind: "invert" }, { kind: "fast-brightness", direction: 1 }];
async function run() {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  let differentialPixels = 0;
  for (const [fixtureIndex, fixture] of differentialFixtures().entries()) {
    const fixtureSource = deterministicPixels(31 * 19);
    try {
      await differential(device, fixture, 31, 19, fixtureSource);
    } catch (error) {
      throw new Error(`fixture ${fixtureIndex}: ${error instanceof Error ? error.message : String(error)}`);
    }
    differentialPixels += fixtureSource.length;
  }
  device.pushErrorScope("validation");
  const pass = new ExactAvsConvolutionGpuPass(device, config, width, height, true);
  const direct = new ExactAvsConvolutionGpuPass(device, config, width, height, false);
  const fused = new ExactAvsConvolutionGpuPass(device, config, width, height, false, pointwise);
  const shaderError = await device.popErrorScope();
  if (shaderError) throw shaderError;
  const source = deterministicPixels(width * height);
  const expected = cpuFrame(source, config, width, height);
  const a = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const b = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const c = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const pointModule = device.createShaderModule({ code: buildExactAvsPointwiseWgsl(pointwise) });
  const pointPipeline = device.createComputePipeline({ layout: "auto", compute: { module: pointModule, entryPoint: "pointwise_main" } });
  const pointGroup = device.createBindGroup({ layout: pointPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b } }, { binding: 1, resource: { buffer: c } }] });
  const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  device.queue.writeBuffer(a, 0, source);
  let encoder = device.createCommandEncoder();
  pass.encode({ device, encoder, width, height, source: a, target: b });
  encoder.copyBufferToBuffer(b, 0, readback, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const actual = new Uint32Array(readback.getMappedRange());
  const exactPixels = actual.length;
  for (let index = 0; index < actual.length; index++) if (actual[index] !== expected[index]) {
    throw new Error(`pixel ${index}: ${actual[index].toString(16)} != ${expected[index].toString(16)}`);
  }
  readback.unmap();
  device.queue.writeBuffer(a, 0, source);
  encoder = device.createCommandEncoder();
  fused.encode({ device, encoder, width, height, source: a, target: c });
  encoder.copyBufferToBuffer(c, 0, readback, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const fusedActual = new Uint32Array(readback.getMappedRange()), fusedExpected = expected.map(fusedPointwiseCpu);
  for (let index = 0; index < fusedActual.length; index++) if (fusedActual[index] !== fusedExpected[index]) throw new Error(`fused pixel ${index}: ${fusedActual[index].toString(16)} != ${fusedExpected[index].toString(16)}`);
  readback.unmap();
  const cpuSamples = [], gpuSamples = [], directSamples = [], chainSamples = [], fusedSamples = [];
  for (let sample = 0; sample < 7; sample++) {
    let started = performance.now();
    cpuFrame(source, config, width, height);
    cpuSamples.push(performance.now() - started);
    device.queue.writeBuffer(a, 0, source);
    encoder = device.createCommandEncoder();
    started = performance.now();
    pass.encode({ device, encoder, width, height, source: a, target: b });
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    gpuSamples.push(performance.now() - started);
    device.queue.writeBuffer(a, 0, source);
    encoder = device.createCommandEncoder();
    started = performance.now();
    direct.encode({ device, encoder, width, height, source: a, target: b });
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    directSamples.push(performance.now() - started);
    device.queue.writeBuffer(a, 0, source);
    encoder = device.createCommandEncoder();
    started = performance.now();
    direct.encode({ device, encoder, width, height, source: a, target: b });
    const pointPass = encoder.beginComputePass();
    pointPass.setPipeline(pointPipeline);
    pointPass.setBindGroup(0, pointGroup);
    pointPass.dispatchWorkgroups(Math.ceil(source.length / 256));
    pointPass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    chainSamples.push(performance.now() - started);
    device.queue.writeBuffer(a, 0, source);
    encoder = device.createCommandEncoder();
    started = performance.now();
    fused.encode({ device, encoder, width, height, source: a, target: c });
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    fusedSamples.push(performance.now() - started);
  }
  finish({
    pass: true,
    width,
    height,
    pixels: source.length,
    exactPixels,
    differentialPixels,
    cpuMedianMs: median(cpuSamples),
    gpuTiledMedianMs: median(gpuSamples),
    gpuDirectMedianMs: median(directSamples),
    tiledSpeedupVsCpu: median(cpuSamples) / median(gpuSamples),
    tiledVsDirect: median(directSamples) / median(gpuSamples),
    gpuSeparateChainMedianMs: median(chainSamples),
    gpuFusedChainMedianMs: median(fusedSamples),
    fusedChainSpeedup: median(chainSamples) / median(fusedSamples),
    dispatchesSaved: 1,
    residentBytesSaved: bytes * 2,
    cpuSamples,
    gpuSamples,
    directSamples,
    chainSamples,
    fusedSamples
  });
}
async function differential(device, value, w, h, source) {
  const size = source.byteLength, a = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }), b = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }), read = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pass = new ExactAvsConvolutionGpuPass(device, value, w, h);
  device.queue.writeBuffer(a, 0, source);
  const encoder = device.createCommandEncoder();
  pass.encode({ device, encoder, width: w, height: h, source: a, target: b });
  encoder.copyBufferToBuffer(b, 0, read, 0, size);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const actual = new Uint32Array(read.getMappedRange()), expected = cpuFrame(source, value, w, h);
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) throw new Error(`fixture pixel ${i}: ${actual[i].toString(16)} != ${expected[i].toString(16)}`);
  read.unmap();
  a.destroy();
  b.destroy();
  read.destroy();
}
function differentialFixtures() {
  const make = (entries, overrides = {}) => {
    const values = Array(49).fill(0);
    for (const [i, v] of entries) values[i] = v;
    return { enabled: true, wrap: false, absolute: false, twoPass: false, kernel: values, bias: 0, scale: 3, legacyFilename: "", ...overrides };
  };
  return [make([[0, -1], [24, 5]]), make([[0, -3], [24, 1]], { wrap: true }), make([[0, -3], [24, 1]], { absolute: true }), make([[0, 1], [8, 2], [24, -4]], { twoPass: true }), make([[0, 2], [17, -1]], { bias: -7, scale: -3 }), make([[0, 300], [1, -2]], { scale: 5 })];
}
function cpuFrame(source, value, w, h) {
  const payload = new Uint8Array(220), view = new DataView(payload.buffer);
  view.setInt32(0, 1, true);
  view.setInt32(4, value.wrap ? 1 : 0, true);
  view.setInt32(8, value.absolute ? 1 : 0, true);
  view.setInt32(12, value.twoPass ? 1 : 0, true);
  for (let index = 0; index < 49; index++) view.setInt32(16 + index * 4, value.kernel[index], true);
  view.setInt32(212, value.bias, true);
  view.setInt32(216, value.scale, true);
  const component = { effectId: -1, apeId: AVS_CONVOLUTION_APE_ID, payload, fileOffset: 0, path: "0", children: [], list: null, listCode: null };
  const preset = { version: 2, header: "Nullsoft AVS Preset 0.2", clearEveryFrame: false, components: [component], byteLength: 220 };
  const audio = { waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat: false, beatLevel: 0 };
  const framebuffer = new AvsFramebuffer(w, h, new Uint32Array(source));
  new AvsExecutor(preset, registerAvsConvolutionFilter()).render(framebuffer, audio);
  return new Uint32Array(framebuffer.pixels);
}
function deterministicPixels(count) {
  let state = 2654435769;
  const result = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[i] = state >>> 0;
  }
  return result;
}
function fusedPointwiseCpu(pixel) {
  pixel = pixel & 16777215 ^ 16777215;
  return pixel >>> 1 & 8355711;
}
function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}
function finish(value) {
  document.querySelector("pre").textContent = JSON.stringify(value, null, 2);
  document.documentElement.dataset.done = "true";
}
