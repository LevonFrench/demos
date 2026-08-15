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

// src/avs/effects/mirror-gpu.ts
var AVS_GPU_MIRROR_CAPABILITY = {
  id: "classic-mirror-ordered-packed-u32",
  backend: "webgpu",
  lane: "exact",
  byteExact: true,
  reason: "Expands native left/right then top/bottom in-place ordering into an equivalent independent packed-u32 expression."
};
function planExactAvsMirrorGpu(config, width, height, context) {
  const pixels = width * height;
  const base = { width, height, framebufferBytes: Number.isSafeInteger(pixels) ? pixels * 4 : 0, uniformBytes: 32 };
  const reject = (reason) => ({ eligible: false, reason, ...base });
  if (!config.enabled) return reject("Mirror is disabled");
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || width > 16384 || height > 16384) return reject("Mirror dimensions must be integers in [1, 16384]");
  if (!Number.isSafeInteger(pixels) || pixels > 1073741823) return reject("Mirror framebuffer size exceeds packed-u32 limits");
  if (!context.terminal) return reject("non-terminal Mirror requires resident state scheduling");
  if (context.mirrorInstances !== 1) return reject("native smooth state is shared across Mirror instances");
  if (config.randomOnBeat) return reject("beat-random Mirror mode remains CPU-owned");
  return { eligible: true, reason: null, ...base };
}
var ExactAvsMirrorCpuState = class {
  lastMode = 0;
  divisor = [0, 0, 0, 0];
  increment = [0, 0, 0, 0];
  frameCount = 0;
  next(config) {
    if (config.randomOnBeat) throw new Error("beat-random Mirror state requires the classic CPU random source");
    const mode = config.mode & 15;
    const difference = mode ^ this.lastMode;
    for (let index = 0; index < 4; index++) {
      const bit = 1 << index;
      if ((difference & bit) === 0) continue;
      const wasOn = (this.lastMode & bit) !== 0;
      this.increment[index] = wasOn ? -1 : 1;
      if (this.divisor[index] === 0) this.divisor[index] = wasOn ? 16 : 1;
    }
    this.lastMode = mode;
    const frame = { mode, smooth: config.smooth, divisor: [...this.divisor] };
    this.frameCount++;
    if (config.smooth && this.frameCount % Math.max(1, config.slower) === 0) {
      for (let index = 0; index < 4; index++) if (this.divisor[index] !== 0) {
        this.divisor[index] = (this.divisor[index] + this.increment[index] + 16) % 16;
      }
    }
    return frame;
  }
};
function prepareExactAvsMirrorGpuFrame(frame, width, height) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new RangeError("Mirror dimensions must be positive integers");
  if (!Number.isInteger(frame.mode) || frame.mode < 0 || frame.mode > 15) throw new RangeError("Mirror mode must be in [0, 15]");
  if (frame.divisor.length !== 4 || frame.divisor.some((value) => !Number.isInteger(value) || value < 0 || value > 15)) throw new RangeError("Mirror divisors must contain four integers in [0, 15]");
  return new Uint32Array([width, height, frame.mode, frame.smooth ? 1 : 0, ...frame.divisor]);
}
function renderExactAvsMirrorCpu(source, width, height, frame) {
  prepareExactAvsMirrorGpuFrame(frame, width, height);
  if (source.length !== width * height) throw new RangeError("Mirror source size does not match dimensions");
  const pixels = new Uint32Array(source), halfWidth = Math.trunc(width / 2), halfHeight = Math.trunc(height / 2);
  const direction = (bit, amount) => (frame.mode & bit) !== 0 || frame.smooth && amount !== 0;
  const copy = (target, sourceIndex, amount) => {
    pixels[target] = frame.smooth && amount ? adaptive(pixels[target], pixels[sourceIndex], amount) : pixels[sourceIndex];
  };
  if (direction(4, frame.divisor[2])) for (let y = 0; y < height; y++) for (let x = 0; x < halfWidth; x++) copy(y * width + width - 1 - x, y * width + x, frame.divisor[2]);
  if (direction(8, frame.divisor[3])) for (let y = 0; y < height; y++) for (let x = 0; x < halfWidth; x++) copy(y * width + x, y * width + width - 1 - x, frame.divisor[3]);
  if (direction(1, frame.divisor[0])) for (let y = 0; y < halfHeight; y++) for (let x = 0; x < width; x++) copy((height - 1 - y) * width + x, y * width + x, frame.divisor[0]);
  if (direction(2, frame.divisor[1])) for (let y = 0; y < halfHeight; y++) for (let x = 0; x < width; x++) copy(y * width + x, (height - 1 - y) * width + x, frame.divisor[1]);
  return pixels;
}
var ExactAvsMirrorGpuPass = class {
  constructor(device, plan) {
    this.device = device;
    this.plan = plan;
    if (!plan.eligible) throw new Error(`Ineligible Mirror GPU plan: ${plan.reason}`);
    this.params = device.createBuffer({ label: "AVS exact Mirror CPU-state uniform", size: plan.uniformBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: "AVS exact ordered Mirror", code: AVS_EXACT_MIRROR_WGSL });
    this.pipeline = device.createComputePipeline({ label: "AVS exact ordered Mirror", layout: "auto", compute: { module, entryPoint: "main" } });
  }
  capability = AVS_GPU_MIRROR_CAPABILITY;
  pipeline;
  params;
  groups = /* @__PURE__ */ new WeakMap();
  frameReady = false;
  updateFrame(frame) {
    const words = prepareExactAvsMirrorGpuFrame(frame, this.plan.width, this.plan.height);
    this.device.queue.writeBuffer(this.params, 0, words.buffer, words.byteOffset, words.byteLength);
    this.frameReady = true;
  }
  encode(context) {
    if (!this.frameReady) throw new Error("Mirror GPU frame state must be updated before encode");
    if (context.width !== this.plan.width || context.height !== this.plan.height) throw new RangeError(`Mirror pass is ${this.plan.width}x${this.plan.height}, got ${context.width}x${context.height}`);
    if (context.source === context.target) throw new Error("Mirror requires distinct source and target buffers");
    let targets = this.groups.get(context.source);
    if (!targets) {
      targets = /* @__PURE__ */ new WeakMap();
      this.groups.set(context.source, targets);
    }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({ label: "AVS exact Mirror buffers", layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: context.source } },
        { binding: 1, resource: { buffer: context.target } },
        { binding: 2, resource: { buffer: this.params } }
      ] });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: "AVS exact ordered Mirror" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.plan.width / 16), Math.ceil(this.plan.height / 16));
    pass.end();
  }
  destroy() {
    this.params.destroy();
  }
};
var AVS_EXACT_MIRROR_WGSL = (
  /* wgsl */
  `
struct Params { width:u32, height:u32, mode:u32, smooth:u32, d0:u32, d1:u32, d2:u32, d3:u32 };
@group(0) @binding(0) var<storage,read> source_pixels:array<u32>;
@group(0) @binding(1) var<storage,read_write> destination_pixels:array<u32>;
@group(0) @binding(2) var<uniform> params:Params;
fn pack(b:u32,g:u32,r:u32)->u32{return (b&255u)|((g&255u)<<8u)|((r&255u)<<16u);}
fn adaptive(current:u32,target:u32,amount:u32)->u32{
  let inverse=16u-amount;
  return pack((((current&255u)>>4u)*inverse+((target&255u)>>4u)*amount)&255u,
    ((((current>>8u)&255u)>>4u)*inverse+(((target>>8u)&255u)>>4u)*amount)&255u,
    ((((current>>16u)&255u)>>4u)*inverse+(((target>>16u)&255u)>>4u)*amount)&255u);
}
fn apply_direction(current:u32,target:u32,active:bool,amount:u32)->u32{
  if(!active){return current;}if(params.smooth!=0u&&amount!=0u){return adaptive(current,target,amount);}return target;
}
fn original(x:u32,y:u32)->u32{return source_pixels[y*params.width+x];}
fn horizontal(x:u32,y:u32)->u32{
  let half=params.width/2u;let mirrored=params.width-1u-x;var value=original(x,y);
  let left_to_right=(params.mode&4u)!=0u||(params.smooth!=0u&&params.d2!=0u);
  let right_to_left=(params.mode&8u)!=0u||(params.smooth!=0u&&params.d3!=0u);
  if(x>=params.width-half&&mirrored<half){value=apply_direction(value,original(mirrored,y),left_to_right,params.d2);}
  if(x<half){
    let right_original=original(mirrored,y);
    let right_after=apply_direction(right_original,original(x,y),left_to_right,params.d2);
    value=apply_direction(value,right_after,right_to_left,params.d3);
  }
  return value;
}
fn after_top_to_bottom(x:u32,y:u32)->u32{
  let half=params.height/2u;let mirrored=params.height-1u-y;var value=horizontal(x,y);
  let active=(params.mode&1u)!=0u||(params.smooth!=0u&&params.d0!=0u);
  if(y>=params.height-half&&mirrored<half){value=apply_direction(value,horizontal(x,mirrored),active,params.d0);}return value;
}
@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) id:vec3u){
  let x=id.x;let y=id.y;if(x>=params.width||y>=params.height){return;}let half=params.height/2u;let mirrored=params.height-1u-y;
  var value=after_top_to_bottom(x,y);let active=(params.mode&2u)!=0u||(params.smooth!=0u&&params.d1!=0u);
  if(y<half){value=apply_direction(value,after_top_to_bottom(x,mirrored),active,params.d1);}
  destination_pixels[y*params.width+x]=value;
}`
);
function adaptive(current, target, divisor) {
  const channel = (shift) => ((current >>> shift & 255) >>> 4) * (16 - divisor) + ((target >>> shift & 255) >>> 4) * divisor & 255;
  return channel(0) | channel(8) << 8 | channel(16) << 16;
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

// tools/avs-mirror-gpu-browser-check.ts
void run().catch((error) => finish({ error: error instanceof Error ? error.stack : String(error) }));
async function run() {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  let frames = 0, pixels = 0;
  for (const [width, height] of [[17, 11], [18, 12]]) for (const mode of [0, 1, 2, 4, 5, 8, 10, 15]) {
    const config2 = mirrorConfig({ mode }), state2 = new ExactAvsMirrorCpuState();
    await differential(device, deterministicPixels(width * height, mode + width * 99), width, height, config2, state2.next(config2));
    frames++;
    pixels += width * height;
  }
  const config = mirrorConfig({ mode: 5, smooth: true, slower: 2 }), state = new ExactAvsMirrorCpuState();
  for (let index = 0; index < 18; index++) {
    await differential(device, deterministicPixels(19 * 13, 36864 + index), 19, 13, config, state.next(config));
    frames++;
    pixels += 19 * 13;
  }
  finish({ pass: true, frames, pixels });
}
async function differential(device, source, width, height, config, frame) {
  const plan = planExactAvsMirrorGpu(config, width, height, { terminal: true, mirrorInstances: 1 });
  if (!plan.eligible) throw new Error(plan.reason);
  const pass = new ExactAvsMirrorGpuPass(device, plan);
  pass.updateFrame(frame);
  const bytes = source.byteLength, a = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }), b = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }), read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  device.queue.writeBuffer(a, 0, source.buffer, source.byteOffset, source.byteLength);
  const encoder = device.createCommandEncoder();
  pass.encode({ device, encoder, width, height, source: a, target: b });
  encoder.copyBufferToBuffer(b, 0, read, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const actual = new Uint32Array(read.getMappedRange()), expected = renderExactAvsMirrorCpu(source, width, height, frame);
  for (let index = 0; index < actual.length; index++) if (actual[index] !== expected[index]) throw new Error(`pixel ${index}: ${actual[index].toString(16)} != ${expected[index].toString(16)}`);
  read.unmap();
  pass.destroy();
  a.destroy();
  b.destroy();
  read.destroy();
}
function mirrorConfig(overrides = {}) {
  return { enabled: true, mode: 5, randomOnBeat: false, smooth: false, slower: 4, ...overrides };
}
function deterministicPixels(count, seed) {
  const output = new Uint32Array(count);
  let state = seed >>> 0;
  for (let index = 0; index < count; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = state >>> 0;
  }
  return output;
}
function finish(value) {
  document.querySelector("pre").textContent = JSON.stringify(value, null, 2);
  document.documentElement.dataset.done = "true";
}
