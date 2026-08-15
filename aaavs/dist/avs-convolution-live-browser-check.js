// src/avs-worker-client.ts
var AVS_PCM_SAMPLES = 576;
var SingleFrameGate = class {
  pending = false;
  get busy() {
    return this.pending;
  }
  tryBegin() {
    if (this.pending) return false;
    this.pending = true;
    return true;
  }
  finish() {
    this.pending = false;
  }
};
function fillAvsPcm(waveform, pcm) {
  if (pcm.length !== AVS_PCM_SAMPLES * 2) {
    throw new RangeError(`AVS PCM buffer must contain ${AVS_PCM_SAMPLES * 2} samples`);
  }
  const frames = Math.max(1, Math.trunc(waveform.length / 2));
  for (let i = 0; i < AVS_PCM_SAMPLES; i++) {
    const source = Math.min(frames - 1, Math.trunc(i * frames / AVS_PCM_SAMPLES));
    const left = waveform[source * 2] ?? 0;
    pcm[i] = left;
    pcm[AVS_PCM_SAMPLES + i] = waveform[source * 2 + 1] ?? left;
  }
}
var AvsWorkerRenderer = class {
  worker;
  canvas;
  context;
  onFrame;
  gate = new SingleFrameGate();
  generation = 0;
  sequence = 0;
  pcm = new Float32Array(AVS_PCM_SAMPLES * 2);
  loadResolve = null;
  loadReject = null;
  loaded = false;
  disposed = false;
  emaMs = 0;
  controlRevision = 0;
  pendingControls = [];
  gpuLane;
  preset = null;
  unsupported = 0;
  lastRenderMs = 0;
  lastPresentMs = 0;
  lastEffectMs = 0;
  lastUploadMs = 0;
  lastEncodeSubmitMs = 0;
  presenter = "cpu-image-data";
  gpuEffectPasses = 0;
  gpuEffectComponents = 0;
  gpuFusedPointwiseOperations = 0;
  gpuEffectPlan = "exact CPU fallback";
  gpuEnhancedSuperScope = false;
  static supported() {
    return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
  }
  constructor(options) {
    this.canvas = options.canvas;
    this.context = options.context;
    this.onFrame = options.onFrame;
    this.gpuLane = options.gpuLane ?? "exact";
    this.worker = options.createWorker?.() ?? new Worker(new URL("./avs-render.worker.js", import.meta.url), { type: "module", name: "aaavs-compat-renderer" });
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = (event) => {
      this.failLoad(new Error(event.message || "AVS render worker failed"));
      this.gate.finish();
    };
  }
  get active() {
    return this.loaded && !this.disposed;
  }
  get busy() {
    return this.gate.busy;
  }
  get averageRenderMs() {
    return this.emaMs;
  }
  load(bytes, width, height) {
    if (this.disposed) return Promise.reject(new Error("AVS render worker has been disposed"));
    this.clear();
    const generation = this.generation;
    const preset2 = new Uint8Array(bytes).buffer;
    return new Promise((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
      this.worker.postMessage({ type: "load", generation, preset: preset2, width, height, gpuLane: this.gpuLane }, [preset2]);
    });
  }
  /** Replace controls on the actual parsed worker graph. Safe before load completes. */
  setControls(controls) {
    if (this.disposed) return;
    this.pendingControls = controls.map((control) => ({ ...control }));
    if (!this.loaded) return;
    this.worker.postMessage({
      type: "controls",
      generation: this.generation,
      revision: ++this.controlRevision,
      controls: this.pendingControls
    });
  }
  setComponentControl(path, patch) {
    const current = this.pendingControls.find((control) => control.path === path) ?? { path };
    this.setControls([
      ...this.pendingControls.filter((control) => control.path !== path),
      { ...current, ...patch, path }
    ]);
  }
  /** Dispatches at most one frame. False means an existing frame is still running. */
  render(audio, width, height) {
    if (!this.active || !this.gate.tryBegin()) return false;
    fillAvsPcm(audio.waveform, this.pcm);
    const pcm = this.pcm.buffer;
    this.worker.postMessage({
      type: "render",
      generation: this.generation,
      sequence: ++this.sequence,
      pcm,
      width,
      height
    }, [pcm]);
    return true;
  }
  clear() {
    if (this.disposed) return;
    this.failLoad(new Error("AVS preset load superseded"));
    this.generation++;
    this.loaded = false;
    this.preset = null;
    this.pendingControls = [];
    this.gate.finish();
    this.worker.postMessage({ type: "clear", generation: this.generation });
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.worker.terminate();
  }
  receive(message) {
    if (message.type === "frame") {
      this.pcm = new Float32Array(message.pcm);
      this.gate.finish();
      if (message.generation !== this.generation || !this.loaded) {
        message.bitmap.close();
        return;
      }
      const started = performance.now();
      if (this.canvas.width !== message.width || this.canvas.height !== message.height) {
        this.canvas.width = message.width;
        this.canvas.height = message.height;
      }
      this.context.drawImage(message.bitmap, 0, 0);
      message.bitmap.close();
      this.lastPresentMs = performance.now() - started;
      this.lastRenderMs = message.renderMs;
      this.lastEffectMs = message.effectMs ?? message.renderMs;
      this.lastUploadMs = message.uploadMs ?? 0;
      this.lastEncodeSubmitMs = message.encodeSubmitMs ?? 0;
      this.presenter = message.presenter ?? "cpu-image-data";
      this.gpuEffectPasses = message.gpuEffectPasses ?? 0;
      this.gpuEffectComponents = message.gpuEffectComponents ?? 0;
      this.gpuFusedPointwiseOperations = message.gpuFusedPointwiseOperations ?? 0;
      this.gpuEffectPlan = message.gpuEffectPlan ?? "exact CPU fallback";
      this.gpuEnhancedSuperScope = message.gpuEnhancedSuperScope ?? false;
      this.emaMs = this.emaMs === 0 ? message.renderMs : this.emaMs * 0.85 + message.renderMs * 0.15;
      this.unsupported = message.unsupported;
      this.onFrame?.();
      return;
    }
    if (message.generation !== this.generation) return;
    if (message.type === "ready") {
      this.loaded = true;
      this.unsupported = message.unsupported;
      this.preset = message.preset;
      if (this.pendingControls.length) {
        this.worker.postMessage({
          type: "controls",
          generation: this.generation,
          revision: ++this.controlRevision,
          controls: this.pendingControls
        });
      }
      this.loadResolve?.();
      this.loadResolve = null;
      this.loadReject = null;
      return;
    }
    if (message.type === "controls-applied") return;
    const error = new Error(message.message);
    this.failLoad(error);
    this.gate.finish();
  }
  failLoad(error) {
    this.loadReject?.(error);
    this.loadResolve = null;
    this.loadReject = null;
  }
};

