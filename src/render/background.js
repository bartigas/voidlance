/**
 * Deep-space backdrop: three parallax star layers, painted nebula veils and a
 * slow drifting dust field. Everything is generated from noise at load time —
 * no textures ship with the game.
 */

import * as THREE from 'three';

function noise2D(seed) {
  // Tiny value-noise, good enough for cloud shapes.
  const h = (x, y) => {
    let n = x * 374761393 + y * 668265263 + seed * 1442695041;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  };
  const smooth = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = h(xi, yi);
    const b = h(xi + 1, yi);
    const c = h(xi, yi + 1);
    const d = h(xi + 1, yi + 1);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  };
  return (x, y, octaves = 4) => {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i += 1) {
      sum += smooth(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  };
}

function nebulaTexture(seed, hueA, hueB, size = 256) {
  const n = noise2D(seed);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const ca = new THREE.Color(hueA);
  const cb = new THREE.Color(hueB);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let f = n(u * 3.2, v * 3.2, 5);
      // radial falloff keeps the quad from showing a hard edge
      const dx = u - 0.5;
      const dy = v - 0.5;
      const fall = Math.max(0, 1 - (dx * dx + dy * dy) * 3.6);
      f = Math.pow(Math.max(0, f - 0.34) / 0.66, 1.6) * fall;
      const i = (y * size + x) * 4;
      const mixT = n(u * 1.7 + 5, v * 1.7 - 3, 2);
      const r = ca.r * (1 - mixT) + cb.r * mixT;
      const g = ca.g * (1 - mixT) + cb.g * mixT;
      const b = ca.b * (1 - mixT) + cb.b * mixT;
      img.data[i] = Math.min(255, r * 255 * 1.25);
      img.data[i + 1] = Math.min(255, g * 255 * 1.25);
      img.data[i + 2] = Math.min(255, b * 255 * 1.25);
      img.data[i + 3] = Math.min(255, f * 235);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function starTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(220,240,255,0.75)');
  grd.addColorStop(0.6, 'rgba(140,190,255,0.18)');
  grd.addColorStop(1, 'rgba(80,120,200,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  // diffraction spikes on the brighter ones
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(32, 6);
  g.lineTo(32, 58);
  g.moveTo(6, 32);
  g.lineTo(58, 32);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Background {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.frustumCulled = false;
    this.items = [];

    const bg = new THREE.Color(0x03060c);
    scene.background = bg;
    scene.fog = new THREE.FogExp2(0x050a14, 0.0075);

    this.starTex = starTexture();
    this.items.push(this.starTex);

    // Star layers at increasing depth / decreasing size.
    const layers = [
      { count: 1400, radius: 320, size: 2.6, opacity: 0.95 },
      { count: 1800, radius: 240, size: 1.7, opacity: 0.7 },
      { count: 900, radius: 170, size: 1.1, opacity: 0.5 },
    ];
    this.starLayers = layers.map((cfg, li) => {
      const pos = new Float32Array(cfg.count * 3);
      const col = new Float32Array(cfg.count * 3);
      const tmp = new THREE.Color();
      for (let i = 0; i < cfg.count; i += 1) {
        // distribute on a shell biased toward the camera's viewing hemisphere
        const t = Math.random() * Math.PI * 2;
        const p = Math.acos(1 - 2 * Math.random());
        const r = cfg.radius * (0.85 + Math.random() * 0.3);
        pos[i * 3] = r * Math.sin(p) * Math.cos(t);
        pos[i * 3 + 1] = r * Math.cos(p) * 0.55 + 30;
        pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
        const warm = Math.random();
        tmp.setHSL(warm > 0.86 ? 0.08 : 0.58 - Math.random() * 0.08, 0.55, 0.62 + Math.random() * 0.3);
        col[i * 3] = tmp.r;
        col[i * 3 + 1] = tmp.g;
        col[i * 3 + 2] = tmp.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mat = new THREE.PointsMaterial({
        size: cfg.size,
        map: this.starTex,
        vertexColors: true,
        transparent: true,
        opacity: cfg.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: li > 0,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      this.root.add(pts);
      this.items.push(geo, mat);
      return pts;
    });

    // Nebula veils, big and slow, sitting behind the battlefield.
    const veils = [
      { seed: 11, a: 0x1b3f7a, b: 0x8a2f6b, scale: 460, pos: [-140, 40, -250], rot: 0.2, op: 0.5 },
      { seed: 47, a: 0x0e5c63, b: 0x2b3d8f, scale: 380, pos: [180, -20, -210], rot: -0.35, op: 0.42 },
      { seed: 83, a: 0x6a2350, b: 0x1d2a6b, scale: 300, pos: [10, 90, 260], rot: 1.1, op: 0.3 },
    ];
    this.veils = veils.map((cfg) => {
      const tex = nebulaTexture(cfg.seed, cfg.a, cfg.b);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: cfg.op,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(cfg.scale, cfg.scale), mat);
      mesh.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      mesh.rotation.z = cfg.rot;
      mesh.frustumCulled = false;
      mesh.renderOrder = -10;
      this.root.add(mesh);
      this.items.push(tex, mat, mesh.geometry);
      return { mesh, mat, base: cfg.op };
    });

    // Dust motes drifting through the battlefield volume — sells the 3D.
    const dustCount = 420;
    const dpos = new Float32Array(dustCount * 3);
    this.dustVel = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i += 1) {
      dpos[i * 3] = (Math.random() - 0.5) * 90;
      dpos[i * 3 + 1] = Math.random() * 22 - 3;
      dpos[i * 3 + 2] = (Math.random() - 0.5) * 70;
      this.dustVel[i * 3] = (Math.random() - 0.5) * 0.5;
      this.dustVel[i * 3 + 1] = -0.15 - Math.random() * 0.25;
      this.dustVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    }
    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    const dmat = new THREE.PointsMaterial({
      size: 0.22,
      map: this.starTex,
      color: 0x8fb7ff,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.dust = new THREE.Points(dgeo, dmat);
    this.dust.frustumCulled = false;
    this.root.add(this.dust);
    this.items.push(dgeo, dmat);

    scene.add(this.root);
  }

  update(dt, elapsed, camera) {
    this.starLayers[0].rotation.y = elapsed * 0.0035;
    this.starLayers[1].rotation.y = -elapsed * 0.0021;
    this.starLayers[2].rotation.y = elapsed * 0.0012;
    for (const v of this.veils) {
      v.mesh.rotation.z += dt * 0.004;
      if (v.mat.opacity > v.base) v.mat.opacity = Math.max(v.base, v.mat.opacity - dt * 0.7);
    }
    if (camera) this.root.position.set(camera.position.x * 0.55, 0, camera.position.z * 0.55);

    const attr = this.dust.geometry.getAttribute('position');
    const a = attr.array;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += this.dustVel[i] * dt;
      a[i + 1] += this.dustVel[i + 1] * dt;
      a[i + 2] += this.dustVel[i + 2] * dt;
      if (a[i + 1] < -6) {
        a[i + 1] = 20;
        a[i] = (Math.random() - 0.5) * 90;
        a[i + 2] = (Math.random() - 0.5) * 70;
      }
    }
    attr.needsUpdate = true;
  }

  /** Brightness kick for explosions: brief additive flash on the veils. */
  flash(strength = 1) {
    for (const v of this.veils) v.mat.opacity = Math.min(v.base + 0.4, v.mat.opacity + 0.25 * strength);
  }

  dispose() {
    for (const it of this.items) it?.dispose?.();
    this.scene.remove(this.root);
    this.scene.fog = null;
  }
}
