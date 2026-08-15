// src/avs/types.ts
var AVS_FFT_SIZE = 512;
var AVS_FFT_BINS = AVS_FFT_SIZE / 2;

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

// src/avs/effects/movement.ts
var TEXT = new TextDecoder("windows-1252");
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
function buildStaticAvsMovementGpuMap(config, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (config.sourceMapped !== 0 || config.effect < 2 || config.effect > 17) return null;
  const count = width * height;
  if (!Number.isSafeInteger(count) || count >= 1 << 22) return null;
  const bilinear = config.subpixel && width > 1 && height > 1 && config.effect >= 3 && config.effect !== 7;
  const table = {
    offsets: new Uint32Array(count),
    weightKeys: new Uint16Array(count),
    bilinear
  };
  buildStaticMovementTable(config, table, width, height);
  const packedCoordinates = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    packedCoordinates[index] = table.offsets[index] | table.weightKeys[index] << 22;
  }
  return { packedCoordinates, bilinear, blend: config.blend };
}
function buildStaticMovementTable(config, table, width, height) {
  if (config.effect === 2) {
    const shift = Math.trunc(width / 64);
    for (let y = 0; y < height; y++) {
      let sourceX = shift;
      for (let x = 0; x < width; x++) {
        table.offsets[x + y * width] = sourceX + y * width;
        sourceX++;
        if (sourceX >= width) sourceX -= width;
      }
    }
    return;
  }
  if (config.effect === 7) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sourceX = x;
      let sourceY = y;
      if ((x & 2) === 0 && (y & 2) === 0) {
        sourceX = Math.trunc(width / 2 + ((x & ~1) - width / 2) * 7 / 8);
        sourceY = Math.trunc(height / 2 + ((y & ~1) - height / 2) * 7 / 8);
      }
      table.offsets[x + y * width] = clamp(sourceX, 0, width - 1) + clamp(sourceY, 0, height - 1) * width;
    }
    return;
  }
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
      switch (config.effect) {
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
      storeCoordinate(table, x + y * width, sampleX, sampleY, width, height, config.wrap);
    }
  }
}
function storeCoordinate(table, destination, rawX, rawY, width, height, wrap) {
  if (!table.bilinear) {
    let x2 = Math.trunc(rawX);
    let y2 = Math.trunc(rawY);
    if (wrap) {
      x2 = modulo(x2, width);
      y2 = modulo(y2, height);
    } else {
      x2 = clamp(x2, 0, width - 1);
      y2 = clamp(y2, 0, height - 1);
    }
    table.offsets[destination] = x2 + y2 * width;
    return;
  }
  let x = Math.trunc(rawX);
  let y = Math.trunc(rawY);
  let xPartial = Math.trunc(32 * (rawX - x));
  let yPartial = Math.trunc(32 * (rawY - y));
  if (wrap) {
    x = modulo(x, width - 1);
    y = modulo(y, height - 1);
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
  table.offsets[destination] = packed & OFFSET_MASK;
  const xWeight = packed >>> 24 & 31 << 3;
  const yWeight = packed >>> 19 & 31 << 3;
  table.weightKeys[destination] = xWeight << 2 | yWeight >>> 3;
}
function modulo(value, modulus) {
  if (modulus <= 0) return 0;
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
}
function clamp(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

// src/avs/effects/blitter-gpu.ts
function buildStaticAvsBlitterFeedbackGpuParams(config, width, height) {
  if (config.changeOnBeat || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > 2147483647) return null;
  const value = Math.max(0, config.scale);
  if (value === 32) return null;
  if (value < 32) {
    const step2 = Math.trunc((value + 32) * 65536 / 64);
    const startX2 = Math.trunc((width * 65536 - step2 * width) / 2);
    const startY2 = Math.trunc((height * 65536 - step2 * height) / 2);
    if (Math.max(startX2 + width * step2 * 2, startY2 + height * step2) > 2147483647) return null;
    return {
      width,
      height,
      pixels,
      mode: 1,
      step: step2,
      startX: startX2,
      startY: startY2,
      regionWidth: width,
      regionHeight: height,
      blend: config.blend,
      subpixel: config.subpixel
    };
  }
  if (value > 4095) return null;
  const step = value + 96 << 9;
  if (step <= 0) return null;
  const regionWidth = Math.trunc(width * 65536 / step) & ~3;
  const regionHeight = Math.trunc(height * 65536 / step);
  if (regionWidth >= width || regionHeight >= height || regionWidth <= 0 || regionHeight <= 0) return null;
  const startX = Math.trunc((width - regionWidth) / 2);
  const startY = Math.trunc((height - regionHeight) / 2);
  if (Math.max(regionWidth * step * 2, regionHeight * step) > 2147483647) return null;
  return {
    width,
    height,
    pixels,
    mode: 2,
    step,
    startX,
    startY,
    regionWidth,
    regionHeight,
    blend: config.blend,
    subpixel: false
  };
}
function buildStaticAvsRotoBlitterGpuParams(config, width, height) {
  if (config.beatReverse || config.beatScale || width < 2 || height < 2) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width > 16384 || height > 16384) return null;
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > 2147483647) return null;
  const ds = width - 1 << 16;
  const dt = height - 1 << 16;
  if (ds <= 0 || dt <= 0) return null;
  const zoom = 1 + (config.zoom - 31) / 31;
  const radians = (config.direction - 32) * Math.PI / 180;
  const cosine = Math.cos(radians) * zoom;
  const sine = Math.sin(radians) * zoom;
  const dsDx = Math.trunc(cosine * 65536);
  const dtDy = Math.trunc(cosine * 65536);
  const dsDy = -Math.trunc(sine * 65536);
  const dtDx = Math.trunc(sine * 65536);
  if (dsDx <= -ds || dsDx >= ds || dtDx <= -dt || dtDx >= dt) return null;
  if (![dsDx, dtDy, dsDy, dtDx].every(Number.isSafeInteger)) return null;
  const safe = 2147483647;
  if (Math.abs(dsDx) * (width - 1) + Math.abs(dsDy) * (height - 1) + ds > safe) return null;
  if (Math.abs(dtDx) * (width - 1) + Math.abs(dtDy) * (height - 1) + dt > safe) return null;
  const halfWidth = Math.trunc((width - 1) / 2);
  const halfHeight = Math.trunc((height - 1) / 2);
  const sStart = modulo2(
    -halfWidth * dsDx - halfHeight * dsDy + (width - 1) * (32768 + (1 << 20)),
    ds
  );
  const tStart = modulo2(
    -halfWidth * dtDx - halfHeight * dtDy + (height - 1) * (32768 + (1 << 20)),
    dt
  );
  return {
    width,
    height,
    pixels,
    ds,
    dt,
    dsDx,
    dsDy,
    dtDx,
    dtDy,
    sStart,
    tStart,
    subpixel: config.subpixel,
    blend: config.blend
  };
}
function modulo2(value, divisor) {
  const result = value % divisor;
  return result < 0 ? result + divisor : result;
}

