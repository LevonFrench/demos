// src/avs/gpu-ordered-draw.ts
var DEFAULT_BUDGET = 64 * 1024 * 1024;
var DEFAULT_TILE_SIZES = [16, 32, 64];
var DEFAULT_MAX_RECORDS = 4 * 128 * 1024;
function planAvsOrderedTileBinning(width, height, recordCapacity, options = {}) {
  const budget = options.memoryBudgetBytes ?? DEFAULT_BUDGET;
  const sizes = options.tileSizes ?? DEFAULT_TILE_SIZES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxWorkgroups = options.maxComputeWorkgroupsPerDimension ?? 65535;
  const reject = (reason) => makePlan(false, reason, width, height, recordCapacity, 0);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return reject("invalid-frame-size");
  if (width > 2147483647 || height > 2147483647) return reject("wgsl-i32-frame-limit");
  if (!Number.isSafeInteger(recordCapacity) || recordCapacity < 0) return reject("invalid-record-capacity");
  if (recordCapacity > maxRecords) return reject("record-capacity-limit");
  if (!Number.isSafeInteger(budget) || budget <= 0) return reject("invalid-memory-budget");
  if (!Number.isSafeInteger(maxWorkgroups) || maxWorkgroups <= 0) return reject("invalid-dispatch-limit");
  const candidates = [...new Set(sizes)].filter((size) => Number.isInteger(size) && size > 0).sort((a, b) => a - b);
  if (candidates.length === 0) return reject("no-tile-size");
  let memoryFit = false;
  for (const tileSize of candidates) {
    const plan = makePlan(true, null, width, height, recordCapacity, tileSize);
    if (plan.membershipBytes > budget) continue;
    memoryFit = true;
    if (plan.clearDispatchX <= maxWorkgroups && plan.binDispatchX <= maxWorkgroups && plan.rasterDispatchX <= maxWorkgroups && plan.rasterDispatchY <= maxWorkgroups) return plan;
  }
  return reject(memoryFit ? "dispatch-limit" : "membership-memory-budget");
}
function makePlan(eligible, reason, width, height, recordCapacity, tileSize) {
  const tilesX = tileSize > 0 && width > 0 ? Math.ceil(width / tileSize) : 0;
  const tilesY = tileSize > 0 && height > 0 ? Math.ceil(height / tileSize) : 0;
  const tileCount = tilesX * tilesY;
  const wordsPerTile = Math.ceil(Math.max(0, recordCapacity) / 32);
  const membershipWords = tileCount * wordsPerTile;
  return {
    eligible,
    reason,
    width,
    height,
    recordCapacity,
    tileSize,
    tilesX,
    tilesY,
    tileCount,
    wordsPerTile,
    membershipWords,
    membershipBytes: membershipWords * 4,
    clearDispatchX: Math.ceil(membershipWords / 256),
    binDispatchX: Math.ceil(Math.max(0, recordCapacity) / 256),
    rasterDispatchX: tilesX,
    rasterDispatchY: tilesY,
    passes: ["clear-membership", "bin-records", "ordered-raster"]
  };
}

