// src/avs/types.ts
var AVS_FFT_SIZE = 512;
var AVS_FFT_BINS = AVS_FFT_SIZE / 2;

// src/avs/preset.ts
var TEXT = new TextDecoder("windows-1252");

// src/avs/eel/vm.ts
var MEMORY_BLOCK_SIZE = 16384;
var MEMORY_BLOCK_COUNT = 64;
var MEMORY_CELL_COUNT = MEMORY_BLOCK_SIZE * MEMORY_BLOCK_COUNT;

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

// src/avs/effects/buffer-save-gpu.ts
var AVS_GPU_BUFFER_SAVE_CAPABILITY = {
  id: "buffer-save-resident-packed-u32",
  backend: "webgpu",
  lane: "exact",
  byteExact: true,
  reason: "Retains the eight shared global buffers on GPU and preserves native store/load phase and integer blends."
};
function resolveExactAvsBufferSaveDirection(direction, phase) {
  if (!Number.isInteger(direction)) throw new TypeError("Buffer Save direction must be an integer");
  if (phase !== 0 && phase !== 1) throw new RangeError(`Unsupported Buffer Save phase ${phase}`);
  if (direction < 2) return { direction: direction === 0 ? "store" : "load", nextPhase: phase };
  return { direction: (direction & 1 ^ phase) === 0 ? "store" : "load", nextPhase: phase ^ 1 };
}
var BUFFER_SAVE_MODES = /* @__PURE__ */ new Set([
  "replace",
  "average",
  "additive",
  "every-other-pixel",
  "destination-minus-source",
  "every-other-line",
  "xor",
  "maximum",
  "minimum",
  "source-minus-destination",
  "multiply",
  "adjustable"
]);
function assessExactGpuBufferSave(operation2, initialPhase = 0) {
  if (!Number.isInteger(operation2.direction)) return { eligible: false, reason: "Buffer Save direction is not an integer" };
  if (!Number.isInteger(operation2.bufferIndex) || operation2.bufferIndex < 0 || operation2.bufferIndex > 7) {
    return { eligible: false, reason: `invalid global buffer ${operation2.bufferIndex}` };
  }
  if (initialPhase !== 0 && initialPhase !== 1) return { eligible: false, reason: `unsupported alternating phase ${initialPhase}` };
  if (operation2.condition !== "frame-not-preinit") return { eligible: false, reason: `unsupported execution condition ${operation2.condition}` };
  if (!Number.isInteger(operation2.blendCode) || operation2.blendCode < 0 || operation2.blendCode > 11) {
    return { eligible: false, reason: `unsupported Buffer Save blend code ${operation2.blendCode}` };
  }
  if (!BUFFER_SAVE_MODES.has(operation2.blendMode)) return { eligible: false, reason: `unsupported Buffer Save blend ${operation2.blendMode}` };
  const alternating = operation2.direction >= 2;
  if (operation2.alternatesEachFrame !== alternating || operation2.cpuPhaseState !== alternating) {
    return { eligible: false, reason: "surface-plan phase metadata does not match native direction" };
  }
  const directions = alternating ? "store,load" : operation2.direction === 0 ? "store" : "load";
  if (operation2.possibleDirections.join(",") !== directions) {
    return { eligible: false, reason: "surface-plan direction dependencies do not match native direction" };
  }
  if (operation2.createsBuffer !== (operation2.direction !== 1)) {
    return { eligible: false, reason: "surface-plan lazy-buffer metadata does not match native direction" };
  }
  return { eligible: true, reason: "exact resident global-buffer operation" };
}
var ExactAvsGpuBufferBank = class {
  constructor(device, width, height) {
    this.device = device;
    this.width = width;
    this.height = height;
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError("Buffer Save dimensions must be positive integers");
    }
    this.framebufferBytes = width * height * Uint32Array.BYTES_PER_ELEMENT;
  }
  framebufferBytes;
  buffers = new Array(8).fill(null);
  initialized = new Uint8Array(8);
  resource(index, create) {
    const existing = this.buffers[index] ?? null;
    if (existing || !create) return existing;
    const buffer = this.device.createBuffer({
      label: `AVS global buffer ${index}`,
      size: this.framebufferBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    this.buffers[index] = buffer;
    return buffer;
  }
  hasValue(index) {
    return this.initialized[index] === 1;
  }
  markStored(index) {
    this.initialized[index] = 1;
  }
  destroy() {
    for (const buffer of this.buffers) buffer?.destroy();
    this.buffers.fill(null);
    this.initialized.fill(0);
  }
};
var ExactAvsBufferSaveGpuPass = class {
  constructor(device, bank, operation2, initialPhase = 0) {
    this.bank = bank;
    this.operation = operation2;
    const eligibility = assessExactGpuBufferSave(operation2, initialPhase);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    this.phase = initialPhase;
    const hasStore = operation2.possibleDirections.includes("store");
    const hasLoad = operation2.possibleDirections.includes("load");
    const needsBlendPipeline = operation2.blendMode !== "replace";
    this.storePipeline = hasStore && needsBlendPipeline ? createPipeline(device, operation2, true, bank.width) : null;
    this.loadPipeline = hasLoad && needsBlendPipeline ? createPipeline(device, operation2, false, bank.width) : null;
  }
  capability = AVS_GPU_BUFFER_SAVE_CAPABILITY;
  storePipeline;
  loadPipeline;
  groups = /* @__PURE__ */ new WeakMap();
  phase;
  encode(context) {
    if (context.width !== this.bank.width || context.height !== this.bank.height) {
      throw new RangeError(`Buffer Save pass is ${this.bank.width}x${this.bank.height}, got ${context.width}x${context.height}`);
    }
    const step = resolveExactAvsBufferSaveDirection(this.operation.direction, this.phase);
    this.phase = step.nextPhase;
    const store = step.direction === "store";
    if (!store && !this.bank.hasValue(this.operation.bufferIndex)) {
      context.encoder.copyBufferToBuffer(context.source, 0, context.target, 0, this.bank.framebufferBytes);
      return;
    }
    const global = this.bank.resource(this.operation.bufferIndex, store);
    if (!global) throw new Error("initialized Buffer Save surface is absent");
    if (this.operation.blendMode === "replace") {
      if (store) {
        context.encoder.copyBufferToBuffer(context.source, 0, global, 0, this.bank.framebufferBytes);
        context.encoder.copyBufferToBuffer(context.source, 0, context.target, 0, this.bank.framebufferBytes);
        this.bank.markStored(this.operation.bufferIndex);
      } else {
        context.encoder.copyBufferToBuffer(global, 0, context.target, 0, this.bank.framebufferBytes);
      }
      return;
    }
    const pipeline = store ? this.storePipeline : this.loadPipeline;
    if (!pipeline) throw new Error(`Buffer Save ${store ? "store" : "load"} pipeline was not compiled`);
    const group = this.bindGroup(context.device, pipeline, context.source, context.target, global, store);
    const pass = context.encoder.beginComputePass({ label: `AVS exact Buffer Save ${store ? "store" : "load"}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(context.width * context.height / 256));
    pass.end();
    if (store) this.bank.markStored(this.operation.bufferIndex);
  }
  bindGroup(device, pipeline, source, target, global, store) {
    let targets = this.groups.get(source);
    if (!targets) {
      targets = /* @__PURE__ */ new WeakMap();
      this.groups.set(source, targets);
    }
    let pair = targets.get(target);
    if (!pair) {
      pair = {};
      targets.set(target, pair);
    }
    const cached = store ? pair.store : pair.load;
    if (cached) return cached;
    const group = device.createBindGroup({
      label: `AVS exact Buffer Save ${store ? "store" : "load"} buffers`,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: global } },
        { binding: 2, resource: { buffer: target } }
      ]
    });
    if (store) pair.store = group;
    else pair.load = group;
    return group;
  }
};
function createPipeline(device, operation2, store, width) {
  const label = `AVS exact Buffer Save ${store ? "store" : "load"}`;
  const module = device.createShaderModule({ label, code: buildExactAvsBufferSaveWgsl(operation2, store, width) });
  return device.createComputePipeline({ label, layout: "auto", compute: { module, entryPoint: "main" } });
}
function buildExactAvsBufferSaveWgsl(operation2, store, width) {
  const eligibility = assessExactGpuBufferSave(operation2);
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (!operation2.possibleDirections.includes(store ? "store" : "load")) {
    throw new Error(`Buffer Save operation cannot ${store ? "store" : "load"}`);
  }
  if (!Number.isInteger(width) || width < 1) throw new RangeError("Buffer Save width must be a positive integer");
  const amount = Math.max(0, Math.min(255, Math.trunc(operation2.amount)));
  const body = store ? "let frame=framebuffer[index]&0x00ffffffu; let old=global_buffer[index]&0x00ffffffu; global_buffer[index]=blend(frame,old,index); output[index]=frame;" : "let frame=framebuffer[index]&0x00ffffffu; let saved=global_buffer[index]&0x00ffffffu; output[index]=blend(saved,frame,index);";
  return (
    /* wgsl */
    `
const WIDTH=${width}u;
@group(0) @binding(0) var<storage, read> framebuffer: array<u32>;
@group(0) @binding(1) var<storage, read_write> global_buffer: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
fn pack(b:u32,g:u32,r:u32)->u32{return (b&255u)|((g&255u)<<8u)|((r&255u)<<16u);}
fn blend(source:u32,destination:u32,index:u32)->u32{
  let sb=source&255u;let sg=(source>>8u)&255u;let sr=(source>>16u)&255u;
  let db=destination&255u;let dg=(destination>>8u)&255u;let dr=(destination>>16u)&255u;
  ${blendBody(operation2.blendMode, amount)}
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id:vec3u){let index=id.x;if(index>=arrayLength(&framebuffer)){return;}${body}}
`
  );
}
function blendBody(mode, amount) {
  switch (mode) {
    case "replace":
      return "return source;";
    case "average":
      return "return ((source>>1u)&0x007f7f7fu)+((destination>>1u)&0x007f7f7fu);";
    case "additive":
      return "return pack(min(255u,sb+db),min(255u,sg+dg),min(255u,sr+dr));";
    case "every-other-pixel":
      return "let y=index/WIDTH;let x=index-y*WIDTH;return select(destination,source,((x^y)&1u)==0u);";
    case "destination-minus-source":
      return "return pack(select(0u,db-sb,db>sb),select(0u,dg-sg,dg>sg),select(0u,dr-sr,dr>sr));";
    case "every-other-line":
      return "let y=index/WIDTH;return select(destination,source,(y&1u)==0u);";
    case "xor":
      return "return (source^destination)&0x00ffffffu;";
    case "maximum":
      return "return pack(max(sb,db),max(sg,dg),max(sr,dr));";
    case "minimum":
      return "return pack(min(sb,db),min(sg,dg),min(sr,dr));";
    case "source-minus-destination":
      return "return pack(select(0u,sb-db,sb>db),select(0u,sg-dg,sg>dg),select(0u,sr-dr,sr>dr));";
    case "multiply":
      return "return pack((sb*db)/255u,(sg*dg)/255u,(sr*dr)/255u);";
    case "adjustable": {
      const inverse = 255 - amount;
      return `return pack((sb*${amount}u)/255u+(db*${inverse}u)/255u,(sg*${amount}u)/255u+(dg*${inverse}u)/255u,(sr*${amount}u)/255u+(dr*${inverse}u)/255u);`;
    }
    default:
      throw new Error(`Unsupported Buffer Save blend ${mode}`);
  }
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

// src/avs/gpu-surface-plan.ts
var CONTROL_EFFECTS = /* @__PURE__ */ new Set([21, 33, 40]);
function planAvsResidentSurfaces(preset, options = {}) {
  const surfaces = /* @__PURE__ */ new Map();
  const scopes = /* @__PURE__ */ new Map();
  const operations = [];
  const issues = [];
  addSurface(surfaces, "$root", "root", false, null, null);
  addSurface(surfaces, "$root:alternate", "alternate", false, "$root", null);
  scopes.set("$root", { id: "$root", primary: "$root", alternate: "$root:alternate", aliasesParentCurrent: null });
  if (preset.clearEveryFrame) {
    operations.push({ kind: "root-clear", target: "$root", condition: "frame-not-preinit" });
  }
  visitChildren(preset.components, scopes.get("$root"), scopes, surfaces, operations, issues, options);
  return {
    surfaces: [...surfaces.values()],
    scopes: [...scopes.values()],
    operations,
    issues,
    eligible: issues.length === 0,
    framebufferReadbacks: 0,
    rootFeedbackResident: !preset.clearEveryFrame,
    residentBytesPerPixel: surfaces.size * Uint32Array.BYTES_PER_ELEMENT
  };
}
function visitChildren(children, scope, scopes, surfaces, operations, issues, options) {
  for (const component of children) {
    if (component.list) {
      visitList(component, scope, scopes, surfaces, operations, issues, options);
      continue;
    }
    if (!component.apeId && component.effectId === 18) {
      addBufferSave(component, scope, scopes, surfaces, operations);
      continue;
    }
    if (!component.apeId && CONTROL_EFFECTS.has(component.effectId)) {
      operations.push({
        kind: "cpu-control",
        path: component.path,
        effectId: component.effectId,
        target: scope.primary ?? inheritedPrimary(scope, scopes),
        scope: scope.id
      });
      continue;
    }
    const capability = options.effectCapability?.(component) ?? null;
    if (!capability || !capability.byteExact || !capability.readbackFree) {
      issues.push({
        path: component.path,
        code: "unsupported-renderer",
        message: `${component.apeId ?? `renderer ${component.effectId}`} lacks an exact readback-free resident capability`
      });
      continue;
    }
    operations.push({
      kind: "effect",
      path: component.path,
      effectId: component.effectId,
      apeId: component.apeId,
      target: scope.primary ?? inheritedPrimary(scope, scopes),
      alternate: scope.alternate,
      scope: scope.id,
      capability: capability.id
    });
  }
}
function visitList(component, parentScope, scopes, surfaces, operations, issues, options) {
  const settings = component.list;
  const direct = settings.inputBlendMode === 1 && settings.outputBlendMode === 1;
  const parent = parentScope.primary ?? inheritedPrimary(parentScope, scopes);
  const target = direct ? parent : `$list:${component.path}:retained`;
  const alternate = direct ? `$list:${component.path}:fast-alternate` : `$list:${component.path}:alternate`;
  if (!direct) addSurface(surfaces, target, "list-retained", false, component.path, null);
  addSurface(surfaces, alternate, "alternate", false, component.path, null);
  const scopeId = `$list:${component.path}`;
  const listScope = {
    id: scopeId,
    primary: direct ? null : target,
    alternate,
    aliasesParentCurrent: direct ? parentScope.id : null
  };
  scopes.set(scopeId, listScope);
  const input = direct ? null : listBlend(
    component.path,
    settings.inputBlendMode,
    settings.inputBlendValue,
    settings.inputBuffer,
    settings.inputInvert,
    surfaces,
    issues
  );
  const output = direct ? null : listBlend(
    component.path,
    settings.outputBlendMode,
    settings.outputBlendValue,
    settings.outputBuffer,
    settings.outputInvert,
    surfaces,
    issues
  );
  operations.push({
    kind: "list-enter",
    path: component.path,
    parentScope: parentScope.id,
    targetScope: scopeId,
    parent,
    target,
    alternate,
    direct,
    clearEveryFrame: settings.clearEveryFrame,
    blend: input,
    cpuControl: Boolean(component.listCode?.enabled || settings.beatRender || !settings.enabled),
    clearControl: component.listCode?.enabled ? "cpu" : settings.clearEveryFrame ? "always" : "never",
    blendCondition: "frame-not-preinit"
  });
  visitChildren(component.children, listScope, scopes, surfaces, operations, issues, options);
  operations.push({
    kind: "list-exit",
    path: component.path,
    sourceScope: scopeId,
    parentScope: parentScope.id,
    source: target,
    parent,
    direct,
    blend: output,
    blendCondition: "frame-not-preinit"
  });
}
function listBlend(path, modeCode, amount, depthIndex, invertDepth, surfaces, issues) {
  if (!(modeCode in AVS_LIST_BLEND_MODES)) {
    issues.push({ path, code: "unsupported-list-blend", message: `unknown Effect List blend mode ${modeCode}` });
  }
  const mode = decodeAvsListBlend(modeCode);
  const index = clamp(depthIndex, 0, 7);
  const depth = mode === "buffer-depth" ? `$global:${index}` : null;
  if (depth) addSurface(surfaces, depth, "global-buffer", true, null, index);
  return { mode, amount, depth, invertDepth, missingDepth: "no-op" };
}
function addBufferSave(component, scope, scopes, surfaces, operations) {
  const direction = int(component.payload, 0, 0);
  const bufferIndex = clamp(int(component.payload, 4, 0), 0, 7);
  const blendCode = int(component.payload, 8, 0);
  const amount = int(component.payload, 12, 128);
  const framebuffer = scope.primary ?? inheritedPrimary(scope, scopes);
  const buffer = `$global:${bufferIndex}`;
  addSurface(surfaces, buffer, "global-buffer", true, null, bufferIndex);
  const alternating = direction >= 2;
  const possibleDirections = alternating ? ["store", "load"] : direction === 0 ? ["store"] : ["load"];
  operations.push({
    kind: "buffer-save",
    path: component.path,
    framebufferScope: scope.id,
    framebuffer,
    buffer,
    bufferIndex,
    direction,
    possibleDirections,
    alternatesEachFrame: alternating,
    createsBuffer: direction !== 1,
    cpuPhaseState: alternating,
    condition: "frame-not-preinit",
    blendCode,
    blendMode: decodeBufferSaveBlend(blendCode),
    amount
  });
}
function decodeBufferSaveBlend(code) {
  return {
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
  }[code] ?? "replace";
}
function addSurface(surfaces, id, role, lazy, ownerPath, bufferIndex) {
  if (!surfaces.has(id)) surfaces.set(id, { id, role, persistent: true, lazy, ownerPath, bufferIndex });
}
function int(payload, offset, fallback) {
  return offset + 4 <= payload.byteLength ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}
function inheritedPrimary(scope, scopes) {
  let current = scope;
  while (current.primary === null) {
    const parent = current.aliasesParentCurrent && scopes.get(current.aliasesParentCurrent);
    if (!parent) throw new Error(`Resident scope ${current.id} has no physical parent`);
    current = parent;
  }
  return current.primary;
}

// src/avs/gpu-ordered-draw.ts
var DEFAULT_BUDGET = 64 * 1024 * 1024;
var DEFAULT_MAX_RECORDS = 4 * 128 * 1024;

// tools/avs-buffer-save-gpu-browser-check.ts
void run().catch((error) => finish({ error: error instanceof Error ? error.stack : String(error) }));
async function run() {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No adapter");
  const info = adapter.info;
  const device = await adapter.requestDevice();
  const width = 31, height = 19, pixels = width * height, frame = randomPixels(pixels, 608135816), saved = randomPixels(pixels, 2654435769);
  let exactPixels = 0;
  for (let blend = 0; blend < 12; blend++) {
    const bank2 = new ExactAvsGpuBufferBank(device, width, height), seed = new ExactAvsBufferSaveGpuPass(device, bank2, operation(0, 4, 0, 128)), store = new ExactAvsBufferSaveGpuPass(device, bank2, operation(0, 4, blend, 77)), load = new ExactAvsBufferSaveGpuPass(device, bank2, operation(1, 4, blend, 77)), replaceLoad = new ExactAvsBufferSaveGpuPass(device, bank2, operation(1, 4, 0, 128));
    await expect(device, seed, width, height, saved, saved, `blend ${blend} seed`);
    exactPixels += pixels;
    await expect(device, store, width, height, frame, frame, `blend ${blend} store passthrough`);
    exactPixels += pixels;
    const expectedStored = cpuBlend(frame, saved, width, height, blend, 77);
    await expect(device, replaceLoad, width, height, new Uint32Array(pixels), expectedStored, `blend ${blend} retained store`);
    exactPixels += pixels;
    bank2.destroy();
    const loadBank = new ExactAvsGpuBufferBank(device, width, height), loadSeed = new ExactAvsBufferSaveGpuPass(device, loadBank, operation(0, 4, 0, 128)), selectedLoad = new ExactAvsBufferSaveGpuPass(device, loadBank, operation(1, 4, blend, 77));
    await execute(device, loadSeed, width, height, saved);
    const expectedLoad = cpuBlend(saved, frame, width, height, blend, 77);
    await expect(device, selectedLoad, width, height, frame, expectedLoad, `blend ${blend} load`);
    exactPixels += pixels;
    loadBank.destroy();
  }
  const absentBank = new ExactAvsGpuBufferBank(device, width, height), absent = new ExactAvsBufferSaveGpuPass(device, absentBank, operation(1, 2, 0, 128));
  await expect(device, absent, width, height, frame, frame, "absent load no-op");
  exactPixels += pixels;
  absentBank.destroy();
  const evenBank = new ExactAvsGpuBufferBank(device, width, height), even = new ExactAvsBufferSaveGpuPass(device, evenBank, operation(2, 1, 0, 128));
  await expect(device, even, width, height, saved, saved, "even frame 0 store");
  await expect(device, even, width, height, frame, saved, "even frame 1 load");
  exactPixels += pixels * 2;
  evenBank.destroy();
  const oddBank = new ExactAvsGpuBufferBank(device, width, height), odd = new ExactAvsBufferSaveGpuPass(device, oddBank, operation(3, 1, 0, 128));
  await expect(device, odd, width, height, frame, frame, "odd frame 0 absent load");
  await expect(device, odd, width, height, saved, saved, "odd frame 1 store");
  await expect(device, odd, width, height, frame, saved, "odd frame 2 load");
  exactPixels += pixels * 3;
  oddBank.destroy();
  const benchWidth = 640, benchHeight = 360, benchSource = randomPixels(benchWidth * benchHeight, 2246822507), bytes = benchSource.byteLength, batchFrames = 30, bank = new ExactAvsGpuBufferBank(device, benchWidth, benchHeight), pass = new ExactAvsBufferSaveGpuPass(device, bank, operation(0, 0, 0, 128)), input = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }), output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(input, 0, benchSource);
  await submit(device, pass, benchWidth, benchHeight, input, output);
  const cpuSamples = [], gpuSamples = [], cpuBatchSamples = [], gpuBatchSamples = [];
  for (let sample = 0; sample < 9; sample++) {
    let started = performance.now();
    const cpuBuffer = new Uint32Array(benchSource.length);
    cpuBuffer.set(benchSource);
    cpuSamples.push(performance.now() - started);
    started = performance.now();
    await submit(device, pass, benchWidth, benchHeight, input, output);
    gpuSamples.push(performance.now() - started);
    started = performance.now();
    const resident = new Uint32Array(benchSource.length);
    for (let frameIndex = 0; frameIndex < batchFrames; frameIndex++) resident.set(benchSource);
    cpuBatchSamples.push((performance.now() - started) / batchFrames);
    const encoder = device.createCommandEncoder();
    started = performance.now();
    for (let frameIndex = 0; frameIndex < batchFrames; frameIndex++) pass.encode({ device, encoder, width: benchWidth, height: benchHeight, source: frameIndex & 1 ? output : input, target: frameIndex & 1 ? input : output });
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    gpuBatchSamples.push((performance.now() - started) / batchFrames);
  }
  input.destroy();
  output.destroy();
  bank.destroy();
  device.destroy();
  finish({ pass: true, adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }, width: benchWidth, height: benchHeight, exactPixels, cpuMedianMs: median(cpuSamples), gpuMedianMs: median(gpuSamples), speedup: median(cpuSamples) / median(gpuSamples), cpuBatchMedianMs: median(cpuBatchSamples), gpuResidentBatchMedianMs: median(gpuBatchSamples), residentBatchSpeedup: median(cpuBatchSamples) / median(gpuBatchSamples), batchFrames, globalBufferBytes: bytes, cpuSamples, gpuSamples, cpuBatchSamples, gpuBatchSamples });
}
async function expect(device, pass, width, height, source, expected, label) {
  const actual = await execute(device, pass, width, height, source);
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) throw new Error(`${label} pixel ${i}: ${actual[i].toString(16)} != ${expected[i].toString(16)}`);
}
async function execute(device, pass, width, height, pixels) {
  const bytes = pixels.byteLength, input = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }), output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }), read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  device.queue.writeBuffer(input, 0, pixels);
  const encoder = device.createCommandEncoder();
  pass.encode({ device, encoder, width, height, source: input, target: output });
  encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const result = new Uint32Array(new Uint32Array(read.getMappedRange()).slice());
  read.unmap();
  input.destroy();
  output.destroy();
  read.destroy();
  return result;
}
async function submit(device, pass, width, height, source, target) {
  const encoder = device.createCommandEncoder();
  pass.encode({ device, encoder, width, height, source, target });
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
}
function cpuBlend(source, destination, width, height, blend, amount) {
  const output = new AvsFramebuffer(width, height, new Uint32Array(destination)), input = new AvsFramebuffer(width, height, new Uint32Array(source)), modes = ["replace", "average", "additive", "every-other-pixel", "destination-minus-source", "every-other-line", "xor", "maximum", "minimum", "source-minus-destination", "multiply", "adjustable"];
  output.blendFrom(input, modes[blend], amount);
  return new Uint32Array(output.pixels);
}
function operation(direction, buffer, blend, amount) {
  const payload = new Uint8Array(16), view = new DataView(payload.buffer);
  view.setInt32(0, direction, true);
  view.setInt32(4, buffer, true);
  view.setInt32(8, blend, true);
  view.setInt32(12, amount, true);
  const component = { effectId: 18, apeId: null, payload, fileOffset: 0, path: `${direction}-${buffer}-${blend}`, children: [], list: null, listCode: null }, preset = { version: 2, header: "test", clearEveryFrame: false, components: [component], byteLength: 16 }, result = planAvsResidentSurfaces(preset).operations.find((value) => value.kind === "buffer-save");
  if (!result) throw new Error("Buffer Save plan missing");
  return result;
}
function randomPixels(count, seed) {
  let state = seed >>> 0, out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 16777215;
  }
  return out;
}
function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}
function finish(value) {
  document.querySelector("pre").textContent = JSON.stringify(value, null, 2);
  document.documentElement.dataset.done = "true";
}