// src/avs/gpu-frame-graph.ts
var AVS_EXACT_BLUR_WGSL = (
  /* wgsl */
  `
struct Params { width: u32, height: u32, mode: u32, rounding: u32 };
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn shifted(pixel: u32, amount: u32) -> u32 {
  let masks = array<u32, 5>(0u, 0x007f7f7fu, 0x003f3f3fu, 0x001f1f1fu, 0x000f0f0fu);
  return (pixel >> amount) & masks[amount];
}

@compute @workgroup_size(256)
fn blur_main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  let count = params.width * params.height;
  if (index >= count) { return; }
  if (params.width < 2u || params.height < 2u) {
    destination[index] = source[index] & 0x00ffffffu;
    return;
  }
  let x = index % params.width;
  let y = index / params.width;
  let at_left = x == 0u;
  let at_right = x + 1u == params.width;
  let at_top = y == 0u;
  let at_bottom = y + 1u == params.height;
  let center = source[index];
  var left = 0u; var right = 0u; var up = 0u; var down = 0u;
  if (!at_left) { left = source[index - 1u]; }
  if (!at_right) { right = source[index + 1u]; }
  if (!at_top) { up = source[index - params.width]; }
  if (!at_bottom) { down = source[index + params.width]; }
  let corner = (at_left || at_right) && (at_top || at_bottom);
  let edge = at_left || at_right || at_top || at_bottom;
  var value = 0u;
  var round = 0u;
  if (params.mode == 3u) {
    value += select(shifted(left, 2u) + shifted(right, 2u), shifted(select(left, right, at_left), 1u), at_left || at_right);
    value += select(shifted(up, 2u) + shifted(down, 2u), shifted(select(up, down, at_top), 1u), at_top || at_bottom);
    round = select(3u, select(2u, 1u, corner), at_left || at_right || at_top || at_bottom);
  } else if (params.mode == 2u) {
    value = shifted(center, 1u);
    if (corner) {
      value += shifted(center, 2u) + shifted(select(left, right, at_left), 3u) + shifted(select(up, down, at_top), 3u);
      round = 3u;
    } else if (edge) {
      value += shifted(center, 3u);
      if (at_top || at_bottom) {
        value += shifted(left, 3u) + shifted(right, 3u) + shifted(select(up, down, at_top), 3u);
      } else {
        value += shifted(select(left, right, at_left), 3u) + shifted(up, 3u) + shifted(down, 3u);
      }
      round = 4u;
    } else {
      value += shifted(center, 2u) + shifted(left, 4u) + shifted(right, 4u) + shifted(up, 4u) + shifted(down, 4u);
      round = 5u;
    }
  } else {
    if (corner) {
      value = shifted(center, 1u) + shifted(select(left, right, at_left), 2u) + shifted(select(up, down, at_top), 2u);
      round = 2u;
    } else if (at_top || at_bottom) {
      value = shifted(center, 2u) + shifted(left, 2u) + shifted(right, 2u) + shifted(select(up, down, at_top), 2u);
      round = 3u;
    } else if (at_left || at_right) {
      value = shifted(center, 2u) + shifted(select(left, right, at_left), 2u) + shifted(up, 2u) + shifted(down, 2u);
      round = 3u;
    } else {
      value = shifted(center, 1u) + shifted(left, 3u) + shifted(right, 3u) + shifted(up, 3u) + shifted(down, 3u);
      round = 4u;
    }
  }
  let rounding = select(0u, round * 0x00010101u, params.rounding != 0u);
  destination[index] = (value + rounding) & 0x00ffffffu;
}
`
);
function buildExactAvsPointwiseWgsl(operations2) {
  if (operations2.length === 0) throw new RangeError("Pointwise GPU pass needs at least one operation");
  const body = operations2.map((operation, index) => pointwiseWgsl(operation, index)).join("\n");
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
    case "channel-shift": {
      assertIntegerRange(operation.mode, -2147483648, 2147483647, "Channel Shift mode");
      const low = "pixel & 255u", middle = "(pixel >> 8u) & 255u", high = "(pixel >> 16u) & 255u";
      const packed = operation.mode === 1020 ? `avs_pack(${middle}, ${low}, ${high})` : operation.mode === 1018 ? `avs_pack(${high}, ${low}, ${middle})` : operation.mode === 1022 ? `avs_pack(${low}, ${high}, ${middle})` : operation.mode === 1019 ? `avs_pack(${middle}, ${high}, ${low})` : operation.mode === 1021 ? `avs_pack(${high}, ${middle}, ${low})` : null;
      return packed ? `// fused ${index}: Channel Shift ${operation.mode}
pixel = ${packed};` : `// fused ${index}: Channel Shift ${operation.mode} native no-op`;
    }
    case "color-reduction":
      assertIntegerRange(operation.mask, 0, 16777215, "Color Reduction mask");
      return `// fused ${index}: Color Reduction
if (index >= 4u) { pixel &= ${operation.mask}u; }`;
    case "multiplier": {
      assertIntegerRange(operation.mode, -2147483648, 2147483647, "Multiplier mode");
      if (operation.mode === 0) return `// fused ${index}: Multiplier infinite root
if (index > 0u) { pixel = select(0xffffffu, 0u, pixel == 0u); }`;
      if (operation.mode === 7) return `// fused ${index}: Multiplier infinite square
if (index > 0u) { pixel = select(0u, 0xffffffu, pixel == 0xffffffu); }`;
      if (operation.mode >= 1 && operation.mode <= 3) {
        const factor = 1 << 4 - operation.mode;
        return `// fused ${index}: Multiplier x${factor}
if (index < arrayLength(&source) - (arrayLength(&source) & 1u)) { pixel = avs_pack(min(255u, (pixel & 255u) * ${factor}u), min(255u, ((pixel >> 8u) & 255u) * ${factor}u), min(255u, ((pixel >> 16u) & 255u) * ${factor}u)); }`;
      }
      if (operation.mode >= 4 && operation.mode <= 6) {
        const shift = operation.mode - 3;
        return `// fused ${index}: Multiplier divide ${1 << shift}
if (index < arrayLength(&source) - (arrayLength(&source) & 1u)) { pixel = avs_pack((pixel & 255u) >> ${shift}u, ((pixel >> 8u) & 255u) >> ${shift}u, ((pixel >> 16u) & 255u) >> ${shift}u); }`;
      }
      return `// fused ${index}: Multiplier ${operation.mode} native no-op`;
    }
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
      const close = operation.exclude ? "\n}" : "";
      const combine = operation.additive ? `pixel = avs_add(pixel, ${adjusted});` : operation.average ? `pixel = ((pixel >> 1u) & 0x007f7f7fu) + ((${adjusted} >> 1u) & 0x007f7f7fu);` : `pixel = ${adjusted};`;
      return `// fused ${index}: Brightness
${excluded}  let ${adjusted} = avs_adjust(pixel, ${operation.redMultiplier}u, ${operation.greenMultiplier}u, ${operation.blueMultiplier}u);
  ${combine}${close}`;
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
var AVS_EXACT_MOVEMENT_WGSL = (
  /* wgsl */
  `
struct Params { width: u32, pixels: u32, bilinear: u32, blend: u32 };
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<storage, read> coordinate_map: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn avs_table(first: u32, second: u32) -> u32 {
  var result = (first * second) / 255u;
  // The compatibility oracle builds native g_blendtable in JS as
  // trunc((first / 255) * second). Binary64 lands just below the exact integer
  // for these twelve ordered pairs, so preserve that established byte result.
  let correction = (first == 147u && (second == 85u || second == 170u))
    || (first == 155u && (second == 51u || second == 102u || second == 153u || second == 204u))
    || (first == 171u && (second == 85u || second == 170u))
    || (first == 187u && (second == 75u || second == 150u || second == 165u))
    || (first == 195u && second == 153u);
  if (correction) { result -= 1u; }
  return result;
}
fn avs_average(first: u32, second: u32) -> u32 {
  return ((first >> 1u) & 0x007f7f7fu) + ((second >> 1u) & 0x007f7f7fu);
}
fn avs_bilinear(offset: u32, key: u32) -> u32 {
  let x_part = (key >> 5u) << 3u;
  let y_part = (key & 31u) << 3u;
  let inverse_x = 255u - x_part;
  let inverse_y = 255u - y_part;
  let weights = array<u32, 4>(
    avs_table(inverse_x, inverse_y), avs_table(x_part, inverse_y),
    avs_table(inverse_x, y_part), avs_table(x_part, y_part),
  );
  let samples = array<u32, 4>(
    source[offset], source[offset + 1u],
    source[offset + params.width], source[offset + params.width + 1u],
  );
  var low = 0u; var middle = 0u; var high = 0u;
  for (var sample_index = 0u; sample_index < 4u; sample_index++) {
    let pixel = samples[sample_index]; let weight = weights[sample_index];
    low += avs_table(pixel & 255u, weight);
    middle += avs_table((pixel >> 8u) & 255u, weight);
    high += avs_table((pixel >> 16u) & 255u, weight);
  }
  return (low & 255u) | ((middle & 255u) << 8u) | ((high & 255u) << 16u);
}
@compute @workgroup_size(256)
fn movement_main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= params.pixels) { return; }
  let packed = coordinate_map[index];
  let offset = packed & 0x003fffffu;
  var sampled = source[offset];
  if (params.bilinear != 0u) { sampled = avs_bilinear(offset, packed >> 22u); }
  destination[index] = select(sampled, avs_average(source[index], sampled), params.blend != 0u);
}
`
);
var AVS_EXACT_ROTO_BLITTER_WGSL = (
  /* wgsl */
  `
struct Params {
  width: i32, height: i32, pixels: i32, ds: i32,
  dt: i32, ds_dx: i32, ds_dy: i32, dt_dx: i32,
  dt_dy: i32, s_start: i32, t_start: i32, subpixel: i32,
  blend: i32,
};
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn positive_mod(value: i32, divisor: i32) -> i32 {
  let remainder = value % divisor;
  return select(remainder, remainder + divisor, remainder < 0);
}
fn avs_table(first: u32, second: u32) -> u32 {
  var result = (first * second) / 255u;
  let correction = (first == 147u && (second == 85u || second == 170u))
    || (first == 155u && (second == 51u || second == 102u || second == 153u || second == 204u))
    || (first == 171u && (second == 85u || second == 170u))
    || (first == 187u && (second == 75u || second == 150u || second == 165u))
    || (first == 195u && second == 153u);
  if (correction) { result -= 1u; }
  return result;
}
fn avs_average(first: u32, second: u32) -> u32 {
  return ((first >> 1u) & 0x007f7f7fu) + ((second >> 1u) & 0x007f7f7fu);
}
fn avs_bilinear(offset: u32, fx: u32, fy: u32) -> u32 {
  let inverse_x = 255u - fx;
  let inverse_y = 255u - fy;
  let weights = array<u32, 4>(
    avs_table(inverse_x, inverse_y), avs_table(fx, inverse_y),
    avs_table(inverse_x, fy), avs_table(fx, fy),
  );
  let width = u32(params.width);
  let samples = array<u32, 4>(
    source[offset], source[offset + 1u],
    source[offset + width], source[offset + width + 1u],
  );
  var low = 0u; var middle = 0u; var high = 0u;
  for (var sample_index = 0u; sample_index < 4u; sample_index++) {
    let pixel = samples[sample_index]; let weight = weights[sample_index];
    low += avs_table(pixel & 255u, weight);
    middle += avs_table((pixel >> 8u) & 255u, weight);
    high += avs_table((pixel >> 16u) & 255u, weight);
  }
  return (low & 255u) | ((middle & 255u) << 8u) | ((high & 255u) << 16u);
}
@compute @workgroup_size(256)
fn roto_blitter_main(@builtin(global_invocation_id) id: vec3u) {
  let index = i32(id.x);
  if (index >= params.pixels) { return; }
  let x = index % params.width;
  let y = index / params.width;
  let s = positive_mod(params.s_start + y * params.ds_dy + x * params.ds_dx, params.ds);
  let t = positive_mod(params.t_start + y * params.dt_dy + x * params.dt_dx, params.dt);
  let source_x = s >> 16;
  let source_y = t >> 16;
  let offset = u32(source_x + source_y * params.width);
  var sampled = source[offset];
  if (params.subpixel != 0) {
    sampled = avs_bilinear(offset, u32((s >> 8) & 255), u32((t >> 8) & 255));
  }
  destination[u32(index)] = select(sampled, avs_average(source[u32(index)], sampled), params.blend != 0);
}
`
);
var AVS_EXACT_BLITTER_FEEDBACK_WGSL = (
  /* wgsl */
  `
struct Params {
  width: i32, height: i32, pixels: i32, mode: i32,
  step: i32, start_x: i32, start_y: i32, region_width: i32,
  region_height: i32, blend: i32, subpixel: i32, padding: i32,
};
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn avs_average(first: u32, second: u32) -> u32 {
  return ((first >> 1u) & 0x007f7f7fu) + ((second >> 1u) & 0x007f7f7fu);
}
fn channel_bilinear(a: u32, b: u32, c: u32, d: u32, fx: u32, fy: u32) -> u32 {
  let top = (a * (255u - fx) + b * fx) >> 8u;
  let bottom = (c * (255u - fx) + d * fx) >> 8u;
  return (top * (255u - fy) + bottom * fy) >> 8u;
}
fn bilinear(offset: u32, source_x: i32, source_y: i32, fx: u32, fy: u32) -> u32 {
  let x1 = min(params.width - 1, source_x + 1);
  let y1 = min(params.height - 1, source_y + 1);
  let b = u32(source_y * params.width + x1);
  let c = u32(y1 * params.width + source_x);
  let d = u32(y1 * params.width + x1);
  let pa = source[offset]; let pb = source[b]; let pc = source[c]; let pd = source[d];
  return channel_bilinear(pa & 255u, pb & 255u, pc & 255u, pd & 255u, fx, fy)
    | (channel_bilinear((pa >> 8u) & 255u, (pb >> 8u) & 255u, (pc >> 8u) & 255u, (pd >> 8u) & 255u, fx, fy) << 8u)
    | (channel_bilinear((pa >> 16u) & 255u, (pb >> 16u) & 255u, (pc >> 16u) & 255u, (pd >> 16u) & 255u, fx, fy) << 16u);
}
fn nearest_or_black(linear: i32) -> u32 {
  if (linear < 0 || linear >= params.pixels) { return 0u; }
  return source[u32(linear)];
}
@compute @workgroup_size(256)
fn blitter_feedback_main(@builtin(global_invocation_id) id: vec3u) {
  let index = i32(id.x);
  if (index >= params.pixels) { return; }
  let x = index % params.width;
  let y = index / params.width;
  if (params.mode == 1) {
    let extra = select(0, (x / 4) * params.step, params.blend != 0 && params.subpixel == 0);
    let fixed_x = params.start_x + x * params.step + extra;
    let fixed_y = params.start_y + y * params.step;
    let source_x = fixed_x >> 16;
    let source_y = fixed_y >> 16;
    var sampled = nearest_or_black(source_y * params.width + source_x);
    if (params.subpixel != 0) {
      sampled = bilinear(u32(source_y * params.width + source_x), source_x, source_y,
        u32((fixed_x >> 8) & 255), u32((fixed_y >> 8) & 255));
    }
    destination[u32(index)] = select(sampled, avs_average(source[u32(index)], sampled), params.blend != 0);
    return;
  }
  let local_x = x - params.start_x;
  let local_y = y - params.start_y;
  if (local_x < 0 || local_y < 0 || local_x >= params.region_width || local_y >= params.region_height) {
    destination[u32(index)] = source[u32(index)];
    return;
  }
  let extra = select(0, (local_x / 4) * params.step, params.blend != 0);
  let source_x = (32768 + local_x * params.step + extra) >> 16;
  let source_y = (32768 + local_y * params.step) >> 16;
  let sampled = nearest_or_black(source_y * params.width + source_x);
  destination[u32(index)] = select(sampled, avs_average(source[u32(index)], sampled), params.blend != 0);
}
`
);

// tools/avs-gpu-shader-browser-check.ts
var operations = [
  { kind: "fade", fade: 13, target: 1056816 },
  { kind: "invert" },
  { kind: "fast-brightness", direction: 1 },
  { kind: "color-clip", mode: 3, source: 4214880, replacement: 10531008, distanceSquared: 3136 },
  {
    kind: "brightness",
    additive: false,
    average: true,
    redMultiplier: multiplier(1024),
    greenMultiplier: multiplier(-768),
    blueMultiplier: multiplier(384),
    reference: 8425632,
    exclude: true,
    distance: 11
  }
];
void run().then(
  (message) => finish("pass", message),
  (error) => finish("fail", error instanceof Error ? error.stack ?? error.message : String(error))
);
async function run() {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const length = 65537;
  const source = deterministicPixels(length, 1196447028);
  const expected = source.map((pixel) => operations.reduce(applyPointwise, pixel));
  const bytes = source.byteLength;
  const input = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    device.pushErrorScope("validation");
    const module = device.createShaderModule({ code: buildExactAvsPointwiseWgsl(operations) });
    const compilation = await module.getCompilationInfo();
    const shaderErrors = compilation.messages.filter((message) => message.type === "error");
    if (shaderErrors.length > 0) {
      throw new Error(shaderErrors.map(
        (message) => `${message.lineNum}:${message.linePos} ${message.message}`
      ).join("\n"));
    }
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "pointwise_main" }
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } }
      ]
    });
    const validation = await device.popErrorScope();
    if (validation) throw new Error(`WebGPU validation: ${validation.message}`);
    device.queue.writeBuffer(input, 0, source);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(length / 256));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(readback.getMappedRange());
    for (let index = 0; index < length; index++) {
      if (actual[index] !== expected[index]) {
        throw new Error(
          `pixel ${index}: GPU 0x${actual[index].toString(16)} != CPU 0x${expected[index].toString(16)}`
        );
      }
    }
    readback.unmap();
    const blurWidth = 17, blurHeight = 11, blurLength = blurWidth * blurHeight;
    const blurSource = deterministicPixels(blurLength, 1112298834);
    const blurExpected = emulateHeavyBlur(blurSource, blurWidth, blurHeight, true);
    const params = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    try {
      device.pushErrorScope("validation");
      const blurModule = device.createShaderModule({ code: AVS_EXACT_BLUR_WGSL });
      const blurCompilation = await blurModule.getCompilationInfo();
      const blurErrors = blurCompilation.messages.filter((message) => message.type === "error");
      if (blurErrors.length > 0) {
        throw new Error(blurErrors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join("\n"));
      }
      const blurPipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: blurModule, entryPoint: "blur_main" }
      });
      const blurGroup = device.createBindGroup({
        layout: blurPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: { buffer: params } }
        ]
      });
      const blurValidation = await device.popErrorScope();
      if (blurValidation) throw new Error(`WebGPU Blur validation: ${blurValidation.message}`);
      device.queue.writeBuffer(input, 0, blurSource);
      device.queue.writeBuffer(params, 0, new Uint32Array([blurWidth, blurHeight, 3, 1]));
      const blurEncoder = device.createCommandEncoder();
      const blurPass = blurEncoder.beginComputePass();
      blurPass.setPipeline(blurPipeline);
      blurPass.setBindGroup(0, blurGroup);
      blurPass.dispatchWorkgroups(Math.ceil(blurLength / 256));
      blurPass.end();
      blurEncoder.copyBufferToBuffer(output, 0, readback, 0, blurSource.byteLength);
      device.queue.submit([blurEncoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const blurActual = new Uint32Array(readback.getMappedRange(), 0, blurLength);
      for (let index = 0; index < blurLength; index++) {
        if (blurActual[index] !== blurExpected[index]) {
          throw new Error(
            `Blur pixel ${index}: GPU 0x${blurActual[index].toString(16)} != CPU 0x${blurExpected[index].toString(16)}`
          );
        }
      }
    } finally {
      params.destroy();
    }
    if (readback.mapState === "mapped") readback.unmap();
    const movementWidth = 23, movementHeight = 13, movementLength = movementWidth * movementHeight;
    const movementSource = deterministicPixels(movementLength, 1297045061);
    const movementConfig = {
      effect: 3,
      expression: "",
      blend: true,
      sourceMapped: 0,
      rectangular: false,
      subpixel: true,
      wrap: false
    };
    const movement = buildStaticAvsMovementGpuMap(movementConfig, movementWidth, movementHeight);
    if (!movement) throw new Error("static Movement map unexpectedly ineligible");
    const movementExpected = emulateMovement(movementSource, movementWidth, movement);
    const mapBuffer = device.createBuffer({
      size: movement.packedCoordinates.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const movementParams = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    try {
      device.pushErrorScope("validation");
      const movementModule = device.createShaderModule({ code: AVS_EXACT_MOVEMENT_WGSL });
      const movementCompilation = await movementModule.getCompilationInfo();
      const movementErrors = movementCompilation.messages.filter((message) => message.type === "error");
      if (movementErrors.length > 0) {
        throw new Error(movementErrors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join("\n"));
      }
      const movementPipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: movementModule, entryPoint: "movement_main" }
      });
      const movementGroup = device.createBindGroup({
        layout: movementPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: { buffer: mapBuffer } },
          { binding: 3, resource: { buffer: movementParams } }
        ]
      });
      const movementValidation = await device.popErrorScope();
      if (movementValidation) throw new Error(`WebGPU Movement validation: ${movementValidation.message}`);
      device.queue.writeBuffer(input, 0, movementSource);
      device.queue.writeBuffer(mapBuffer, 0, movement.packedCoordinates);
      device.queue.writeBuffer(movementParams, 0, new Uint32Array([
        movementWidth,
        movementLength,
        movement.bilinear ? 1 : 0,
        movement.blend ? 1 : 0
      ]));
      const movementEncoder = device.createCommandEncoder();
      const movementPass = movementEncoder.beginComputePass();
      movementPass.setPipeline(movementPipeline);
      movementPass.setBindGroup(0, movementGroup);
      movementPass.dispatchWorkgroups(Math.ceil(movementLength / 256));
      movementPass.end();
      movementEncoder.copyBufferToBuffer(output, 0, readback, 0, movementSource.byteLength);
      device.queue.submit([movementEncoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const movementActual = new Uint32Array(readback.getMappedRange(), 0, movementLength);
      for (let index = 0; index < movementLength; index++) {
        if (movementActual[index] !== movementExpected[index]) {
          throw new Error(
            `Movement pixel ${index}: GPU 0x${movementActual[index].toString(16)} != CPU 0x${movementExpected[index].toString(16)}`
          );
        }
      }
    } finally {
      mapBuffer.destroy();
      movementParams.destroy();
    }
    if (readback.mapState === "mapped") readback.unmap();
    const rotoWidth = 31, rotoHeight = 17, rotoLength = rotoWidth * rotoHeight;
    const rotoSource = deterministicPixels(rotoLength, 1380930639);
    const rotoConfig = {
      zoom: 40,
      direction: 18,
      blend: true,
      beatReverse: false,
      beatSpeed: 0,
      beatZoom: 31,
      beatScale: false,
      subpixel: true
    };
    const roto = buildStaticAvsRotoBlitterGpuParams(rotoConfig, rotoWidth, rotoHeight);
    if (!roto) throw new Error("static Roto Blitter unexpectedly ineligible");
    await runPackedShaderDifferential(
      device,
      input,
      output,
      readback,
      AVS_EXACT_ROTO_BLITTER_WGSL,
      "roto_blitter_main",
      rotoSource,
      emulateRotoBlitter(rotoSource, roto),
      new Int32Array([
        roto.width,
        roto.height,
        roto.pixels,
        roto.ds,
        roto.dt,
        roto.dsDx,
        roto.dsDy,
        roto.dtDx,
        roto.dtDy,
        roto.sStart,
        roto.tStart,
        roto.subpixel ? 1 : 0,
        roto.blend ? 1 : 0,
        0,
        0,
        0
      ]),
      "Roto Blitter"
    );
    const blitterWidth = 29, blitterHeight = 17, blitterLength = blitterWidth * blitterHeight;
    const blitterSource = deterministicPixels(blitterLength, 1112295764);
    const blitterConfig = {
      scale: 30,
      beatScale: 30,
      blend: true,
      changeOnBeat: false,
      subpixel: false
    };
    const blitter = buildStaticAvsBlitterFeedbackGpuParams(blitterConfig, blitterWidth, blitterHeight);
    if (!blitter) throw new Error("static Blitter Feedback unexpectedly ineligible");
    await runPackedShaderDifferential(
      device,
      input,
      output,
      readback,
      AVS_EXACT_BLITTER_FEEDBACK_WGSL,
      "blitter_feedback_main",
      blitterSource,
      emulateBlitterFeedback(blitterSource, blitter),
      new Int32Array([
        blitter.width,
        blitter.height,
        blitter.pixels,
        blitter.mode,
        blitter.step,
        blitter.startX,
        blitter.startY,
        blitter.regionWidth,
        blitter.regionHeight,
        blitter.blend ? 1 : 0,
        blitter.subpixel ? 1 : 0,
        0
      ]),
      "Blitter Feedback"
    );
    return `${length} packed pointwise pixels + ${blurLength} Blur pixels + ${movementLength} Movement + ${rotoLength} Roto Blitter + ${blitterLength} Blitter Feedback pixels, ${operations.length} fused operations, byte-exact`;
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    input.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
}
async function runPackedShaderDifferential(device, input, output, readback, shader, entryPoint, source, expected, values, label) {
  const params = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  try {
    device.pushErrorScope("validation");
    const module = device.createShaderModule({ label, code: shader });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length > 0) {
      throw new Error(errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join("\n"));
    }
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: input } },
      { binding: 1, resource: { buffer: output } },
      { binding: 2, resource: { buffer: params } }
    ] });
    const validation = await device.popErrorScope();
    if (validation) throw new Error(`WebGPU ${label} validation: ${validation.message}`);
    device.queue.writeBuffer(input, 0, source);
    device.queue.writeBuffer(params, 0, values);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(source.length / 256));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, source.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(readback.getMappedRange(), 0, source.length);
    for (let index = 0; index < source.length; index++) if (actual[index] !== expected[index]) {
      throw new Error(`${label} pixel ${index}: GPU 0x${actual[index].toString(16)} != CPU 0x${expected[index].toString(16)}`);
    }
    readback.unmap();
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    params.destroy();
  }
}
function emulateRotoBlitter(source, affine) {
  const output = new Uint32Array(source.length);
  const modulo3 = (value, divisor) => {
    const result = value % divisor;
    return result < 0 ? result + divisor : result;
  };
  const table = (first, second) => Math.trunc(first / 255 * second);
  for (let index = 0; index < source.length; index++) {
    const x = index % affine.width, y = Math.trunc(index / affine.width);
    const s = modulo3(affine.sStart + y * affine.dsDy + x * affine.dsDx, affine.ds);
    const t = modulo3(affine.tStart + y * affine.dtDy + x * affine.dtDx, affine.dt);
    const offset = (s >> 16) + (t >> 16) * affine.width;
    let sampled = source[offset];
    if (affine.subpixel) {
      const fx = s >> 8 & 255, fy = t >> 8 & 255;
      const weights = [table(255 - fx, 255 - fy), table(fx, 255 - fy), table(255 - fx, fy), table(fx, fy)];
      const pixels = [source[offset], source[offset + 1], source[offset + affine.width], source[offset + affine.width + 1]];
      const channel = (shift) => pixels.reduce((sum, pixel, sample) => sum + table(pixel >>> shift & 255, weights[sample]), 0) & 255;
      sampled = channel(0) | channel(8) << 8 | channel(16) << 16;
    }
    output[index] = affine.blend ? (source[index] >>> 1 & 8355711) + (sampled >>> 1 & 8355711) : sampled;
  }
  return output;
}
function emulateBlitterFeedback(source, blitter) {
  const output = source.slice();
  const nearest = (linear) => linear >= 0 && linear < source.length ? source[linear] : 0;
  for (let index = 0; index < source.length; index++) {
    const x = index % blitter.width, y = Math.trunc(index / blitter.width);
    if (blitter.mode === 2) {
      const localX = x - blitter.startX, localY = y - blitter.startY;
      if (localX < 0 || localY < 0 || localX >= blitter.regionWidth || localY >= blitter.regionHeight) continue;
      const extra2 = blitter.blend ? Math.trunc(localX / 4) * blitter.step : 0;
      const sampled2 = nearest((32768 + localY * blitter.step >> 16) * blitter.width + (32768 + localX * blitter.step + extra2 >> 16));
      output[index] = blitter.blend ? (source[index] >>> 1 & 8355711) + (sampled2 >>> 1 & 8355711) : sampled2;
      continue;
    }
    const extra = blitter.blend && !blitter.subpixel ? Math.trunc(x / 4) * blitter.step : 0;
    const fixedX = blitter.startX + x * blitter.step + extra, fixedY = blitter.startY + y * blitter.step;
    const sampled = nearest((fixedY >> 16) * blitter.width + (fixedX >> 16));
    output[index] = blitter.blend ? (source[index] >>> 1 & 8355711) + (sampled >>> 1 & 8355711) : sampled;
  }
  return output;
}
function applyPointwise(pixel, operation) {
  pixel &= 16777215;
  const pack = (low, middle, high) => low & 255 | (middle & 255) << 8 | (high & 255) << 16;
  const values = () => [pixel & 255, pixel >>> 8 & 255, pixel >>> 16 & 255];
  const clamp2 = (value) => value < 0 ? 0 : value > 255 ? 255 : Math.trunc(value);
  switch (operation.kind) {
    case "fade": {
      const approach = (value, target) => value <= target - operation.fade ? value + operation.fade & 255 : value >= target + operation.fade ? value - operation.fade & 255 : target;
      const [low, middle, high] = values();
      return pack(
        approach(low, operation.target & 255),
        approach(middle, operation.target >>> 8 & 255),
        approach(high, operation.target >>> 16 & 255)
      );
    }
    case "invert":
      return pixel ^ 16777215;
    case "fast-brightness": {
      if (operation.direction === 1) return pixel >>> 1 & 8355711;
      const [low, middle, high] = values();
      return pack(clamp2(low * 2), clamp2(middle * 2), clamp2(high * 2));
    }
    case "color-clip": {
      const [low, middle, high] = values();
      const sl = operation.source & 255, sm = operation.source >>> 8 & 255, sh = operation.source >>> 16 & 255;
      const match = operation.mode === 1 ? low <= sl && middle <= sm && high <= sh : operation.mode === 2 ? low >= sl && middle >= sm && high >= sh : (low - sl) ** 2 + (middle - sm) ** 2 + (high - sh) ** 2 <= operation.distanceSquared;
      return match ? operation.replacement : pixel;
    }
    case "brightness": {
      const [low, middle, high] = values();
      if (operation.exclude && Math.abs(low - (operation.reference & 255)) <= operation.distance && Math.abs(middle - (operation.reference >>> 8 & 255)) <= operation.distance && Math.abs(high - (operation.reference >>> 16 & 255)) <= operation.distance) return pixel;
      const adjusted = pack(
        clamp2(low * operation.blueMultiplier / 65536),
        clamp2(middle * operation.greenMultiplier / 65536),
        clamp2(high * operation.redMultiplier / 65536)
      );
      if (operation.additive) {
        return pack(
          clamp2(low + (adjusted & 255)),
          clamp2(middle + (adjusted >>> 8 & 255)),
          clamp2(high + (adjusted >>> 16 & 255))
        );
      }
      return operation.average ? (pixel >>> 1 & 8355711) + (adjusted >>> 1 & 8355711) : adjusted;
    }
  }
}
function multiplier(setting) {
  return Math.trunc((1 + (setting < 0 ? 1 : 16) * (setting / 4096)) * 65536);
}
function emulateMovement(source, width, movement) {
  const output = new Uint32Array(source.length);
  const table = (first, second) => Math.trunc(first / 255 * second);
  for (let index = 0; index < source.length; index++) {
    const packed = movement.packedCoordinates[index];
    const offset = packed & 4194303;
    let sampled = source[offset];
    if (movement.bilinear) {
      const key = packed >>> 22;
      const xPart = key >>> 5 << 3, yPart = (key & 31) << 3;
      const weights = [
        table(255 - xPart, 255 - yPart),
        table(xPart, 255 - yPart),
        table(255 - xPart, yPart),
        table(xPart, yPart)
      ];
      const pixels = [source[offset], source[offset + 1], source[offset + width], source[offset + width + 1]];
      const channel = (shift) => pixels.reduce(
        (sum, pixel, sample) => sum + table(pixel >>> shift & 255, weights[sample]),
        0
      ) & 255;
      sampled = channel(0) | channel(8) << 8 | channel(16) << 16;
    }
    output[index] = movement.blend ? (source[index] >>> 1 & 8355711) + (sampled >>> 1 & 8355711) : sampled;
  }
  return output;
}
function deterministicPixels(length, seed) {
  const output = new Uint32Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = state & 16777215;
  }
  return output;
}
function emulateHeavyBlur(source, width, height, roundUp) {
  const destination = new Uint32Array(source.length);
  const shifted = (pixel, amount) => pixel >>> amount & [0, 8355711, 4144959][amount];
  for (let index = 0; index < source.length; index++) {
    const x = index % width, y = Math.trunc(index / width);
    const leftEdge = x === 0, rightEdge = x + 1 === width;
    const topEdge = y === 0, bottomEdge = y + 1 === height;
    const left = leftEdge ? 0 : source[index - 1];
    const right = rightEdge ? 0 : source[index + 1];
    const up = topEdge ? 0 : source[index - width];
    const down = bottomEdge ? 0 : source[index + width];
    let value = leftEdge || rightEdge ? shifted(leftEdge ? right : left, 1) : shifted(left, 2) + shifted(right, 2);
    value += topEdge || bottomEdge ? shifted(topEdge ? down : up, 1) : shifted(up, 2) + shifted(down, 2);
    const corner = (leftEdge || rightEdge) && (topEdge || bottomEdge);
    const edge = leftEdge || rightEdge || topEdge || bottomEdge;
    const rounding = roundUp ? (corner ? 1 : edge ? 2 : 3) * 65793 : 0;
    destination[index] = value + rounding & 16777215;
  }
  return destination;
}
function finish(status, message) {
  document.body.dataset.status = status;
  document.body.textContent = `${status.toUpperCase()}: ${message}`;
}
