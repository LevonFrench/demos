// Minimal WebGL2 helpers: fullscreen-triangle passes + ping-pong render targets.

export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL2 is required.');

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  return { gl, vao };
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(log + '\n---\n' + numbered(src));
  }
  return sh;
}

function numbered(src) {
  return src.split('\n').map((l, i) => String(i + 1).padStart(4) + ' | ' + l).join('\n');
}

export function createProgram(gl, fragSrc, label = 'shader') {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  let fs;
  try {
    fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  } catch (e) {
    gl.deleteShader(vs);
    throw new Error(`[${label}] ${e.message}`);
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`[${label}] ${gl.getProgramInfoLog(prog)}`);
  }

  const uniforms = new Map();
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i);
    uniforms.set(info.name.replace('[0]', ''), gl.getUniformLocation(prog, info.name));
  }
  return { prog, uniforms, label };
}

export function setUniforms(gl, program, values) {
  for (const [name, value] of Object.entries(values)) {
    const loc = program.uniforms.get(name);
    if (loc == null) continue; // unused in this shader — fine
    if (typeof value === 'number') gl.uniform1f(loc, value);
    else if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
    else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2]);
    else if (value.length === 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
  }
}

export function createTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

// Two colour targets we bounce between, so any number of effect passes can chain.
// `float` gives RGBA16F, needed for anything that feeds its own output back in —
// a velocity field quantised to 8 bits dies within a few frames.
export function createPingPong(gl, w, h, float = false) {
  const make = () => {
    const tex = createTexture(gl);
    if (float) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  };
  return [make(), make()];
}

export function disposePingPong(gl, targets) {
  for (const t of targets) {
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }
}