// tools/avs-convolution-live-browser-check.ts
var preset = "/avs%20presets/presets/unique/5acdfe9cebc9873b--f2%20avs-king%20-%20made%20with%20real%20pimps%20(nemo%20mix).avs";
void run().catch((error) => finish({ error: error instanceof Error ? error.stack : String(error) }));
async function run() {
  const response = await fetch(preset);
  if (!response.ok) throw new Error(`fetch ${response.status}`);
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D unavailable");
  let done;
  const frame = new Promise((resolve) => done = resolve);
  const renderer = new AvsWorkerRenderer({ canvas, context, gpuLane: "exact", onFrame: done });
  await renderer.load(new Uint8Array(await response.arrayBuffer()), 640, 360);
  const waveform = new Float32Array(2048);
  for (let i = 0; i < waveform.length; i++) waveform[i] = Math.sin(i * 0.071);
  if (!renderer.render({ waveform }, 640, 360)) throw new Error("frame rejected");
  await Promise.race([frame, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3e4))]);
  const result = { presenter: renderer.presenter, gpuEffectComponents: renderer.gpuEffectComponents, gpuEffectPasses: renderer.gpuEffectPasses, gpuEffectPlan: renderer.gpuEffectPlan, renderMs: renderer.lastRenderMs, effectMs: renderer.lastEffectMs, uploadMs: renderer.lastUploadMs, encodeSubmitMs: renderer.lastEncodeSubmitMs };
  renderer.dispose();
  if (result.presenter !== "webgpu-exact" || !result.gpuEffectPlan.includes("2 exact Holden03 convolutions") || !result.gpuEffectPlan.includes("1 pointwise operation fused into final convolution") || result.gpuEffectComponents !== 3 || result.gpuEffectPasses !== 2) throw new Error(`live convolution fusion inactive ${JSON.stringify(result)}`);
  finish({ pass: true, preset, ...result });
}
function finish(value) {
  document.querySelector("pre").textContent = JSON.stringify(value, null, 2);
  document.documentElement.dataset.done = "true";
}
