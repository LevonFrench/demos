// src/avs/types.ts
var AVS_AUDIO_SAMPLES = 576;
var AVS_FFT_SIZE = 512;
var AVS_FFT_BINS = AVS_FFT_SIZE / 2;

// src/avs/preset.ts
var TEXT = new TextDecoder("windows-1252");

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
  const execute3 = (vm) => {
    if (vm !== boundVm) {
      boundVm = vm;
      boundExecute = bind(vm);
    }
    return boundExecute();
  };
  return { source: ast.source, ast, bind, execute: execute3 };
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

// src/avs/effects/bump.ts
var TEXT3 = new TextDecoder("windows-1252");

// src/avs/effects/dynamic-movement.ts
var TEXT4 = new TextDecoder("windows-1252");
function decodeAvsDynamicMovement(payload2) {
  let offset = 0;
  let scripts = ["", "", "", ""];
  if (payload2[0] === 1) {
    offset = 1;
    for (let i = 0; i < 4; i++) {
      const value = readString(payload2, offset);
      scripts[i] = value.value;
      offset = value.next;
    }
  } else if (payload2.length >= 1024) {
    scripts = [0, 256, 512, 768].map((start) => nulText(payload2.subarray(start, start + 256)));
    offset = 1024;
  }
  const read = (fallback) => {
    const value = i32(payload2, offset, fallback);
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
function readString(payload2, offset) {
  if (offset + 4 > payload2.length) return { value: "", next: payload2.length };
  const length = u32(payload2, offset, 0);
  const start = offset + 4;
  const end = Math.min(payload2.length, start + length);
  return { value: nulText(payload2.subarray(start, end)), next: end };
}
function i32(payload2, offset, fallback) {
  return offset + 4 <= payload2.length ? new DataView(payload2.buffer, payload2.byteOffset, payload2.byteLength).getInt32(offset, true) : fallback;
}
function u32(payload2, offset, fallback) {
  return offset + 4 <= payload2.length ? new DataView(payload2.buffer, payload2.byteOffset, payload2.byteLength).getUint32(offset, true) : fallback;
}
function nulText(bytes) {
  const end = bytes.indexOf(0);
  return TEXT4.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

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

// src/avs/effects/dynamic-movement-gpu.ts
var AVS_GPU_DYNAMIC_MOVEMENT_CAPABILITY = {
  id: "dynamic-movement-cpu-map-gpu-resample",
  backend: "webgpu",
  lane: "120",
  byteExact: true,
  reason: "CPU preserves EEL/grid state and uploads an exact packed map; WebGPU performs packed-u32 sampling and alpha blend."
};
var AvsDynamicMovementGpuMapGenerator = class {
  constructor(config, global, seed) {
    this.config = config;
    if (config.buffer !== 0 || config.noMove) throw new Error("Dynamic Movement GPU map rejects global-buffer and no-move modes");
    this.vm = new AvsEelVm({ global, seed });
    this.programs = [
      compileOrNull(config.point),
      compileOrNull(config.frame),
      compileOrNull(config.beat),
      compileOrNull(config.init)
    ];
  }
  vm;
  programs;
  initialized = false;
  gridX = new Float64Array(0);
  gridY = new Float64Array(0);
  gridAlpha = new Float64Array(0);
  cellX = new Uint16Array(0);
  fractionX = new Float64Array(0);
  cellY = new Uint16Array(0);
  fractionY = new Float64Array(0);
  packed = new Uint32Array(0);
  generate(audio, width, height) {
    if (width <= 0 || height <= 0 || width * height >= 4194304) throw new RangeError("Dynamic Movement GPU dimensions unsupported");
    const vm = this.vm;
    vm.setHost({
      getosc: (band, sampleWidth, channel) => avsAudioSample(audio, "osc", band, sampleWidth, channel),
      getspec: (band, sampleWidth, channel) => avsAudioSample(audio, "spec", band, sampleWidth, channel)
    });
    vm.set("w", width);
    vm.set("h", height);
    vm.set("b", audio.beat ? 1 : 0);
    vm.set("alpha", 0.5);
    if (!this.initialized) {
      execute(this.programs[3], vm);
      this.initialized = true;
    }
    execute(this.programs[1], vm);
    if (audio.beat) execute(this.programs[2], vm);
    const columns = clamp(Math.trunc(this.config.gridWidth) + 1, 2, 256);
    const rows = clamp(Math.trunc(this.config.gridHeight) + 1, 2, 256);
    const gridSize = columns * rows;
    if (this.gridX.length !== gridSize) {
      this.gridX = new Float64Array(gridSize);
      this.gridY = new Float64Array(gridSize);
      this.gridAlpha = new Float64Array(gridSize);
    }
    this.prepareAxes(width, height, columns, rows);
    const radius = Math.sqrt(width * width + height * height) * 0.5;
    for (let gy = 0; gy < rows; gy++) {
      const screenY = gy * height / (rows - 1);
      const normalizedY = (screenY - height * 0.5) * (2 / height);
      for (let gx = 0; gx < columns; gx++) {
        const screenX = gx * width / (columns - 1);
        vm.set("x", (screenX - width * 0.5) * (2 / width));
        vm.set("y", normalizedY);
        vm.set("d", Math.hypot(screenX - width * 0.5, screenY - height * 0.5) / radius);
        vm.set("r", Math.atan2(screenY - height * 0.5, screenX - width * 0.5) + Math.PI * 0.5);
        execute(this.programs[0], vm);
        const index = gx + gy * columns;
        if (this.config.rectangular) {
          this.gridX[index] = (vm.get("x") + 1) * width * 0.5;
          this.gridY[index] = (vm.get("y") + 1) * height * 0.5;
        } else {
          const distance = vm.get("d") * radius, angle = vm.get("r") - Math.PI * 0.5;
          this.gridX[index] = width * 0.5 + Math.cos(angle) * distance;
          this.gridY[index] = height * 0.5 + Math.sin(angle) * distance;
        }
        this.gridAlpha[index] = clamp(vm.get("alpha"), 0, 1);
      }
    }
    if (this.packed.length !== width * height * 2) this.packed = new Uint32Array(width * height * 2);
    this.buildPackedMap(width, height, columns);
    return { packed: this.packed, bilinear: this.config.bilinear, blend: this.config.blend };
  }
  buildPackedMap(width, height, columns) {
    const bilinear = this.config.bilinear;
    const maxX = Math.max(0, width - (bilinear ? 2 : 1));
    const maxY = Math.max(0, height - (bilinear ? 2 : 1));
    const spanX = Math.max(1, maxX), spanY = Math.max(1, maxY);
    let index = 0;
    for (let y = 0; y < height; y++) {
      const cellY = this.cellY[y], fy = this.fractionY[y], inverseY = 1 - fy;
      const row = cellY * columns;
      for (let x = 0; x < width; x++, index++) {
        const fx = this.fractionX[x], topLeft = this.cellX[x] + row;
        const topRight = topLeft + 1, bottomLeft = topLeft + columns, bottomRight = bottomLeft + 1;
        let mappedX = (this.gridX[topLeft] + (this.gridX[topRight] - this.gridX[topLeft]) * fx) * inverseY + (this.gridX[bottomLeft] + (this.gridX[bottomRight] - this.gridX[bottomLeft]) * fx) * fy;
        let mappedY = (this.gridY[topLeft] + (this.gridY[topRight] - this.gridY[topLeft]) * fx) * inverseY + (this.gridY[bottomLeft] + (this.gridY[bottomRight] - this.gridY[bottomLeft]) * fx) * fy;
        if (this.config.wrap) {
          mappedX = (mappedX % spanX + spanX) % spanX;
          mappedY = (mappedY % spanY + spanY) % spanY;
        } else {
          mappedX = clamp(mappedX, 0, maxX);
          mappedY = clamp(mappedY, 0, maxY);
        }
        const ix = Math.trunc(mappedX), iy = Math.trunc(mappedY);
        const sampleX = bilinear && width >= 2 ? Math.trunc((mappedX - ix) * 256) & 255 : 0;
        const sampleY = bilinear && height >= 2 ? Math.trunc((mappedY - iy) * 256) & 255 : 0;
        const rawAlpha = (this.gridAlpha[topLeft] + (this.gridAlpha[topRight] - this.gridAlpha[topLeft]) * fx) * inverseY + (this.gridAlpha[bottomLeft] + (this.gridAlpha[bottomRight] - this.gridAlpha[bottomLeft]) * fx) * fy;
        const alpha = Math.trunc(clamp(rawAlpha, 0, 1) * 255);
        this.packed[index * 2] = ix + iy * width;
        this.packed[index * 2 + 1] = sampleX | sampleY << 8 | alpha << 16;
      }
    }
  }
  prepareAxes(width, height, columns, rows) {
    if (this.cellX.length !== width) {
      this.cellX = new Uint16Array(width);
      this.fractionX = new Float64Array(width);
      for (let x = 0; x < width; x++) {
        const c = x * (columns - 1) / width;
        const cell = Math.min(columns - 2, Math.trunc(c));
        this.cellX[x] = cell;
        this.fractionX[x] = c - cell;
      }
    }
    if (this.cellY.length !== height) {
      this.cellY = new Uint16Array(height);
      this.fractionY = new Float64Array(height);
      for (let y = 0; y < height; y++) {
        const c = y * (rows - 1) / height;
        const cell = Math.min(rows - 2, Math.trunc(c));
        this.cellY[y] = cell;
        this.fractionY[y] = c - cell;
      }
    }
  }
};
var AVS_ENHANCED_DYNAMIC_MOVEMENT_WGSL = (
  /* wgsl */
  `
struct Params { width: u32, pixels: u32, bilinear: u32, blend: u32 };
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<storage, read> map: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;
fn avs_table(a:u32,b:u32)->u32 { var r=(a*b)/255u; let c=(a==147u&&(b==85u||b==170u))||(a==155u&&(b==51u||b==102u||b==153u||b==204u))||(a==171u&&(b==85u||b==170u))||(a==187u&&(b==75u||b==150u||b==165u))||(a==195u&&b==153u); if(c){r-=1u;} return r; }
fn blend(a:u32,b:u32,alpha:u32)->u32 { let inv=255u-alpha; let lo=avs_table(a&255u,alpha)+avs_table(b&255u,inv); let mi=avs_table((a>>8u)&255u,alpha)+avs_table((b>>8u)&255u,inv); let hi=avs_table((a>>16u)&255u,alpha)+avs_table((b>>16u)&255u,inv); return lo|(mi<<8u)|(hi<<16u); }
fn sample4(offset:u32,fx:u32,fy:u32)->u32 { let ix=255u-fx; let iy=255u-fy; let w=array<u32,4>(avs_table(ix,iy),avs_table(fx,iy),avs_table(ix,fy),avs_table(fx,fy)); let p=array<u32,4>(source[offset],source[offset+1u],source[offset+params.width],source[offset+params.width+1u]); var lo=0u;var mi=0u;var hi=0u;for(var i=0u;i<4u;i++){lo+=avs_table(p[i]&255u,w[i]);mi+=avs_table((p[i]>>8u)&255u,w[i]);hi+=avs_table((p[i]>>16u)&255u,w[i]);}return (lo&255u)|((mi&255u)<<8u)|((hi&255u)<<16u); }
@compute @workgroup_size(256) fn dynamic_movement_main(@builtin(global_invocation_id) id:vec3u){let i=id.x;if(i>=params.pixels){return;}let offset=map[i*2u];let extra=map[i*2u+1u];var sampled=source[offset];if(params.bilinear!=0u){sampled=sample4(offset,extra&255u,(extra>>8u)&255u);}destination[i]=select(sampled,blend(sampled,source[i],(extra>>16u)&255u),params.blend!=0u);}
`
);
var EnhancedDynamicMovementGpuPass = class {
  constructor(device, generator, width, height) {
    this.device = device;
    this.generator = generator;
    this.width = width;
    this.height = height;
    this.pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: AVS_ENHANCED_DYNAMIC_MOVEMENT_WGSL }), entryPoint: "dynamic_movement_main" } });
    this.map = device.createBuffer({ size: width * height * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  capability = AVS_GPU_DYNAMIC_MOVEMENT_CAPABILITY;
  pipeline;
  map;
  params;
  groups = /* @__PURE__ */ new WeakMap();
  update(audio) {
    const map = this.generator.generate(audio, this.width, this.height);
    this.device.queue.writeBuffer(this.map, 0, map.packed.buffer, map.packed.byteOffset, map.packed.byteLength);
    this.device.queue.writeBuffer(this.params, 0, new Uint32Array([this.width, this.width * this.height, map.bilinear ? 1 : 0, map.blend ? 1 : 0]));
  }
  encode(context) {
    let targets = this.groups.get(context.source);
    if (!targets) {
      targets = /* @__PURE__ */ new WeakMap();
      this.groups.set(context.source, targets);
    }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: context.source } }, { binding: 1, resource: { buffer: context.target } }, { binding: 2, resource: { buffer: this.map } }, { binding: 3, resource: { buffer: this.params } }] });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(context.width * context.height / 256));
    pass.end();
  }
  destroy() {
    this.map.destroy();
    this.params.destroy();
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
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

// src/avs/effects/dynamic-movement-eel-gpu.ts
var AVS_ENHANCED_DYNAMIC_MOVEMENT_RESIDENT_CAPABILITY = {
  id: "dynamic-movement-resident-f32-map",
  backend: "webgpu",
  lane: "120",
  byteExact: false,
  reason: "CPU preserves init/frame/beat state; pure point EEL generates the coarse grid and resamples resident packed-u32 surfaces on WebGPU."
};
var POINT_INPUTS = /* @__PURE__ */ new Set(["x", "y", "d", "r"]);
var WORKGROUP_SIZE = 256;
function compileEnhancedDynamicMovementResident(config) {
  let point;
  try {
    compileAvsEel(config.point);
    point = parseAvsEel(config.point);
  } catch (error) {
    return rejected(error);
  }
  const phaseReferences = /* @__PURE__ */ new Set();
  for (const source of [config.init, config.frame, config.beat]) {
    if (!source.trim()) continue;
    try {
      collectVariables(parseAvsEel(source).body, phaseReferences);
    } catch (error) {
      return rejected(error);
    }
  }
  const analysis = analysePointProgram(point.body, phaseReferences);
  if (!analysis.ok) return { eligible: false, reason: analysis.reason };
  try {
    const builder = new DynamicMovementWgslBuilder(analysis.uniformNames);
    const body = builder.program(point.body);
    return {
      eligible: true,
      program: {
        source: config.point,
        wgsl: residentShaderSource(body, analysis.uniformNames, builder.localNames),
        uniformNames: analysis.uniformNames,
        workgroupSize: WORKGROUP_SIZE
      }
    };
  } catch (error) {
    return rejected(error);
  }
}
function analysePointProgram(root, phaseReferences) {
  const values = root.kind === "sequence" ? root.values : [root];
  const written = /* @__PURE__ */ new Set();
  collectWrites(root, written);
  for (const name of written) {
    if (isRegister(name)) return { ok: false, reason: `${name} is shared register state` };
    if (phaseReferences.has(name)) return { ok: false, reason: `${name} is observed by init/frame/beat code` };
  }
  const initialized = new Set(POINT_INPUTS);
  const reads = /* @__PURE__ */ new Set(["alpha"]);
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
  const uniformNames = [...reads].filter((name) => !POINT_INPUTS.has(name) && !written.has(name) && !["$pi", "$e", "$phi"].includes(name)).sort();
  return { ok: true, uniformNames };
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
  if (node.kind === "call" && ["loop", "rand", "megabuf", "gmegabuf", "getosc", "getspec", "gettime", "getkbmouse"].includes(node.name)) {
    return `${node.name} is not a safe independent point operation`;
  }
  for (const child of children(node)) {
    const failure = validatePure(child, written, initialized, reads);
    if (failure) return failure;
  }
  return null;
}
var EnhancedDynamicMovementResidentState = class {
  constructor(config, program, global, seed) {
    this.config = config;
    this.program = program;
    this.vm = new AvsEelVm({ global, seed });
    this.init = bindOrNull(config.init, this.vm);
    this.frame = bindOrNull(config.frame, this.vm);
    this.beat = bindOrNull(config.beat, this.vm);
    this.packedVariables = new Float32Array(Math.max(4, program.uniformNames.length));
  }
  vm;
  init;
  frame;
  beat;
  packedVariables;
  initialized = false;
  update(audio, width, height) {
    this.vm.setHost({
      getosc: (band, sampleWidth, channel) => avsAudioSample(audio, "osc", band, sampleWidth, channel),
      getspec: (band, sampleWidth, channel) => avsAudioSample(audio, "spec", band, sampleWidth, channel)
    });
    this.vm.set("w", width);
    this.vm.set("h", height);
    this.vm.set("b", audio.beat ? 1 : 0);
    this.vm.set("alpha", 0.5);
    if (!this.initialized) {
      this.init?.();
      this.initialized = true;
    }
    this.frame?.();
    if (audio.beat) this.beat?.();
    for (let index = 0; index < this.program.uniformNames.length; index++) {
      const value = this.vm.get(this.program.uniformNames[index]);
      this.packedVariables[index] = Number.isFinite(value) ? value : 0;
    }
    return this.packedVariables;
  }
};
var EnhancedDynamicMovementResidentGpuPass = class {
  constructor(device, state, width, height) {
    this.device = device;
    this.state = state;
    this.width = width;
    this.height = height;
    const { config, program } = state;
    if (config.buffer !== 0 || config.noMove) throw new Error("Resident Dynamic Movement rejects global-buffer and no-move modes");
    if (config.bilinear && (width < 2 || height < 2)) throw new RangeError("Resident bilinear Dynamic Movement requires dimensions >= 2");
    const columns = columnsFor(config), rows = rowsFor(config);
    const module = device.createShaderModule({ label: "AVS enhanced Dynamic Movement resident map", code: program.wgsl });
    this.bindGroupLayout = device.createBindGroupLayout({
      label: "AVS Dynamic Movement resident layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
      ]
    });
    const layout = device.createPipelineLayout({ label: "AVS Dynamic Movement resident pipeline layout", bindGroupLayouts: [this.bindGroupLayout] });
    this.gridPipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: "dynamic_movement_grid" } });
    this.resamplePipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: "dynamic_movement_resample" } });
    this.grid = storageBuffer(device, "AVS Dynamic Movement resident grid", columns * rows * 16, 0);
    this.variables = storageBuffer(device, "AVS Dynamic Movement resident uniforms", Math.max(4, program.uniformNames.length) * 4, GPUBufferUsage.COPY_DST);
    this.params = device.createBuffer({ label: "AVS Dynamic Movement resident params", size: this.packedParams.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  capability = AVS_ENHANCED_DYNAMIC_MOVEMENT_RESIDENT_CAPABILITY;
  gridPipeline;
  resamplePipeline;
  bindGroupLayout;
  grid;
  variables;
  params;
  packedParams = new Uint32Array(12);
  groups = /* @__PURE__ */ new WeakMap();
  destroyed = false;
  /** Uploads scalar phase state only; the coarse grid and packed sampling map stay on GPU. */
  update(audio) {
    this.assertActive();
    const packedVariables = this.state.update(audio, this.width, this.height);
    const { config, program } = this.state;
    this.packedParams.set([
      this.width,
      this.height,
      this.width * this.height,
      columnsFor(config),
      rowsFor(config),
      config.bilinear ? 1 : 0,
      config.blend ? 1 : 0,
      config.wrap ? 1 : 0,
      config.rectangular ? 1 : 0,
      program.uniformNames.length,
      0,
      0
    ]);
    this.device.queue.writeBuffer(this.variables, 0, packedVariables.buffer, packedVariables.byteOffset, packedVariables.byteLength);
    this.device.queue.writeBuffer(this.params, 0, this.packedParams);
  }
  encode(context) {
    this.assertActive();
    let targets = this.groups.get(context.source);
    if (!targets) {
      targets = /* @__PURE__ */ new WeakMap();
      this.groups.set(context.source, targets);
    }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: "AVS Dynamic Movement resident bindings",
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } },
          { binding: 2, resource: { buffer: this.grid } },
          { binding: 3, resource: { buffer: this.variables } },
          { binding: 4, resource: { buffer: this.params } }
        ]
      });
      targets.set(context.target, group);
    }
    let pass = context.encoder.beginComputePass({ label: "AVS Dynamic Movement resident grid" });
    pass.setPipeline(this.gridPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(columnsFor(this.state.config) * rowsFor(this.state.config) / WORKGROUP_SIZE));
    pass.end();
    pass = context.encoder.beginComputePass({ label: "AVS Dynamic Movement resident resample" });
    pass.setPipeline(this.resamplePipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(context.width * context.height / WORKGROUP_SIZE));
    pass.end();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.grid.destroy();
    this.variables.destroy();
    this.params.destroy();
  }
  assertActive() {
    if (this.destroyed) throw new Error("AVS resident Dynamic Movement pass is destroyed");
  }
};
function residentShaderSource(body, uniformNames, locals) {
  const declarations = [...locals].filter((name) => !["v_x", "v_y", "v_d", "v_r", "v_alpha"].includes(name)).sort().map((name) => `var ${name}: f32 = 0.0;`).join("\n  ");
  const alphaIndex = uniformNames.indexOf("alpha");
  return (
    /* wgsl */
    `
struct Params { width:u32, height:u32, pixels:u32, columns:u32, rows:u32, bilinear:u32, blend_enabled:u32, wrap_enabled:u32, rectangular:u32, variable_count:u32, _p0:u32, _p1:u32 };
@group(0) @binding(0) var<storage,read> source:array<u32>;
@group(0) @binding(1) var<storage,read_write> destination:array<u32>;
@group(0) @binding(2) var<storage,read_write> grid:array<vec4f>;
@group(0) @binding(3) var<storage,read> initial:array<f32>;
@group(0) @binding(4) var<uniform> params:Params;
fn finite(v:f32)->f32{return select(0.0,v,v==v&&abs(v)<=3.402823e38);}
fn truth(v:f32)->bool{return abs(v)>=0.00001;}
fn close(a:f32,b:f32)->bool{return abs(a-b)<0.00001;}
fn divide(a:f32,b:f32)->f32{return select(finite(a/b),0.0,abs(b)<1.1920929e-7);}
fn modulo(a:f32,b:f32)->f32{return select(finite(a%b),0.0,abs(b)<1.1920929e-7);}
fn avs_table(a:u32,b:u32)->u32{var r=(a*b)/255u;let c=(a==147u&&(b==85u||b==170u))||(a==155u&&(b==51u||b==102u||b==153u||b==204u))||(a==171u&&(b==85u||b==170u))||(a==187u&&(b==75u||b==150u||b==165u))||(a==195u&&b==153u);if(c){r-=1u;}return r;}
fn blend_avs(a:u32,b:u32,alpha:u32)->u32{let inv=255u-alpha;let lo=avs_table(a&255u,alpha)+avs_table(b&255u,inv);let mi=avs_table((a>>8u)&255u,alpha)+avs_table((b>>8u)&255u,inv);let hi=avs_table((a>>16u)&255u,alpha)+avs_table((b>>16u)&255u,inv);return lo|(mi<<8u)|(hi<<16u);}
fn sample4(offset:u32,fx:u32,fy:u32)->u32{let ix=255u-fx;let iy=255u-fy;let w=array<u32,4>(avs_table(ix,iy),avs_table(fx,iy),avs_table(ix,fy),avs_table(fx,fy));let p=array<u32,4>(source[offset],source[offset+1u],source[offset+params.width],source[offset+params.width+1u]);var lo=0u;var mi=0u;var hi=0u;for(var i=0u;i<4u;i++){lo+=avs_table(p[i]&255u,w[i]);mi+=avs_table((p[i]>>8u)&255u,w[i]);hi+=avs_table((p[i]>>16u)&255u,w[i]);}return (lo&255u)|((mi&255u)<<8u)|((hi&255u)<<16u);}
@compute @workgroup_size(${WORKGROUP_SIZE}) fn dynamic_movement_grid(@builtin(global_invocation_id) id:vec3u){
  let index=id.x;if(index>=params.columns*params.rows){return;}let gx=index%params.columns;let gy=index/params.columns;
  let sx=f32(gx)*f32(params.width)/f32(params.columns-1u);let sy=f32(gy)*f32(params.height)/f32(params.rows-1u);
  let cx=f32(params.width)*0.5;let cy=f32(params.height)*0.5;let radius=sqrt(f32(params.width*params.width+params.height*params.height))*0.5;
  var v_x=(sx-cx)*(2.0/f32(params.width));var v_y=(sy-cy)*(2.0/f32(params.height));
  var v_d=sqrt((sx-cx)*(sx-cx)+(sy-cy)*(sy-cy))/radius;var v_r=atan2(sy-cy,sx-cx)+3.14159265358979323846*0.5;
  var v_alpha:f32=${alphaIndex < 0 ? "0.5" : `initial[${alphaIndex}u]`};${declarations ? `
  ${declarations}` : ""}
  var _result=0.0;${body ? `
  ${body}` : ""}
  var mx=0.0;var my=0.0;if(params.rectangular!=0u){mx=(v_x+1.0)*f32(params.width)*0.5;my=(v_y+1.0)*f32(params.height)*0.5;}else{let distance=v_d*radius;let angle=v_r-3.14159265358979323846*0.5;mx=f32(params.width)*0.5+cos(angle)*distance;my=f32(params.height)*0.5+sin(angle)*distance;}grid[index]=vec4f(mx,my,clamp(v_alpha,0.0,1.0),0.0);
}
@compute @workgroup_size(${WORKGROUP_SIZE}) fn dynamic_movement_resample(@builtin(global_invocation_id) id:vec3u){
  let i=id.x;if(i>=params.pixels){return;}let x=i%params.width;let y=i/params.width;
  let cellfx=f32(x)*f32(params.columns-1u)/f32(params.width);let cellfy=f32(y)*f32(params.rows-1u)/f32(params.height);
  let cellx=min(params.columns-2u,u32(cellfx));let celly=min(params.rows-2u,u32(cellfy));let fx=cellfx-f32(cellx);let fy=cellfy-f32(celly);let invy=1.0-fy;let tl=cellx+celly*params.columns;
  let a=grid[tl];let b=grid[tl+1u];let c=grid[tl+params.columns];let d=grid[tl+params.columns+1u];
  var mapped=(a+(b-a)*fx)*invy+(c+(d-c)*fx)*fy;let maximum=vec2f(f32(params.width-select(1u,2u,params.bilinear!=0u)),f32(params.height-select(1u,2u,params.bilinear!=0u)));let span=max(vec2f(1.0),maximum);
  if(params.wrap_enabled!=0u){mapped.xy=((mapped.xy%span)+span)%span;}else{mapped.x=clamp(mapped.x,0.0,maximum.x);mapped.y=clamp(mapped.y,0.0,maximum.y);}
  let ix=u32(mapped.x);let iy=u32(mapped.y);let offset=ix+iy*params.width;var sampled=source[offset];
  if(params.bilinear!=0u&&params.width>=2u&&params.height>=2u){sampled=sample4(offset,u32((mapped.x-f32(ix))*256.0)&255u,u32((mapped.y-f32(iy))*256.0)&255u);}let alpha=u32(clamp(mapped.z,0.0,1.0)*255.0);destination[i]=select(sampled,blend_avs(sampled,source[i],alpha),params.blend_enabled!=0u);
}`
  );
}
var DynamicMovementWgslBuilder = class {
  localNames = /* @__PURE__ */ new Set();
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
        lines.push(`_result=finite(${this.expression(node)});`);
        continue;
      }
      const target = this.name(assignment2.target);
      this.localNames.add(target);
      lines.push(`${target}=${assignmentExpression(assignment2.operator, target, this.expression(assignment2.value))};`, `_result=${target};`);
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
        const v = this.expression(node.value);
        if (node.operator === "+") return `finite(${v})`;
        if (node.operator === "-") return `finite(-(${v}))`;
        if (node.operator === "!") return `select(1.0,0.0,truth(${v}))`;
        if (node.operator === "~") return `f32(~i32(${v}))`;
        throw new Error(`Unsupported unary ${node.operator}`);
      }
      case "binary":
        return this.binary(node.operator, node.left, node.right);
      case "conditional":
        return `select(${this.expression(node.no)},${this.expression(node.yes)},truth(${this.expression(node.condition)}))`;
      case "call":
        return this.call(node.name, node.args);
      case "sequence":
        if (node.values.length === 1) return this.expression(node.values[0]);
        throw new Error("Nested sequence is not GPU-pure");
      case "assign":
        throw new Error("Nested assignment is not GPU-pure");
    }
  }
  binary(op, l, r) {
    const a = this.expression(l), b = this.expression(r);
    switch (op) {
      case "+":
        return `finite((${a})+(${b}))`;
      case "-":
        return `finite((${a})-(${b}))`;
      case "*":
        return `finite((${a})*(${b}))`;
      case "/":
        return `divide(${a},${b})`;
      case "%":
        return `modulo(${a},${b})`;
      case "**":
        return `finite(pow(${a},${b}))`;
      case "|":
        return `f32(i32(${a})|i32(${b}))`;
      case "&":
        return `f32(i32(${a})&i32(${b}))`;
      case "^":
        return `f32(i32(${a})^i32(${b}))`;
      case "<<":
        return `f32(i32(${a})<<(u32(i32(${b}))&31u))`;
      case ">>":
        return `f32(i32(${a})>>(u32(i32(${b}))&31u))`;
      case "&&":
        return `select(0.0,select(0.0,1.0,truth(${b})),truth(${a}))`;
      case "||":
        return `select(select(0.0,1.0,truth(${b})),1.0,truth(${a}))`;
      case "==":
        return `select(0.0,1.0,close(${a},${b}))`;
      case "!=":
        return `select(1.0,0.0,close(${a},${b}))`;
      case "===":
        return `select(0.0,1.0,(${a})==(${b}))`;
      case "!==":
        return `select(0.0,1.0,(${a})!=(${b}))`;
      case "<":
      case "<=":
      case ">":
      case ">=":
        return `select(0.0,1.0,(${a})${op}(${b}))`;
      default:
        throw new Error(`Unsupported binary ${op}`);
    }
  }
  call(name, nodes) {
    if (name === "if") return `select(${this.expression(nodes[2])},${this.expression(nodes[1])},truth(${this.expression(nodes[0])}))`;
    const a = nodes.map((n) => this.expression(n)), one = (f) => `finite(${f}(${a[0]}))`, two = (f) => `finite(${f}(${a[0]},${a[1]}))`;
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
      case "abs":
      case "floor":
      case "ceil":
        return one(name);
      case "atan2":
        return two("atan2");
      case "sqr":
        return `finite((${a[0]})*(${a[0]}))`;
      case "invsqrt":
        return `finite(inverseSqrt(${a[0]}))`;
      case "pow":
      case "min":
      case "max":
        return two(name);
      case "log10":
        return `finite(log2(${a[0]})/log2(10.0))`;
      case "int":
        return `finite(trunc(${a[0]}))`;
      case "sign":
        return `select(select(0.0,1.0,(${a[0]})>0.0),-1.0,(${a[0]})<0.0)`;
      case "equal":
        return `select(0.0,1.0,close(${a[0]},${a[1]}))`;
      case "above":
        return `select(0.0,1.0,(${a[0]})>(${a[1]}))`;
      case "below":
        return `select(0.0,1.0,(${a[0]})<(${a[1]}))`;
      case "band":
        return `select(0.0,1.0,truth(${a[0]})&&truth(${a[1]}))`;
      case "bor":
        return `select(0.0,1.0,truth(${a[0]})||truth(${a[1]}))`;
      case "bnot":
        return `select(1.0,0.0,truth(${a[0]}))`;
      default:
        throw new Error(`Function ${name} is not supported by resident Dynamic Movement`);
    }
  }
  variable(raw) {
    const name = normalize(raw);
    if (name === "$pi") return "3.14159265358979323846";
    if (name === "$e") return "2.71828182845904523536";
    if (name === "$phi") return "1.61803398874989484820";
    const local = this.name(name);
    if (POINT_INPUTS.has(name) || this.localNames.has(local)) return local;
    const index = this.uniformIndex.get(name);
    if (index === void 0) throw new Error(`Missing GPU input ${name}`);
    return `initial[${index}u]`;
  }
  name(raw) {
    return `v_${normalize(raw).replace(/^\$/, "").replace(/[^a-z0-9_]/g, "_")}`;
  }
};
function collectWrites(node, target) {
  if (node.kind === "assign" && node.target.kind === "variable") target.add(normalize(node.target.name));
  if (node.kind === "call" && node.name === "assign" && node.args[0]?.kind === "variable") target.add(normalize(node.args[0].name));
  for (const child of children(node)) collectWrites(child, target);
}
function collectVariables(node, target) {
  if (node.kind === "variable") target.add(normalize(node.name));
  for (const child of children(node)) collectVariables(child, target);
}
function directAssignment(node) {
  if (node.kind === "assign" && node.target.kind === "variable") return { target: node.target.name, operator: node.operator, value: node.value };
  if (node.kind === "call" && node.name === "assign" && node.args[0]?.kind === "variable" && node.args[1]) return { target: node.args[0].name, operator: "=", value: node.args[1] };
  return null;
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
function assignmentExpression(op, left, right) {
  switch (op) {
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
      throw new Error(`Unsupported assignment ${op}`);
  }
}
function bindOrNull(source, vm) {
  if (!source.trim()) return null;
  try {
    return compileAvsEel(source).bind(vm);
  } catch {
    return null;
  }
}
function columnsFor(config) {
  return clampInt(Math.trunc(config.gridWidth) + 1, 2, 256);
}
function rowsFor(config) {
  return clampInt(Math.trunc(config.gridHeight) + 1, 2, 256);
}
function storageBuffer(device, label, size, extra) {
  return device.createBuffer({ label, size: Math.max(16, Math.ceil(size / 16) * 16), usage: GPUBufferUsage.STORAGE | extra });
}
function normalize(name) {
  return name.toLowerCase().slice(0, 8);
}
function isRegister(name) {
  return /^reg\d\d$/.test(name);
}
function numberLiteral2(value) {
  if (!Number.isFinite(value)) return "0.0";
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}
function clampInt(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
function rejected(error) {
  return { eligible: false, reason: error instanceof Error ? error.message : String(error) };
}

// tools/avs-dynamic-movement-gpu-browser-check.ts
void run().catch((error) => finish({ error: error instanceof Error ? error.stack : String(error) }));
async function run() {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no adapter");
  const device = await adapter.requestDevice();
  const width = 64, height = 36;
  const audio = {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat: false,
    beatLevel: 0
  };
  const source = pixels(width * height);
  const uploaded = await checkUploadedMap(device, audio, source, width, height);
  const resident = await checkResidentMap(device, audio, source, width, height);
  const timingWidth = 640, timingHeight = 360, timingSource = pixels(timingWidth * timingHeight);
  const timingConfig = decodeAvsDynamicMovement(payload());
  const timingProgram = compileEnhancedDynamicMovementResident(timingConfig);
  if (!timingProgram.eligible) throw new Error(timingProgram.reason);
  const uploadedTiming = await benchmark(device, timingSource, timingWidth, timingHeight, () => {
    const generator = new AvsDynamicMovementGpuMapGenerator(timingConfig, new AvsEelGlobalState(), 1);
    const pass = new EnhancedDynamicMovementGpuPass(device, generator, timingWidth, timingHeight);
    return { pass, update: () => pass.update(audio) };
  });
  const residentTiming = await benchmark(device, timingSource, timingWidth, timingHeight, () => {
    const state = new EnhancedDynamicMovementResidentState(timingConfig, timingProgram.program, new AvsEelGlobalState(), 1);
    const pass = new EnhancedDynamicMovementResidentGpuPass(device, state, timingWidth, timingHeight);
    return { pass, update: () => pass.update(audio) };
  });
  finish({ pass: true, uploaded, resident, warmed640x360: { uploadedMapMs: uploadedTiming, residentMapMs: residentTiming } });
}
async function benchmark(device, source, width, height, create) {
  const bytes = source.byteLength;
  const input = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
  device.queue.writeBuffer(input, 0, source);
  const { pass, update } = create();
  const runFrame = async () => {
    const started = performance.now();
    update();
    const encoder = device.createCommandEncoder();
    pass.encode({ device, encoder, width, height, source: input, target: output });
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - started;
  };
  for (let index = 0; index < 5; index++) await runFrame();
  const samples = [];
  for (let index = 0; index < 20; index++) samples.push(await runFrame());
  samples.sort((a, b) => a - b);
  pass.destroy();
  input.destroy();
  output.destroy();
  return { median: samples[Math.trunc(samples.length / 2)], p95: samples[Math.trunc(samples.length * 0.95)], iterations: samples.length };
}
async function checkUploadedMap(device, audio, source, width, height) {
  const config = decodeAvsDynamicMovement(payload());
  const generator = new AvsDynamicMovementGpuMapGenerator(config, new AvsEelGlobalState(), 1);
  const map = generator.generate(audio, width, height);
  const expected = emulate(source, width, map);
  const result = await execute2(device, source, width, height, (encoder, input, output) => {
    const pass = new EnhancedDynamicMovementGpuPass(device, generator, width, height);
    pass.update(audio);
    pass.encode({ device, encoder, width, height, source: input, target: output });
    return pass;
  });
  assertPixels(result.actual, expected);
  result.pass.destroy();
  return { exactPixels: result.actual.length, submitGpuReadbackMs: result.ms, hostUploadBytes: width * height * 8 };
}
async function checkResidentMap(device, audio, source, width, height) {
  const base = decodeAvsDynamicMovement(payload());
  const config = {
    ...base,
    point: "x=0;y=0;alpha=1",
    rectangular: true,
    bilinear: false,
    blend: false,
    wrap: false
  };
  const compiled = compileEnhancedDynamicMovementResident(config);
  if (!compiled.eligible) throw new Error(compiled.reason);
  const expected = new Uint32Array(source.length).fill(source[Math.trunc(width * 0.5) + Math.trunc(height * 0.5) * width]);
  const result = await execute2(device, source, width, height, (encoder, input, output) => {
    const state = new EnhancedDynamicMovementResidentState(config, compiled.program, new AvsEelGlobalState(), 1);
    const pass = new EnhancedDynamicMovementResidentGpuPass(device, state, width, height);
    pass.update(audio);
    pass.encode({ device, encoder, width, height, source: input, target: output });
    return pass;
  });
  assertPixels(result.actual, expected);
  result.pass.destroy();
  return { exactEnhancedPixels: result.actual.length, submitGpuReadbackMs: result.ms, hostUploadBytes: 64 };
}
async function execute2(device, source, width, height, encode) {
  const bytes = source.byteLength;
  const input = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  device.queue.writeBuffer(input, 0, source);
  device.pushErrorScope("validation");
  const encoder = device.createCommandEncoder();
  const pass = encode(encoder, input, output);
  encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
  const started = performance.now();
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const ms = performance.now() - started;
  const validation = await device.popErrorScope();
  if (validation) throw validation;
  const actual = new Uint32Array(new Uint32Array(read.getMappedRange()).slice());
  read.unmap();
  input.destroy();
  output.destroy();
  read.destroy();
  return { actual, ms, pass };
}
function assertPixels(actual, expected) {
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) throw new Error(`pixel ${index}: ${actual[index].toString(16)} != ${expected[index].toString(16)}`);
  }
}
function payload() {
  const strings = ["x=x+0.05*sin(d*5);y=y+0.03*cos(r);alpha=0.25+0.5*d", "", "", ""].map((value) => new TextEncoder().encode(value));
  const out = new Uint8Array(1 + strings.reduce((sum, value) => sum + 4 + value.length, 0) + 32);
  const view = new DataView(out.buffer);
  let offset = 0;
  out[offset++] = 1;
  for (const value of strings) {
    view.setUint32(offset, value.length, true);
    offset += 4;
    out.set(value, offset);
    offset += value.length;
  }
  for (const value of [1, 1, 16, 16, 1, 0, 0, 0]) {
    view.setInt32(offset, value, true);
    offset += 4;
  }
  return out;
}
function emulate(source, width, map) {
  const output = new Uint32Array(source.length), table = (a, b) => Math.trunc(a / 255 * b);
  for (let index = 0; index < source.length; index++) {
    const offset = map.packed[index * 2], extra = map.packed[index * 2 + 1];
    const fx = extra & 255, fy = extra >>> 8 & 255;
    const weights = [table(255 - fx, 255 - fy), table(fx, 255 - fy), table(255 - fx, fy), table(fx, fy)];
    const samples = [source[offset], source[offset + 1], source[offset + width], source[offset + width + 1]];
    const channel = (shift) => samples.reduce((sum, pixel, sample) => sum + table(pixel >>> shift & 255, weights[sample]), 0) & 255;
    const sampled = channel(0) | channel(8) << 8 | channel(16) << 16;
    const alpha = extra >>> 16 & 255, inverse = 255 - alpha, current = source[index];
    const blend = (shift) => table(sampled >>> shift & 255, alpha) + table(current >>> shift & 255, inverse);
    output[index] = blend(0) | blend(8) << 8 | blend(16) << 16;
  }
  return output;
}
function pixels(count) {
  let state = 1146703425;
  const output = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = state & 16777215;
  }
  return output;
}
function finish(value) {
  document.querySelector("pre").textContent = JSON.stringify(value, null, 2);
  document.documentElement.dataset.done = "true";
}
