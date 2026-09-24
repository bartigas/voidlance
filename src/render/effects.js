/**
 * Battle VFX: tracers, beams, torpedo runs, missile arcs, impacts, shield
 * collapses, explosions and floating numbers. Everything is a tween over a
 * pooled object, so the render loop only ever walks one flat array.
 */

import * as THREE from 'three';

const KIND_COLOR = {
  kinetic: 0xfff0b8,
  energy: 0x7ce8ff,
  torpedo: 0xffb066,
  missile: 0xff7ad9,
};

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

function orient(mesh, from, to) {
  tmpA.copy(to).sub(from);
  const len = tmpA.length() || 0.001;
  mesh.position.copy(from).addScaledVector(tmpA, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmpA.clone().normalize());
  mesh.scale.set(1, len, 1);
  return len;
}

const NUM_CACHE = new Map();
function numberTexture(text, css) {
  const key = text + '|' + css;
  const hit = NUM_CACHE.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  g.font = '700 74px ui-monospace, "DejaVu Sans Mono", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(2,5,10,0.9)';
  g.strokeText(text, 128, 66);
  const grd = g.createLinearGradient(0, 20, 0, 110);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.45, css);
  grd.addColorStop(1, css);
  g.fillStyle = grd;
  g.fillText(text, 128, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (NUM_CACHE.size > 90) {
    const [k, v] = NUM_CACHE.entries().next().value;
    v.dispose?.();
    NUM_CACHE.delete(k);
  }
  NUM_CACHE.set(key, tex);
  return tex;
}

function glowSpriteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(48, 48, 0, 48, 48, 46);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,240,210,0.55)');
  grd.addColorStop(0.7, 'rgba(255,150,90,0.16)');
  grd.addColorStop(1, 'rgba(255,90,40,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 96, 96);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.tweens = [];
    this.root = new THREE.Group();
    this.root.frustumCulled = false;
    scene.add(this.root);

    this.glow = glowSpriteTexture();
    this.cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    this.sphere = new THREE.SphereGeometry(1, 18, 12);
    this.ringGeo = new THREE.RingGeometry(0.86, 1, 48);
    this.shardGeo = new THREE.TetrahedronGeometry(1, 0);
    this.light = new THREE.PointLight(0xffd9a0, 0, 40, 2);
    this.light.visible = false;
    scene.add(this.light);
    this.lightT = 0;
  }

  get busy() {
    return this.tweens.length > 0;
  }

  add(obj, dur, step, done) {
    this.root.add(obj);
    const t = { obj, t: 0, dur, step, done };
    this.tweens.push(t);
    return t;
  }

  disposeObj(obj) {
    this.root.remove(obj);
    const mats = [];
    obj.traverse?.((o) => {
      if (o.material) mats.push(o.material);
    });
    if (obj.material) mats.push(obj.material);
    for (const m of mats) {
      // Textures are cached or shared; only per-shot materials get released.
      if (m.userData?.own) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    }
  }

  addSprite(color, scale = 1) {
    const m = new THREE.SpriteMaterial({
      map: this.glow,
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    m.userData.own = true;
    const s = new THREE.Sprite(m);
    s.scale.setScalar(scale);
    s.renderOrder = 6;
    return s;
  }

  addMesh(geo, color, { opacity = 1, blending = THREE.AdditiveBlending } = {}) {
    const m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    m.userData.own = true;
    return new THREE.Mesh(geo, m);
  }

  /** Muzzle flash at the firing ship. */
  muzzle(from, dir, color = KIND_COLOR.kinetic, size = 1) {
    const s = this.addSprite(color, 1.2 * size);
    s.position.copy(from);
    this.add(s, 0.22, (k) => {
      s.scale.setScalar((0.5 + k * 1.9) * size);
      s.material.opacity = (1 - k) * 0.95;
    });
    const streak = this.addMesh(this.cyl, color, { opacity: 0.85 });
    streak.scale.set(0.09 * size, 1.4 * size, 0.09);
    streak.position.copy(from).addScaledVector(dir, 0.7);
    streak.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    this.add(streak, 0.18, (k) => {
      streak.material.opacity = 0.85 * (1 - k);
      streak.scale.x = 0.09 * size * (1 - k * 0.6);
    });
  }

  /**
   * One weapon shot's travel visual.
   * @returns {number} seconds until impact
   */
  shot(kind, from, to, { crit = false, color = null } = {}) {
    const c = color ?? KIND_COLOR[kind] ?? KIND_COLOR.kinetic;
    const dist = from.distanceTo(to);
    if (kind === 'kinetic') {
      const speed = 105;
      const dur = Math.max(0.09, dist / speed);
      const bolts = 2;
      for (let i = 0; i < bolts; i += 1) {
        const bolt = this.addMesh(this.cyl, c, { opacity: 0.95 });
        bolt.scale.set(crit ? 0.09 : 0.06, 1.5, 1);
        const delay = i * 0.05;
        this.add(bolt, dur + delay, (k, dt) => {
          const p = THREE.MathUtils.clamp((k * (dur + delay) - delay) / dur, 0, 1);
          tmpA.copy(from).lerp(to, p);
          tmpB.copy(from).lerp(to, Math.max(0, p - 0.09));
          orient(bolt, tmpB, tmpA);
          bolt.scale.x = (crit ? 0.09 : 0.06) * (0.7 + 0.6 * Math.sin(p * Math.PI));
          bolt.material.opacity = 0.55 + 0.45 * Math.sin(p * Math.PI);
        });
      }
      return dur;
    }
    if (kind === 'energy') {
      const dur = Math.max(0.26, dist / 210);
      const beam = this.addMesh(this.cyl, c, { opacity: 0.0 });
      this.add(beam, dur * 2.4, (k) => {
        orient(beam, from, to);
        const grow = THREE.MathUtils.clamp(k / 0.25, 0, 1);
        const fade = THREE.MathUtils.clamp((k - 0.25) / 0.75, 0, 1);
        beam.scale.x = (crit ? 0.34 : 0.22) * grow * (1 - fade * 0.55);
        beam.scale.z = beam.scale.x;
        beam.material.opacity = (1 - fade) * (crit ? 0.95 : 0.8);
      });
      const core = this.addMesh(this.cyl, 0xffffff, { opacity: 0.9 });
      this.add(core, dur * 1.5, (k) => {
        orient(core, from, to);
        core.scale.x = 0.06 * (1 - k);
        core.scale.z = core.scale.x;
        core.material.opacity = 0.9 * (1 - k);
      });
      const flare = this.addSprite(c, 1.6);
      flare.position.copy(from);
      this.add(flare, dur * 1.4, (k) => {
        flare.scale.setScalar(1.6 + k * 2.4);
        flare.material.opacity = 0.9 * (1 - k);
      });
      return dur;
    }
    // torpedo / missile: a physical projectile with a smoke trail
    const speed = kind === 'torpedo' ? 26 : 34;
    const arc = kind === 'torpedo' ? Math.min(3.2, dist * 0.1) : Math.min(9.5, dist * 0.34);
    const mid = tmpA.copy(from).lerp(to, 0.5).clone();
    mid.y += arc;
    const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
    const dur = Math.max(0.45, curve.getLength() / speed);
    const body = this.addMesh(this.shardGeo, c);
    body.scale.set(0.14, 0.38, 0.14);
    const flame = this.addSprite(0xffc978, 0.7);
    const spin = kind === 'torpedo' ? 9 : 14;
    let lastPuff = 0;
    this.add(body, dur, (k, dt) => {
      const p = THREE.MathUtils.clamp(k, 0, 1);
      const pos = curve.getPoint(p);
      const ahead = curve.getPoint(Math.min(1, p + 0.02));
      body.position.copy(pos);
      body.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ahead.sub(pos).normalize());
      body.rotation.z += dt * spin;
      flame.position.copy(curve.getPoint(Math.max(0, p - 0.03)));
      flame.scale.setScalar(0.55 + Math.sin(p * 22) * 0.12);
      flame.material.opacity = 0.85;
      lastPuff += dt;
      if (lastPuff > 0.035) {
        lastPuff = 0;
        const puff = this.addSprite(kind === 'torpedo' ? 0xffa860 : 0xff9ce0, 0.5);
        puff.position.copy(pos);
        this.add(puff, 0.5, (kk) => {
          puff.scale.setScalar(0.4 + kk * 1.5);
          puff.material.opacity = 0.5 * (1 - kk);
        });
      }
    });
    this.add(flame, dur, (k) => {
      flame.material.opacity = k < 1 ? 0.85 : 0;
    });
    return dur;
  }

  /** Impact burst on a hull; `channel` picks shield vs armour colours. */
  impact(at, { kind = 'kinetic', crit = false, shield = 0, hull = 0, size = 1 } = {}) {
    const shieldHit = shield > 0;
    const color = shieldHit ? 0x6fd8ff : kind === 'energy' ? 0xb9f4ff : 0xffc06a;
    const flash = this.addSprite(shieldHit ? 0x9fe8ff : 0xffe6b0, 1.4 * size);
    flash.position.copy(at);
    this.add(flash, 0.3, (k) => {
      flash.scale.setScalar((1.2 + k * 3.2) * size);
      flash.material.opacity = (1 - k) * 0.95;
    });

    // Spark cone: a handful of stretched quads flying outward.
    const n = Math.min(16, 6 + Math.round((crit ? 10 : 5) + hull / 6));
    for (let i = 0; i < n; i += 1) {
      const spark = this.addMesh(this.cyl, shieldHit ? 0x9fe8ff : 0xffd08a, { opacity: 1 });
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize();
      const speed = (2.4 + Math.random() * 4.5) * size;
      spark.position.copy(at);
      this.add(spark, 0.26 + Math.random() * 0.24, (k) => {
        spark.position.copy(at).addScaledVector(dir, speed * k * 0.5);
        spark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        spark.scale.set(0.035 * (1 - k), 0.45 * (1 - k * 0.5) * size, 0.035);
        spark.material.opacity = 1 - k;
      });
    }

    // Shockwave ring, flat on the deck.
    const ring = this.addMesh(this.ringGeo, color);
    ring.position.copy(at);
    ring.rotation.x = -Math.PI / 2;
    this.add(ring, 0.45, (k) => {
      ring.scale.setScalar((0.3 + k * 2.6) * size);
      ring.material.opacity = (1 - k) * 0.85;
    });

    if (crit) {
      const burst = this.addSprite(0xfff4d0, 2);
      burst.position.copy(at);
      this.add(burst, 0.42, (k) => {
        burst.scale.setScalar(2 + k * 5);
        burst.material.opacity = (1 - k) ** 1.5;
      });
    }
    if (shieldHit && shield > 14) this.shieldPop(at, size * 1.2);
  }

  /** Expanding hemisphere of a collapsing shield. */
  shieldPop(at, size = 1) {
    const dome = this.addMesh(this.sphere, 0x7fdcff, { opacity: 0.5 });
    dome.position.copy(at);
    this.add(dome, 0.55, (k) => {
      dome.scale.set((0.6 + k * 1.5) * size, (0.4 + k * 1.0) * size, (0.6 + k * 1.5) * size);
      dome.material.opacity = 0.5 * (1 - k) * (1 - k);
    });
  }

  damageNumber(at, value, { crit = false, heal = false, shield = false } = {}) {
    const text = (heal ? '+' : '') + (Number.isFinite(value) ? Math.round(Math.abs(value)) : value);
    const css = heal ? '#7df2b6' : shield ? '#7cd2ff' : crit ? '#ffb03a' : '#ffe9c9';
    const tex = numberTexture((heal ? '+' : '') + text, css);
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const s = new THREE.Sprite(m);
    s.scale.set(1.9, 0.95, 1);
    s.position.copy(at);
    s.position.y += 0.6;
    s.renderOrder = 20;
    const drift = (Math.random() - 0.5) * 0.5;
    this.add(s, crit ? 1.5 : 1.15, (k) => {
      s.position.y += 0.016;
      s.position.x += drift * 0.01;
      const pop = k < 0.14 ? 0.6 + (k / 0.14) * 0.6 : 1.2 - (k - 0.14) * 0.12;
      s.scale.set(1.9 * pop, 0.95 * pop, 1);
      m.opacity = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
    });
  }

  /** Death: core flash, expanding sphere, shards, light kick, ground ring. */
  explode(at, { size = 1, color = 0xffb066 } = {}) {
    const core = this.addSprite(0xfff2d6, 3 * size);
    core.position.copy(at);
    this.add(core, 0.5, (k) => {
      core.scale.setScalar((2.4 + k * 5.4) * size);
      core.material.opacity = (1 - k) ** 1.2;
    });

    const ball = this.addMesh(this.sphere, color);
    ball.position.copy(at);
    this.add(ball, 0.75, (k) => {
      ball.scale.setScalar((0.3 + k * 2.2) * size);
      ball.material.opacity = 0.75 * (1 - k) ** 1.6;
    });

    const shards = 14;
    for (let i = 0; i < shards; i += 1) {
      const sh = this.addMesh(this.shardGeo, i % 3 === 0 ? 0xffd9a0 : 0x6f7686);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.15, Math.random() - 0.5).normalize();
      const speed = (6 + Math.random() * 12) * size;
      const spin = new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(9);
      sh.position.copy(at);
      sh.scale.setScalar((0.1 + Math.random() * 0.16) * size);
      this.add(sh, 1.1 + Math.random() * 0.5, (k, dt) => {
        sh.position.addScaledVector(dir, speed * dt * (1 - k));
        sh.rotation.x += spin.x * dt;
        sh.rotation.y += spin.y * dt;
        sh.material.opacity = 1 - k;
      });
    }

    const wave = this.addMesh(this.ringGeo, 0xffc48a);
    wave.position.copy(at);
    wave.rotation.x = -Math.PI / 2;
    this.add(wave, 1.1, (k) => {
      // Kept just wider than the wreck's own hex and its ring of neighbours.
      // Reaching further buries the board in overlapping donuts at 4x speed.
      wave.scale.setScalar((0.5 + k * 4.1) * size);
      wave.material.opacity = 0.8 * (1 - k);
    });

    this.light.position.copy(at);
    this.light.position.y += 0.6;
    this.light.color.setHex(color);
    this.light.intensity = 55 * size;
    this.light.distance = 34 * size;
    this.light.visible = true;
    this.lightT = 0.5;
    this.add(new THREE.Object3D(), 0.5, (k) => {
      this.light.intensity = 55 * size * (1 - k) ** 2;
    });
  }

  /** Expanding hex ring used by phase shift / system runs. */
  warp(at, { color = 0xb98cff, size = 1 } = {}) {
    for (let i = 0; i < 3; i += 1) {
      const ring = this.addMesh(this.ringGeo, color);
      ring.position.copy(at);
      ring.rotation.x = -Math.PI / 2;
      this.add(ring, 0.6 + i * 0.1, (k) => {
        ring.scale.setScalar((0.2 + k * (3.2 + i)) * size);
        ring.material.opacity = 0.75 * (1 - k);
      });
    }
    const column = this.addMesh(this.cyl, color, { opacity: 0.6 });
    column.position.copy(at);
    this.add(column, 0.55, (k) => {
      column.scale.set(0.9 * (1 - k) + 0.1, 6, 0.9 * (1 - k) + 0.1);
      column.material.opacity = 0.5 * (1 - k);
    });
  }

  /** Soft column of light for shields going up / repair. */
  aura(at, { color = 0x7dffb1, size = 1 } = {}) {
    const col = this.addMesh(this.cyl, color, { opacity: 0.42 });
    col.position.copy(at);
    this.add(col, 0.7, (k) => {
      col.scale.set((0.8 + k * 0.5) * size, 4.2 * size, (0.8 + k * 0.5) * size);
      col.material.opacity = 0.42 * (1 - k);
    });
    for (let i = 0; i < 8; i += 1) {
      const mote = this.addSprite(color, 0.35);
      const a = (i / 8) * Math.PI * 2;
      const r = 0.9 * size;
      mote.position.set(at.x + Math.cos(a) * r, at.y, at.z + Math.sin(a) * r);
      this.add(mote, 0.8, (k) => {
        mote.position.set(at.x + Math.cos(a) * r * (1 - k * 0.5), at.y + k * 2.4 * size, at.z + Math.sin(a) * r * (1 - k * 0.5));
        mote.material.opacity = 0.85 * (1 - k);
      });
    }
  }

  /** Lock-on reticle that closes in on a target hex. */
  lockRing(at, { color = 0xff6a5e, size = 1, dur = 0.6 } = {}) {
    const ring = this.addMesh(this.ringGeo, color);
    ring.position.copy(at);
    ring.rotation.x = -Math.PI / 2;
    this.add(ring, dur, (k) => {
      ring.scale.setScalar((3.4 - k * 2.1) * size);
      ring.rotation.z += 0.04;
      ring.material.opacity = 0.35 + 0.5 * (1 - k);
    });
  }

  update(dt) {
    if (this.lightT > 0) {
      this.lightT -= dt;
      if (this.lightT <= 0) {
        this.light.visible = false;
        this.light.intensity = 0;
      }
    }
    for (let i = this.tweens.length - 1; i >= 0; i -= 1) {
      const t = this.tweens[i];
      t.t += dt;
      const k = Math.min(1, t.t / t.dur);
      try {
        t.step(k, dt);
      } catch {
        t.t = t.dur;
      }
      if (k >= 1) {
        t.done?.();
        this.disposeObj(t.obj);
        this.tweens.splice(i, 1);
      }
    }
  }

  clear() {
    for (const t of this.tweens) this.disposeObj(t.obj);
    this.tweens.length = 0;
    this.light.visible = false;
    this.light.intensity = 0;
  }

  dispose() {
    this.clear();
    this.glow.dispose?.();
    this.cyl.dispose();
    this.sphere.dispose();
    this.ringGeo.dispose();
    this.shardGeo.dispose();
    this.scene.remove(this.root);
  }
}
