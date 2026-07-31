import * as THREE from 'three';

export class Visualizer {
  constructor(container) {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x020005, 0.04); // Dark purple fog
    this.scene.background = new THREE.Color(0x020005);
    
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    // Position camera near the floor looking towards the horizon
    this.camera.position.set(0, 1, 5);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.clock = new THREE.Clock();
    
    this.uniforms = {
      iTime: { value: 0.0 },
      iResolution: { value: new THREE.Vector3(window.innerWidth, window.innerHeight, 1) },
      iMouse: { value: new THREE.Vector4(0, 0, 0, 0) },
      uAudioLevel: { value: 0.0 },
      uAudioHigh: { value: 0.0 }
    };

    this.createLaserGrid();
    this.createSun();

    window.addEventListener('resize', this.onWindowResize.bind(this));
    
    // Mouse Interactivity controls camera slightly
    window.addEventListener('mousemove', (e) => {
      this.uniforms.iMouse.value.x = e.clientX;
      this.uniforms.iMouse.value.y = window.innerHeight - e.clientY;
    });
  }

  createSun() {
    const geometry = new THREE.CircleGeometry(15, 64);
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float iTime;
        uniform float uAudioLevel;
        uniform float uAudioHigh;
        varying vec2 vUv;
        
        void main() {
          vec2 uv = vUv * 2.0 - 1.0;
          float dist = length(uv);
          
          vec3 topColor = vec3(1.0, 0.9, 0.2);  // Yellow/Orange
          vec3 bottomColor = vec3(1.0, 0.0, 0.6); // Hot Pink
          vec3 color = mix(bottomColor, topColor, vUv.y + 0.5);
          
          // Retro sun slices
          float slice = sin(uv.y * 30.0 - iTime * 2.0);
          float alpha = 1.0;
          
          // Cut out stripes at the bottom
          if (uv.y < 0.2 && slice < 0.0) {
            alpha = 0.0;
          }
          
          // Flash on high frequencies
          color += vec3(1.0) * uAudioHigh * 1.5;
          
          // Circular mask
          if (dist > 1.0) {
            alpha = 0.0;
          } else {
            // Soft edge glow
            alpha *= smoothstep(1.0, 0.95, dist);
          }
          
          gl_FragColor = vec4(color, alpha);
        }
      `
    });

    this.sun = new THREE.Mesh(geometry, material);
    this.sun.position.set(0, 2, -40);
    this.scene.add(this.sun);
  }

  createLaserGrid() {
    // Large grid extending to the horizon
    const geometry = new THREE.PlaneGeometry(80, 80, 100, 100);
    geometry.rotateX(-Math.PI / 2);
    
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      wireframe: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float iTime;
        uniform float uAudioLevel;
        
        varying vec2 vUv;
        varying float vHeight;
        
        // Simple 2D Noise
        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }
        
        float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        
        void main() {
          vUv = uv;
          vec3 pos = position;
          
          // Move the terrain towards the camera
          vec2 scrollPos = pos.xz - vec2(0.0, iTime * 8.0);
          
          // Generate terrain mountains
          float n = noise(scrollPos * 0.1) * 2.0;
          n += noise(scrollPos * 0.25) * 0.5; // add detail
          
          // Flat road in the center, mountains on the side
          float canyon = smoothstep(3.0, 15.0, abs(pos.x));
          
          // Audio directly influences the mountain heights
          float height = n * canyon * (2.0 + uAudioLevel * 8.0);
          
          // Entire grid pulses with the bass
          height += uAudioLevel * 0.5;
          
          pos.y += height;
          vHeight = height;
          
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform float iTime;
        uniform float uAudioLevel;
        uniform float uAudioHigh;
        
        varying vec2 vUv;
        varying float vHeight;
        
        void main() {
          vec3 neonCyan = vec3(0.0, 1.0, 1.0);
          vec3 neonPink = vec3(1.0, 0.0, 0.8);
          
          // The grid lines change color based on their height
          vec3 color = mix(neonCyan, neonPink, clamp(vHeight * 0.2, 0.0, 1.0));
          
          // High frequencies cause the grid to flash white/cyan
          color += neonCyan * (uAudioHigh * 3.0);
          
          // Distance fade (like fog but purely alpha for the grid)
          float depth = gl_FragCoord.z / gl_FragCoord.w;
          float fade = 1.0 - smoothstep(15.0, 45.0, depth);
          
          gl_FragColor = vec4(color, fade * 0.8);
        }
      `
    });

    // Floor Grid
    this.floor = new THREE.Mesh(geometry, material);
    this.floor.position.y = -1;
    this.scene.add(this.floor);
    
    // Ceiling Grid (Flipped)
    this.ceiling = new THREE.Mesh(geometry, material);
    this.ceiling.position.y = 8;
    this.ceiling.rotation.z = Math.PI; // Flip upside down
    this.scene.add(this.ceiling);
  }

  update(audioData) {
    const time = this.clock.getElapsedTime();
    this.uniforms.iTime.value = time;
    
    if (audioData) {
      // Bass
      let bassSum = 0;
      for (let i = 0; i < 20; i++) {
        bassSum += audioData[i];
      }
      const bassAvg = bassSum / 20 / 255;
      
      // Treble
      let highSum = 0;
      const highStart = Math.min(200, audioData.length - 50);
      for (let i = highStart; i < highStart + 50; i++) {
        highSum += audioData[i];
      }
      const highAvg = highSum / 50 / 255;
      
      this.uniforms.uAudioLevel.value += (bassAvg - this.uniforms.uAudioLevel.value) * 0.2;
      this.uniforms.uAudioHigh.value += (highAvg - this.uniforms.uAudioHigh.value) * 0.2;
    } else {
      this.uniforms.uAudioLevel.value += (0 - this.uniforms.uAudioLevel.value) * 0.05;
      this.uniforms.uAudioHigh.value += (0 - this.uniforms.uAudioHigh.value) * 0.05;
    }

    // Mouse movement slightly pans the camera for a parallax effect
    const mouseX = (this.uniforms.iMouse.value.x / window.innerWidth) - 0.5;
    const mouseY = (this.uniforms.iMouse.value.y / window.innerHeight) - 0.5;
    
    this.camera.position.x += (mouseX * 4.0 - this.camera.position.x) * 0.05;
    this.camera.position.y += (1.0 + mouseY * 2.0 - this.camera.position.y) * 0.05;
    this.camera.lookAt(0, 1, -40); // Look at the sun
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.uniforms.iResolution.value.set(window.innerWidth, window.innerHeight, 1);
  }
}