// src/avs/texer-ordered-gpu.ts
var AVS_EXACT_ORDERED_TEXER_GPU_CAPABILITY = {
  id: "exact-ordered-texer-fixed-v1",
  backend: "webgpu",
  lane: "exact",
  byteExact: true,
  reason: "Fixed bitmap Texer records are binned by stable source-order bits and replayed per pixel with packed integer AVS blends."
};
function planExactAvsTexerGpu(width, height, bitmap, maxRecords, memoryBudgetBytes = 64 * 1024 * 1024) {
  const tilePlan = planAvsOrderedTileBinning(width, height, maxRecords, {
    memoryBudgetBytes,
    // The raster kernel maps one 16x16 workgroup to one membership tile.
    tileSizes: [16]
  });
  const scanGroupCount = Math.ceil(tilePlan.tileCount / 256);
  const maxTilesX = tilePlan.tileSize > 0 ? Math.min(tilePlan.tilesX, Math.ceil((bitmap.width + tilePlan.tileSize - 1) / tilePlan.tileSize)) : 0;
  const maxTilesY = tilePlan.tileSize > 0 ? Math.min(tilePlan.tilesY, Math.ceil((bitmap.height + tilePlan.tileSize - 1) / tilePlan.tileSize)) : 0;
  const maxTilesPerRecord = maxTilesX * maxTilesY;
  const compactIndexCapacity = maxRecords * maxTilesPerRecord;
  const compactBytes = compactIndexCapacity * 4;
  const residentSchedulingBytes = tilePlan.membershipBytes + compactBytes + (tilePlan.tileCount + 1 + scanGroupCount * 2) * 4;
  const base = { width, height, maxRecords, tilePlan, scanGroupCount, maxTilesPerRecord, compactIndexCapacity, compactBytes, residentSchedulingBytes };
  const reject = (reason) => ({ eligible: false, reason, ...base });
  if (!tilePlan.eligible) return reject(tilePlan.reason ?? "tile-plan");
  if (!Number.isInteger(bitmap.width) || !Number.isInteger(bitmap.height) || bitmap.width <= 1 || bitmap.height <= 1) return reject("bitmap-dimensions");
  if (bitmap.pixels.length !== bitmap.width * bitmap.height) return reject("bitmap-pixel-count");
  if (bitmap.width > 4096 || bitmap.height > 4096) return reject("bitmap-size-limit");
  if (scanGroupCount > 256) return reject("scan-group-limit");
  if (!Number.isSafeInteger(compactIndexCapacity) || compactIndexCapacity > 4294967295) return reject("compact-index-limit");
  if (residentSchedulingBytes > memoryBudgetBytes) return reject("resident-scheduling-memory-budget");
  return { eligible: true, reason: null, ...base };
}
function buildExactAvsTexerRecord(bitmap, centreX, centreY, mask) {
  const left = centreX - Math.trunc(bitmap.width / 2);
  const top = centreY - Math.trunc(bitmap.height / 2);
  return {
    left,
    top,
    right: left + bitmap.width - 1,
    bottom: top + bitmap.height - 1,
    textureX: 0,
    textureY: 0,
    color: mask ?? 16777215,
    flipX: false,
    flipY: false,
    colorize: mask !== null
  };
}
var ExactAvsOrderedTexerGpuPass = class {
  constructor(device, plan, bitmap) {
    this.device = device;
    this.plan = plan;
    if (!plan.eligible) throw new Error(`Ineligible Texer GPU plan: ${plan.reason}`);
    const module = device.createShaderModule({ label: "AVS exact ordered Texer", code: AVS_EXACT_ORDERED_TEXER_WGSL });
    const bindGroupLayout = device.createBindGroupLayout({ label: "AVS Texer shared layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    const pipelineLayout = device.createPipelineLayout({ label: "AVS Texer pipeline layout", bindGroupLayouts: [bindGroupLayout] });
    this.clearPipeline = device.createComputePipeline({ label: "AVS Texer clear membership", layout: pipelineLayout, compute: { module, entryPoint: "clear_membership" } });
    this.binPipeline = device.createComputePipeline({ label: "AVS Texer bin records", layout: pipelineLayout, compute: { module, entryPoint: "bin_records" } });
    this.countScanPipeline = device.createComputePipeline({ label: "AVS Texer tile count scan", layout: pipelineLayout, compute: { module, entryPoint: "scan_tile_counts" } });
    this.groupScanPipeline = device.createComputePipeline({ label: "AVS Texer group scan", layout: pipelineLayout, compute: { module, entryPoint: "scan_group_totals" } });
    this.addOffsetsPipeline = device.createComputePipeline({ label: "AVS Texer add group offsets", layout: pipelineLayout, compute: { module, entryPoint: "add_group_offsets" } });
    this.compactPipeline = device.createComputePipeline({ label: "AVS Texer stable compact", layout: pipelineLayout, compute: { module, entryPoint: "compact_tiles" } });
    this.rasterPipeline = device.createComputePipeline({ label: "AVS Texer ordered raster", layout: pipelineLayout, compute: { module, entryPoint: "raster_texer" } });
    this.records = device.createBuffer({ label: "AVS Texer records", size: Math.max(32, plan.maxRecords * 32), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.membership = device.createBuffer({ label: "AVS Texer membership", size: Math.max(4, plan.tilePlan.membershipBytes), usage: GPUBufferUsage.STORAGE });
    this.bitmap = device.createBuffer({ label: "AVS Texer bitmap", size: bitmap.pixels.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ label: "AVS Texer params", size: this.paramsWords.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.tileOffsets = device.createBuffer({ label: "AVS Texer tile offsets", size: (plan.tilePlan.tileCount + 1) * 4, usage: GPUBufferUsage.STORAGE });
    this.groupScan = device.createBuffer({ label: "AVS Texer scan group totals and offsets", size: Math.max(8, plan.scanGroupCount * 8), usage: GPUBufferUsage.STORAGE });
    this.compactIndices = device.createBuffer({ label: "AVS Texer compact indices", size: Math.max(4, plan.compactBytes), usage: GPUBufferUsage.STORAGE });
    this.packedRecords = new ArrayBuffer(Math.max(32, plan.maxRecords * 32));
    device.queue.writeBuffer(this.bitmap, 0, bitmap.pixels.buffer, bitmap.pixels.byteOffset, bitmap.pixels.byteLength);
    this.paramsWords.set([
      plan.width,
      plan.height,
      0,
      16,
      plan.tilePlan.tilesX,
      plan.tilePlan.tilesY,
      plan.tilePlan.wordsPerTile,
      plan.tilePlan.membershipWords,
      bitmap.width,
      bitmap.height,
      0,
      0
    ]);
  }
  capability = AVS_EXACT_ORDERED_TEXER_GPU_CAPABILITY;
  clearPipeline;
  binPipeline;
  countScanPipeline;
  groupScanPipeline;
  addOffsetsPipeline;
  compactPipeline;
  rasterPipeline;
  records;
  membership;
  bitmap;
  params;
  tileOffsets;
  groupScan;
  compactIndices;
  packedRecords;
  paramsWords = new Uint32Array(12);
  groups = /* @__PURE__ */ new WeakMap();
  recordCount = 0;
  destroyed = false;
  update(frame) {
    this.assertAlive();
    if (frame.records.length > this.plan.maxRecords) throw new RangeError("Texer record count exceeds planned capacity");
    if (!Number.isInteger(frame.blendMode) || frame.blendMode < 0 || frame.blendMode > 9) throw new RangeError("Unsupported Texer blend mode");
    const ints = new Int32Array(this.packedRecords);
    const uints = new Uint32Array(this.packedRecords);
    for (let index = 0; index < frame.records.length; index++) {
      const record = frame.records[index], offset = index * 8;
      const minTileX = Math.floor(Math.max(0, record.left) / 16), minTileY = Math.floor(Math.max(0, record.top) / 16);
      const maxTileX = Math.floor(Math.min(this.plan.width - 1, record.right) / 16), maxTileY = Math.floor(Math.min(this.plan.height - 1, record.bottom) / 16);
      const tileSpan = maxTileX >= minTileX && maxTileY >= minTileY ? (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1) : 0;
      if (tileSpan > this.plan.maxTilesPerRecord) throw new RangeError("Texer record bounds exceed planned fixed-bitmap tile span");
      ints[offset] = record.left;
      ints[offset + 1] = record.top;
      ints[offset + 2] = record.right;
      ints[offset + 3] = record.bottom;
      ints[offset + 4] = record.textureX;
      ints[offset + 5] = record.textureY;
      uints[offset + 6] = record.color >>> 0;
      uints[offset + 7] = (record.flipX ? 1 : 0) | (record.flipY ? 2 : 0) | (record.colorize ? 4 : 0);
    }
    const bytes = frame.records.length * 32;
    if (bytes > 0) this.device.queue.writeBuffer(this.records, 0, this.packedRecords, 0, bytes);
    this.recordCount = frame.records.length;
    this.paramsWords[2] = this.recordCount;
    this.paramsWords[10] = frame.blendMode;
    this.paramsWords[11] = (clamp(frame.adjustableAlpha, 0, 255) | (frame.clearInput ? 256 : 0)) >>> 0;
    this.device.queue.writeBuffer(this.params, 0, this.paramsWords.buffer);
  }
  encode(context) {
    this.encodePasses(context);
  }
  /** Seven passes, two timestamp slots each. Returns the next free query index. */
  encodeTimed(context, querySet, firstQuery = 0) {
    this.encodePasses(context, querySet, firstQuery);
    return firstQuery + 14;
  }
  encodePasses(context, querySet, firstQuery = 0) {
    this.assertAlive();
    if (context.width !== this.plan.width || context.height !== this.plan.height) throw new Error("Texer GPU pass/frame size mismatch");
    const group = this.bindGroup(context.source, context.target);
    let query = firstQuery;
    const descriptor = (label) => ({ label, ...querySet ? { timestampWrites: { querySet, beginningOfPassWriteIndex: query++, endOfPassWriteIndex: query++ } } : {} });
    let pass = context.encoder.beginComputePass(descriptor("AVS Texer clear membership"));
    pass.setPipeline(this.clearPipeline);
    pass.setBindGroup(0, group);
    if (this.plan.tilePlan.clearDispatchX > 0) pass.dispatchWorkgroups(this.plan.tilePlan.clearDispatchX);
    pass.end();
    pass = context.encoder.beginComputePass(descriptor("AVS Texer stable bin records"));
    pass.setPipeline(this.binPipeline);
    pass.setBindGroup(0, group);
    if (this.recordCount > 0) pass.dispatchWorkgroups(Math.ceil(this.recordCount / 256));
    pass.end();
    pass = context.encoder.beginComputePass(descriptor("AVS Texer scan tile counts"));
    pass.setPipeline(this.countScanPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(this.plan.scanGroupCount);
    pass.end();
    pass = context.encoder.beginComputePass(descriptor("AVS Texer scan group totals"));
    pass.setPipeline(this.groupScanPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    pass = context.encoder.beginComputePass(descriptor("AVS Texer add group offsets"));
    pass.setPipeline(this.addOffsetsPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.plan.tilePlan.tileCount / 256));
    pass.end();
    pass = context.encoder.beginComputePass(descriptor("AVS Texer compact tile indices"));
    pass.setPipeline(this.compactPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.plan.tilePlan.tileCount / 64));
    pass.end();
    pass = context.encoder.beginComputePass(descriptor("AVS Texer ordered raster"));
    pass.setPipeline(this.rasterPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(this.plan.tilePlan.tilesX, this.plan.tilePlan.tilesY);
    pass.end();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.records.destroy();
    this.membership.destroy();
    this.bitmap.destroy();
    this.params.destroy();
    this.tileOffsets.destroy();
    this.groupScan.destroy();
    this.compactIndices.destroy();
  }
  bindGroup(source, target) {
    let targets = this.groups.get(source);
    if (!targets) {
      targets = /* @__PURE__ */ new WeakMap();
      this.groups.set(source, targets);
    }
    let group = targets.get(target);
    if (!group) {
      group = this.device.createBindGroup({ label: "AVS Texer ordered resources", layout: this.rasterPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.records } },
        { binding: 1, resource: { buffer: this.membership } },
        { binding: 2, resource: { buffer: this.params } },
        { binding: 3, resource: { buffer: this.bitmap } },
        { binding: 4, resource: { buffer: source } },
        { binding: 5, resource: { buffer: target } },
        { binding: 6, resource: { buffer: this.tileOffsets } },
        { binding: 7, resource: { buffer: this.groupScan } },
        { binding: 8, resource: { buffer: this.compactIndices } }
      ] });
      targets.set(target, group);
    }
    return group;
  }
  assertAlive() {
    if (this.destroyed) throw new Error("Texer GPU pass is destroyed");
  }
};
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
var AVS_EXACT_ORDERED_TEXER_WGSL = (
  /* wgsl */
  `
struct DrawRecord { left:i32, top:i32, right:i32, bottom:i32, texture_x:i32, texture_y:i32, color:u32, flags:u32 };
struct Records { values:array<DrawRecord> }; struct Membership { values:array<atomic<u32>> }; struct Bitmap { pixels:array<u32> };
struct Frame { pixels:array<u32> }; struct Words { values:array<u32> };
struct Params { width:u32, height:u32, record_count:u32, tile_size:u32, tiles_x:u32, tiles_y:u32, words_per_tile:u32, membership_words:u32, bitmap_width:u32, bitmap_height:u32, blend_mode:u32, alpha_flags:u32 };
@group(0) @binding(0) var<storage,read> records:Records; @group(0) @binding(1) var<storage,read_write> membership:Membership;
@group(0) @binding(2) var<uniform> params:Params; @group(0) @binding(3) var<storage,read> bitmap:Bitmap;
@group(0) @binding(4) var<storage,read> source:Frame; @group(0) @binding(5) var<storage,read_write> destination:Frame;
@group(0) @binding(6) var<storage,read_write> tile_offsets:Words; @group(0) @binding(7) var<storage,read_write> group_scan:Words;
@group(0) @binding(8) var<storage,read_write> compact_indices:Words;
var<workgroup> scan_scratch:array<u32,256>;
@compute @workgroup_size(256) fn clear_membership(@builtin(global_invocation_id) id:vec3u){if(id.x<params.membership_words){atomicStore(&membership.values[id.x],0u);}}
@compute @workgroup_size(256) fn bin_records(@builtin(global_invocation_id) id:vec3u){let i=id.x;if(i>=params.record_count){return;}let r=records.values[i];if(r.right<0||r.bottom<0||r.left>=i32(params.width)||r.top>=i32(params.height)){return;}let x0=u32(max(0,r.left))/params.tile_size;let y0=u32(max(0,r.top))/params.tile_size;let x1=u32(min(i32(params.width)-1,r.right))/params.tile_size;let y1=u32(min(i32(params.height)-1,r.bottom))/params.tile_size;for(var ty=y0;ty<=y1;ty++){for(var tx=x0;tx<=x1;tx++){atomicOr(&membership.values[(ty*params.tiles_x+tx)*params.words_per_tile+(i>>5u)],1u<<(i&31u));}}}
@compute @workgroup_size(256) fn scan_tile_counts(@builtin(local_invocation_index) lid:u32,@builtin(workgroup_id) group:vec3u){let tile_count=params.tiles_x*params.tiles_y;let tile=group.x*256u+lid;var count=0u;if(tile<tile_count){let base=tile*params.words_per_tile;for(var w=0u;w<params.words_per_tile;w++){count+=countOneBits(atomicLoad(&membership.values[base+w]));}}scan_scratch[lid]=count;workgroupBarrier();for(var step=1u;step<256u;step<<=1u){var add=0u;if(lid>=step){add=scan_scratch[lid-step];}workgroupBarrier();if(lid>=step){scan_scratch[lid]+=add;}workgroupBarrier();}if(tile<tile_count){tile_offsets.values[tile]=scan_scratch[lid]-count;}let group_size=min(256u,tile_count-group.x*256u);if(lid+1u==group_size){group_scan.values[group.x]=scan_scratch[lid];}}
@compute @workgroup_size(256) fn scan_group_totals(@builtin(local_invocation_index) lid:u32){let tile_count=params.tiles_x*params.tiles_y;let groups=(tile_count+255u)/256u;let count=select(0u,group_scan.values[lid],lid<groups);scan_scratch[lid]=count;workgroupBarrier();for(var step=1u;step<256u;step<<=1u){var add=0u;if(lid>=step){add=scan_scratch[lid-step];}workgroupBarrier();if(lid>=step){scan_scratch[lid]+=add;}workgroupBarrier();}if(lid<groups){group_scan.values[groups+lid]=scan_scratch[lid]-count;}if(lid+1u==groups){tile_offsets.values[tile_count]=scan_scratch[lid];}}
@compute @workgroup_size(256) fn add_group_offsets(@builtin(global_invocation_id) id:vec3u){let tile_count=params.tiles_x*params.tiles_y;let groups=(tile_count+255u)/256u;if(id.x<tile_count){tile_offsets.values[id.x]+=group_scan.values[groups+id.x/256u];}}
@compute @workgroup_size(64) fn compact_tiles(@builtin(global_invocation_id) id:vec3u){let tile_count=params.tiles_x*params.tiles_y;let tile=id.x;if(tile>=tile_count){return;}let output=tile_offsets.values[tile];let base=tile*params.words_per_tile;var cursor=0u;for(var wi=0u;wi<params.words_per_tile;wi++){var bits=atomicLoad(&membership.values[base+wi]);while(bits!=0u){let bit=firstTrailingBit(bits);let ri=wi*32u+bit;if(ri<params.record_count){compact_indices.values[output+cursor]=ri;cursor++;}bits&=bits-1u;}}}
fn ch(p:u32,s:u32)->u32{return (p>>s)&255u;} fn pack(r:u32,g:u32,b:u32)->u32{return r|(g<<8u)|(b<<16u);} fn filt(p:u32,c:u32)->u32{return pack((ch(p,0u)*ch(c,0u))>>8u,(ch(p,8u)*ch(c,8u))>>8u,(ch(p,16u)*ch(c,16u))>>8u);}
fn blend(s:u32,d:u32)->u32{let m=params.blend_mode;let sr=ch(s,0u);let sg=ch(s,8u);let sb=ch(s,16u);let dr=ch(d,0u);let dg=ch(d,8u);let db=ch(d,16u);if(m==1u){return pack(min(255u,sr+dr),min(255u,sg+dg),min(255u,sb+db));}if(m==2u){return pack(max(sr,dr),max(sg,dg),max(sb,db));}if(m==3u){return ((s>>1u)&0x007f7f7fu)+((d>>1u)&0x007f7f7fu);}if(m==4u){return pack(select(0u,dr-sr,dr>=sr),select(0u,dg-sg,dg>=sg),select(0u,db-sb,db>=sb));}if(m==5u){return pack(select(0u,sr-dr,sr>=dr),select(0u,sg-dg,sg>=dg),select(0u,sb-db,sb>=db));}if(m==6u){return pack((sr*dr)>>8u,(sg*dg)>>8u,(sb*db)>>8u);}if(m==7u){let a=params.alpha_flags&255u;let z=256u-a;return pack(((sr*a)>>8u)+((dr*z)>>8u),((sg*a)>>8u)+((dg*z)>>8u),((sb*a)>>8u)+((db*z)>>8u));}if(m==8u){return (s^d)&0x00ffffffu;}if(m==9u){return pack(min(sr,dr),min(sg,dg),min(sb,db));}return s&0x00ffffffu;}
@compute @workgroup_size(16,16,1) fn raster_texer(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) group:vec3u){if(id.x>=params.width||id.y>=params.height){return;}let pixel=id.y*params.width+id.x;var d=select(source.pixels[pixel],0u,(params.alpha_flags&0x100u)!=0u);let tile=group.y*params.tiles_x+group.x;let begin=tile_offsets.values[tile];let end=tile_offsets.values[tile+1u];for(var ci=begin;ci<end;ci++){let r=records.values[compact_indices.values[ci]];if(i32(id.x)>=r.left&&i32(id.x)<=r.right&&i32(id.y)>=r.top&&i32(id.y)<=r.bottom){var tx=r.texture_x+i32(id.x)-r.left;var ty=r.texture_y+i32(id.y)-r.top;if((r.flags&1u)!=0u){tx=i32(params.bitmap_width)-tx-1;}if((r.flags&2u)!=0u){ty=i32(params.bitmap_height)-ty-1;}if(tx>=0&&ty>=0&&tx<i32(params.bitmap_width)&&ty<i32(params.bitmap_height)){var s=bitmap.pixels[u32(ty)*params.bitmap_width+u32(tx)]&0x00ffffffu;if((r.flags&4u)!=0u){s=filt(s,r.color);}d=blend(s,d);}}}destination.pixels[pixel]=d;}
`
);

// tools/avs-texer-ordered-gpu-timestamp-benchmark.ts
var passNames = ["clear", "bin", "tile-count-scan", "group-scan", "offset-fixup", "compact", "raster"];
void run().then(finish, (error) => finish({ error: error instanceof Error ? error.stack ?? error.message : String(error) }));
async function run() {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No adapter");
  if (!adapter.features.has("timestamp-query")) return { supported: false, reason: "timestamp-query unavailable" };
  const device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
  const width = 640, height = 360, count = 1024;
  const bitmap = { width: 5, height: 5, pixels: Uint32Array.from({ length: 25 }, (_, index) => Math.imul(index + 1, 197895) & 16777215) };
  const plan = planExactAvsTexerGpu(width, height, bitmap, count);
  if (!plan.eligible) throw new Error(plan.reason ?? "plan");
  const pass = new ExactAvsOrderedTexerGpuPass(device, plan, bitmap);
  const records = Array.from({ length: count }, (_, index) => buildExactAvsTexerRecord(bitmap, index * 97 % width, index * 193 % height, Math.imul(index + 1, 461581) & 16777215));
  pass.update({ records, blendMode: 7, adjustableAlpha: 173, clearInput: false });
  const bytes = width * height * 4;
  const source = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const target = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
  const queries = device.createQuerySet({ type: "timestamp", count: 14 });
  const resolved = device.createBuffer({ size: 112, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: 112, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const samples = Array.from({ length: 7 }, () => []);
  for (let sample = -3; sample < 12; sample++) {
    const encoder = device.createCommandEncoder();
    pass.encodeTimed({ device, encoder, width, height, source, target }, queries);
    encoder.resolveQuerySet(queries, 0, 14, resolved, 0);
    encoder.copyBufferToBuffer(resolved, 0, read, 0, 112);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = new BigUint64Array(read.getMappedRange().slice(0));
    read.unmap();
    if (sample >= 0) for (let index = 0; index < 7; index++) samples[index].push(Number(values[index * 2 + 1] - values[index * 2]) / 1e6);
  }
  const totals = Array.from({ length: samples[0].length }, (_, sample) => samples.reduce((sum, values) => sum + values[sample], 0));
  const result = {
    supported: true,
    width,
    height,
    records: count,
    passes: Object.fromEntries(passNames.map((name, index) => [name, { medianMs: median(samples[index]), p95Ms: p95(samples[index]) }])),
    totalPassMedianMs: median(totals),
    totalPassP95Ms: p95(totals)
  };
  pass.destroy();
  source.destroy();
  target.destroy();
  resolved.destroy();
  read.destroy();
  queries.destroy();
  device.destroy();
  return result;
}
function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}
function p95(values) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}
function finish(result) {
  document.documentElement.dataset.done = "true";
  const output = document.querySelector("pre") ?? document.body.appendChild(document.createElement("pre"));
  output.textContent = JSON.stringify(result, null, 2);
}
