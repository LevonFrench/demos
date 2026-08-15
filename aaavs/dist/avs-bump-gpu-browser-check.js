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
var AVS_BLEND_TABLE = (() => {
  const values = new Uint8Array(256 * 256);
  for (let x = 0; x < 256; x++) {
    const row = x << 8;
    for (let y = 0; y < 256; y++) values[row | y] = Math.trunc(x / 255 * y);
  }
  return values;
})();
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

// src/avs/effects/bump-gpu.ts
var AVS_GPU_BUMP_CAPABILITY = {
  id: "classic-bump-packed-u32",
  backend: "webgpu",
  lane: "exact",
  byteExact: true,
  reason: "Uses separate resident packed-u32 surfaces, four-neighbor maximum-channel depth, and native integer lighting/blends."
};
function assessExactGpuBump(config, context) {
  if (!config.enabled) return { eligible: false, reason: "Bump is disabled" };
  if (!context.terminal) return { eligible: false, reason: "non-terminal Bump requires resident CPU/GPU EEL scheduling" };
  if (config.buffer !== 0) return { eligible: false, reason: "global depth buffers are not bound by this isolated pass" };
  return { eligible: true, reason: "terminal current-frame Bump has independent output pixels" };
}
function prepareExactAvsBumpGpuFrame(frame, width, height) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError("Bump dimensions must be positive integers");
  }
  if (!Number.isFinite(frame.currentDepth)) throw new RangeError("Bump current depth must be finite");
  if (!Number.isInteger(frame.lightX) || frame.lightX < 0 || frame.lightX > width) {
    throw new RangeError(`Bump lightX must be an integer in [0, ${width}]`);
  }
  if (!Number.isInteger(frame.lightY) || frame.lightY < 0 || frame.lightY > height) {
    throw new RangeError(`Bump lightY must be an integer in [0, ${height}]`);
  }
  const currentDepth = Math.trunc(frame.currentDepth);
  const scaledDepth = Math.trunc((currentDepth << 8) / 100);
  return new Int32Array([width, height, frame.lightX, frame.lightY, scaledDepth, 0, 0, 0]);
}
function renderExactAvsBumpCpu(source, width, height, config, frame) {
  const eligibility = assessExactGpuBump(config, { terminal: true });
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (source.length !== width * height) throw new RangeError("Bump source size does not match dimensions");
  const values = prepareExactAvsBumpGpuFrame(frame, width, height);
  const lightX = values[2], lightY = values[3], scaledDepth = values[4];
  const output = new Uint32Array(source.length);
  if (config.showLight && lightX < width && lightY < height) output[lightX + lightY * width] = 16777215;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const index = x + y * width;
    const left = source[index - 1], right = source[index + 1];
    const above = source[index - width], below = source[index + width];
    if (!(left || right || above || below)) continue;
    const horizontal = 127 - Math.abs(depthOf(right, config.invertDepth) - depthOf(left, config.invertDepth) - (x - lightX));
    const vertical = 127 - Math.abs(depthOf(below, config.invertDepth) - depthOf(above, config.invertDepth) - (y - lightY));
    const original = source[index];
    const lit = horizontal <= 0 || vertical <= 0 ? clamp254(original) : addLight(original, horizontal * vertical * scaledDepth >> 14);
    output[index] = config.additive ? blendPixel(lit, original, "additive") : config.average ? blendPixel(lit, original, "average") : lit;
  }
  return output;
}
var ExactAvsBumpGpuPass = class {
  constructor(device, config, width, height, context) {
    this.device = device;
    this.config = config;
    this.width = width;
    this.height = height;
    const eligibility = assessExactGpuBump(config, context);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || width > 16384 || height > 16384) {
      throw new RangeError("Bump dimensions must be integers in [1, 16384]");
    }
    this.params = device.createBuffer({
      label: "AVS exact Bump CPU-state uniform",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const module = device.createShaderModule({ label: "AVS exact Bump", code: buildExactAvsBumpWgsl(config) });
    this.pipeline = device.createComputePipeline({ label: "AVS exact Bump", layout: "auto", compute: { module, entryPoint: "main" } });
  }
  capability = AVS_GPU_BUMP_CAPABILITY;
  pipeline;
  params;
  groups = /* @__PURE__ */ new WeakMap();
  frameReady = false;
  updateFrame(frame) {
    const words = prepareExactAvsBumpGpuFrame(frame, this.width, this.height);
    this.device.queue.writeBuffer(this.params, 0, words.buffer, words.byteOffset, words.byteLength);
    this.frameReady = true;
  }
  encode(context) {
    this.encodeInternal(context);
  }
  encodeTimed(context, querySet, beginningOfPassWriteIndex, endOfPassWriteIndex) {
    this.encodeInternal(context, { querySet, beginningOfPassWriteIndex, endOfPassWriteIndex });
  }
  encodeInternal(context, timestampWrites) {
    if (!this.frameReady) throw new Error("Bump GPU frame state must be updated before encode");
    if (context.width !== this.width || context.height !== this.height) {
      throw new RangeError(`Bump pass is ${this.width}x${this.height}, got ${context.width}x${context.height}`);
    }
    if (context.source === context.target) throw new Error("Bump requires distinct source and target buffers");
    let targets = this.groups.get(context.source);
    if (!targets) {
      targets = /* @__PURE__ */ new WeakMap();
      this.groups.set(context.source, targets);
    }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: "AVS exact Bump buffers",
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } },
          { binding: 2, resource: { buffer: this.params } }
        ]
      });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: "AVS exact Bump", timestampWrites });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.width / 16), Math.ceil(this.height / 16));
    pass.end();
  }
  destroy() {
    this.params.destroy();
  }
};
function buildExactAvsBumpWgsl(config) {
  const eligibility = assessExactGpuBump(config, { terminal: true });
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  const showLight = config.showLight ? "true" : "false";
  const invertDepth = config.invertDepth ? "true" : "false";
  const blend = config.additive ? "result = additive(lit, original);" : config.average ? "result = average(lit, original);" : "result = lit;";
  return (
    /* wgsl */
    `
struct Params { width:u32, height:u32, light_x:i32, light_y:i32, scaled_depth:i32, pad0:i32, pad1:i32, pad2:i32 };
@group(0) @binding(0) var<storage,read> source_pixels:array<u32>;
@group(0) @binding(1) var<storage,read_write> destination_pixels:array<u32>;
@group(0) @binding(2) var<uniform> params:Params;

fn pack(b:u32,g:u32,r:u32)->u32{return b|(g<<8u)|(r<<16u);}
fn depth(pixel:u32)->i32{
  let value=max(pixel&255u,max((pixel>>8u)&255u,(pixel>>16u)&255u));
  return select(i32(value),255-i32(value),${invertDepth});
}
fn clamp254(pixel:u32)->u32{return pack(min(pixel&255u,254u),min((pixel>>8u)&255u,254u),min((pixel>>16u)&255u,254u));}
fn add_light(pixel:u32,amount:i32)->u32{
  let b=min(i32(pixel&255u)+amount,254);let g=min(i32((pixel>>8u)&255u)+amount,254);let r=min(i32((pixel>>16u)&255u)+amount,254);
  return bitcast<u32>(b)|(bitcast<u32>(g)<<8u)|(bitcast<u32>(r)<<16u);
}
fn additive(a:u32,b:u32)->u32{return pack(min(255u,(a&255u)+(b&255u)),min(255u,((a>>8u)&255u)+((b>>8u)&255u)),min(255u,((a>>16u)&255u)+((b>>16u)&255u)));}
fn average(a:u32,b:u32)->u32{return ((a>>1u)&0x007f7f7fu)+((b>>1u)&0x007f7f7fu);}

@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) id:vec3u){
  let x=id.x;let y=id.y;if(x>=params.width||y>=params.height){return;}let index=y*params.width+x;
  var result=select(0u,0x00ffffffu,${showLight}&&i32(x)==params.light_x&&i32(y)==params.light_y);
  if(x==0u||y==0u||x+1u==params.width||y+1u==params.height){destination_pixels[index]=result;return;}
  let left=source_pixels[index-1u];let right=source_pixels[index+1u];let above=source_pixels[index-params.width];let below=source_pixels[index+params.width];
  if((left|right|above|below)==0u){destination_pixels[index]=result;return;}
  let horizontal=127-abs(depth(right)-depth(left)-(i32(x)-params.light_x));
  let vertical=127-abs(depth(below)-depth(above)-(i32(y)-params.light_y));
  let original=source_pixels[index];
  let lit=select(add_light(original,(horizontal*vertical*params.scaled_depth)>>14u),clamp254(original),horizontal<=0||vertical<=0);
  ${blend}
  destination_pixels[index]=result;
}`
  );
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

// tools/avs-bump-gpu-browser-check.ts
void run().catch((error) => finish({ error: error instanceof Error ? error.stack : String(error) }));
async function run() {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const timestampQuery = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({ requiredFeatures: timestampQuery ? ["timestamp-query"] : [] });
  const fixtures = [
    { config: bumpConfig(), frame: { currentDepth: 100, lightX: 15, lightY: 9 } },
    { config: bumpConfig({ invertDepth: true }), frame: { currentDepth: 37, lightX: 0, lightY: 0 } },
    { config: bumpConfig({ showLight: true }), frame: { currentDepth: 140, lightX: 30, lightY: 18 } },
    { config: bumpConfig({ showLight: true }), frame: { currentDepth: 80, lightX: 31, lightY: 19 } },
    { config: bumpConfig({ additive: true }), frame: { currentDepth: 250, lightX: 7, lightY: 14 } },
    { config: bumpConfig({ average: true }), frame: { currentDepth: 0, lightX: 22, lightY: 4 } },
    { config: bumpConfig({ additive: true, average: true }), frame: { currentDepth: -30, lightX: 11, lightY: 8 } }
  ];
  let differentialPixels = 0;
  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index], source2 = deterministicPixels(31 * 19, 11255808 + index);
    source2.fill(0, 7 * 31 + 8, 7 * 31 + 13);
    await differential(device, source2, 31, 19, fixture.config, fixture.frame);
    differentialPixels += source2.length;
  }
  const width = 640, height = 360, source = deterministicPixels(width * height, 305441741);
  const config = bumpConfig({ showLight: true });
  const frame = { currentDepth: 100, lightX: 320, lightY: 180 };
  const pass = new ExactAvsBumpGpuPass(device, config, width, height, { terminal: true });
  const bytes = source.byteLength;
  const a = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const b = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  device.queue.writeBuffer(a, 0, source.buffer, source.byteOffset, source.byteLength);
  const cpuSamples = [], gpuWallSamples = [], encodeSubmitSamples = [], gpuKernelSamples = [];
  for (let sample = 0; sample < 17; sample++) {
    let started = performance.now();
    renderExactAvsBumpCpu(source, width, height, config, frame);
    cpuSamples.push(performance.now() - started);
    pass.updateFrame(frame);
    const encoder = device.createCommandEncoder();
    started = performance.now();
    pass.encode({ device, encoder, width, height, source: a, target: b });
    device.queue.submit([encoder.finish()]);
    encodeSubmitSamples.push(performance.now() - started);
    await device.queue.onSubmittedWorkDone();
    gpuWallSamples.push(performance.now() - started);
  }
  if (timestampQuery) for (let sample = 0; sample < 17; sample++) {
    const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    const resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    pass.updateFrame(frame);
    const encoder = device.createCommandEncoder();
    pass.encodeTimed({ device, encoder, width, height, source: a, target: b }, querySet, 0, 1);
    encoder.resolveQuerySet(querySet, 0, 2, resolve, 0);
    encoder.copyBufferToBuffer(resolve, 0, read, 0, 16);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = new BigUint64Array(read.getMappedRange());
    gpuKernelSamples.push(Number(values[1] - values[0]) / 1e6);
    read.unmap();
    querySet.destroy();
    resolve.destroy();
    read.destroy();
  }
  finish({
    pass: true,
    fixtures: fixtures.length,
    differentialPixels,
    width,
    height,
    timestampQuery,
    cpuMedianMs: median(cpuSamples.slice(2)),
    gpuWallMedianMs: median(gpuWallSamples.slice(2)),
    gpuEncodeSubmitMedianMs: median(encodeSubmitSamples.slice(2)),
    gpuKernelMedianMs: gpuKernelSamples.length ? median(gpuKernelSamples.slice(2)) : null,
    speedupVsCpu: median(cpuSamples.slice(2)) / median(gpuWallSamples.slice(2)),
    cpuSamples,
    gpuWallSamples,
    encodeSubmitSamples,
    gpuKernelSamples
  });
}
async function differential(device, source, width, height, config, frame) {
  const bytes = source.byteLength, a = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }), b = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pass = new ExactAvsBumpGpuPass(device, config, width, height, { terminal: true });
  pass.updateFrame(frame);
  device.queue.writeBuffer(a, 0, source.buffer, source.byteOffset, source.byteLength);
  const encoder = device.createCommandEncoder();
  pass.encode({ device, encoder, width, height, source: a, target: b });
  encoder.copyBufferToBuffer(b, 0, read, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const actual = new Uint32Array(read.getMappedRange()), expected = renderExactAvsBumpCpu(source, width, height, config, frame);
  for (let index = 0; index < actual.length; index++) if (actual[index] !== expected[index]) {
    throw new Error(`pixel ${index}: ${actual[index].toString(16)} != ${expected[index].toString(16)}`);
  }
  read.unmap();
  pass.destroy();
  a.destroy();
  b.destroy();
  read.destroy();
}
function bumpConfig(overrides = {}) {
  return {
    enabled: true,
    onBeat: false,
    beatDurationFrames: 15,
    depth: 100,
    beatDepth: 100,
    additive: false,
    average: false,
    frame: "",
    beat: "",
    init: "",
    showLight: false,
    invertDepth: false,
    oldStyle: false,
    buffer: 0,
    ...overrides
  };
}
function deterministicPixels(count, seed) {
  const result = new Uint32Array(count);
  let state = seed >>> 0;
  for (let index = 0; index < count; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 16777215;
  }
  return result;
}
function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}
function finish(value) {
  document.querySelector("pre").textContent = JSON.stringify(value, null, 2);
  document.documentElement.dataset.done = "true";
}
