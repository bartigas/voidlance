/**
 * Procedural ship meshes. Every hull is assembled from primitives at runtime —
 * no binary assets — with a distinct silhouette per class so the battlefield
 * reads at a glance: the dreadnought is a slab, the destroyer a needle, the
 * corvette a dart.
 *
 * Convention: the bow points along local +x, so `group.rotation.y =
 * DIR_YAW[facing]` (see core/hex.js) aims a ship down a hex direction.
 */

import * as THREE from 'three';
import { DIR_YAW } from '../core/hex.js';

export const TEAM_COLORS = { player: 0x5fd8ff, enemy: 0xff5566 };

const HULL_DARK = 0x232a35;
const HULL_MID = 0x39424f;
const PLATE = 0x151a22;

const CACHE = new Map();

function mix(a, b, t) {
  const ca = new THREE.Color(a);
  ca.lerp(new THREE.Color(b), t);
  return ca.getHex();
}

function std(color, { metal = 0.78, rough = 0.42, emissive = 0x000000, ei = 1, flat = false } = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: metal,
    roughness: rough,
    emissive,
    emissiveIntensity: ei,
    flatShading: flat,
  });
}

function add(parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = false;
  m.receiveShadow = false;
  parent.add(m);
  return m;
}

const GEO = {
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  cyl: (a, b, h, s = 12) => new THREE.CylinderGeometry(a, b, h, s),
  cone: (r, h, s = 12) => new THREE.ConeGeometry(r, h, s),
  sph: (r, s = 14) => new THREE.SphereGeometry(r, s, Math.max(8, s - 4)),
  torus: (r, t, s = 6, ts = 20) => new THREE.TorusGeometry(r, t, s, ts),
  oct: (r) => new THREE.OctahedronGeometry(r, 0),
};

// Shield bubble: fresnel rim so it glows at grazing angles and stays nearly
// invisible head-on, which is what a deflector shield actually looks like.
const SHIELD_VS = `
varying vec3 vN; varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const SHIELD_FS = `
uniform vec3 uColor; uniform float uOpacity; uniform float uPulse;
varying vec3 vN; varying vec3 vV;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  f = pow(f, 2.4);
  float a = (0.06 + f * 0.85) * uOpacity * (0.82 + 0.18 * sin(uPulse));
  gl_FragColor = vec4(uColor * (0.35 + f * 1.55), a);
}`;

/** Bow-forward silhouette per class. Returns meshes in ship-local space. */
const BUILDERS = {
  BULWARK(g, hull, plate, accent) {
    add(g, GEO.box(2.5, 0.44, 1.05), hull, 0, 0, 0);
    add(g, GEO.box(1.1, 0.3, 1.4), plate, -0.15, 0.3, 0);
    add(g, GEO.box(0.5, 0.26, 0.62), hull, 0.95, 0.3, 0);
    // broadside battery sponsons
    for (const s of [-1, 1]) {
      add(g, GEO.box(1.5, 0.24, 0.3), plate, 0.1, 0.05, s * 0.72);
      add(g, GEO.cyl(0.13, 0.15, 0.7, 8), hull, 0.6, 0.06, s * 0.86, 0, 0, Math.PI / 2);
      add(g, GEO.box(0.24, 0.5, 0.24), accent, -0.5, 0.42, s * 0.5);
    }
    add(g, GEO.box(0.34, 0.62, 0.34), accent, -0.2, 0.6, 0);
    add(g, GEO.cone(0.42, 0.9, 6), hull, 1.55, 0, 0, 0, 0, -Math.PI / 2);
    for (const s of [-1, 1]) {
      add(g, GEO.cyl(0.26, 0.3, 0.5, 10), plate, -1.35, 0, s * 0.42, 0, 0, Math.PI / 2);
    }
  },
  WARDEN(g, hull, plate, accent) {
    add(g, GEO.cyl(0.6, 0.6, 1.9, 12), hull, 0, 0, 0, 0, 0, Math.PI / 2);
    add(g, GEO.sph(0.6, 12), hull, 0.95, 0, 0).scale.set(1.15, 0.75, 1);
    add(g, GEO.torus(0.95, 0.09, 6, 22), plate, -0.1, 0, 0, 0, 0, Math.PI / 2);
    add(g, GEO.torus(0.95, 0.045, 6, 22), accent, 0.35, 0, 0, 0, 0, Math.PI / 2);
    add(g, GEO.box(0.7, 0.2, 0.16), accent, 0.2, 0.62, 0);
    add(g, GEO.box(0.16, 0.2, 0.7), accent, 0.2, 0.62, 0);
    add(g, GEO.box(0.5, 0.3, 0.5), plate, -0.8, 0.32, 0);
    for (const s of [-1, 1]) add(g, GEO.cyl(0.2, 0.24, 0.42, 9), plate, -1.1, 0, s * 0.5, 0, 0, Math.PI / 2);
    add(g, GEO.cone(0.3, 0.55, 8), hull, 1.5, 0, 0, 0, 0, -Math.PI / 2);
  },
  TEMPEST(g, hull, plate, accent) {
    add(g, GEO.box(1.9, 0.5, 0.9), hull, 0, 0, 0);
    add(g, GEO.box(0.9, 0.46, 0.8), plate, -0.15, 0.44, 0);
    // missile cell block: a honeycomb of tubes on the back
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        add(g, GEO.cyl(0.1, 0.1, 0.34, 8), plate, -0.5 + i * 0.3, 0.5, -0.18 + j * 0.36, Math.PI / 9, 0, 0);
        add(g, GEO.cyl(0.07, 0.07, 0.05, 8), accent, -0.5 + i * 0.3, 0.62, -0.18 + j * 0.36, Math.PI / 9, 0, 0);
      }
    }
    add(g, GEO.box(0.4, 0.26, 0.5), hull, 1.15, 0.24, 0);
    add(g, GEO.cone(0.34, 0.8, 6), hull, 1.5, 0, 0, 0, 0, -Math.PI / 2);
    for (const s of [-1, 1]) {
      add(g, GEO.box(0.7, 0.16, 0.2), plate, -0.1, -0.05, s * 0.62);
      add(g, GEO.cyl(0.22, 0.26, 0.44, 10), plate, -1.15, 0, s * 0.34, 0, 0, Math.PI / 2);
    }
  },
  LANCE(g, hull, plate, accent) {
    add(g, GEO.box(1.5, 0.34, 0.56), hull, 0.1, 0, 0);
    add(g, GEO.cone(0.36, 1.25, 6), hull, 1.25, 0, 0, 0, 0, -Math.PI / 2);
    // torpedo rails running along the flanks
    for (const s of [-1, 1]) {
      add(g, GEO.box(1.5, 0.12, 0.12), plate, 0.2, 0.02, s * 0.4);
      add(g, GEO.cyl(0.08, 0.08, 0.2, 8), accent, 0.95, 0.02, s * 0.4, 0, 0, Math.PI / 2);
      add(g, GEO.box(0.36, 0.3, 0.14), plate, -0.55, 0.24, s * 0.3);
    }
    add(g, GEO.box(0.42, 0.3, 0.36), hull, -0.55, 0.3, 0);
    add(g, GEO.box(0.1, 0.1, 0.62), accent, -0.2, 0.5, 0);
    add(g, GEO.cyl(0.3, 0.36, 0.6, 12), plate, -1.05, 0, 0, 0, 0, Math.PI / 2);
  },
  REVENANT(g, hull, plate, accent) {
    const core = add(g, GEO.oct(0.72), hull, 0.05, 0, 0);
    core.scale.set(1.55, 0.5, 1);
    add(g, GEO.box(0.6, 0.16, 0.34), plate, -0.2, 0.3, 0);
    add(g, GEO.cone(0.26, 0.7, 4), hull, 1.05, 0, 0, 0, 0, -Math.PI / 2);
    // ECM masts + dish
    for (const s of [-1, 1]) {
      add(g, GEO.box(0.06, 0.5, 0.06), plate, -0.35, 0.4, s * 0.3);
      add(g, GEO.sph(0.06, 6), accent, -0.35, 0.66, s * 0.3);
    }
    add(g, GEO.sph(0.24, 10, 0, Math.PI * 2, 0, Math.PI / 2.1), accent, -0.75, 0.44, 0, Math.PI / 2.6, 0, 0);
    add(g, GEO.box(0.9, 0.08, 0.14), plate, 0.15, -0.22, 0);
    add(g, GEO.cyl(0.22, 0.26, 0.4, 10), plate, -0.95, 0, 0, 0, 0, Math.PI / 2);
  },
};

function nameplateTexture(ship, teamColorCss) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 64);
  g.fillStyle = 'rgba(6,10,16,0.62)';
  g.strokeStyle = teamColorCss;
  g.lineWidth = 2;
  const r = 10;
  g.beginPath();
  g.moveTo(14 + r, 10);
  g.arcTo(242, 10, 242, 46, r);
  g.arcTo(242, 54, 14, 54, r);
  g.arcTo(14, 54, 14, 10, r);
  g.arcTo(14, 10, 242, 10, r);
  g.closePath();
  g.fill();
  g.stroke();
  g.font = '600 24px ui-monospace, "DejaVu Sans Mono", monospace';
  g.textBaseline = 'middle';
  g.fillStyle = teamColorCss;
  g.fillText(ship.glyph, 24, 33);
  g.fillStyle = '#dfe9f5';
  g.fillText(ship.cls.name.slice(0, 9).toUpperCase(), 58, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build the display group for one ship record.
 * @param {object} ship live ship state (needs cls, accent, team, glyph)
 */
export function createShipMesh(ship) {
  const teamColor = TEAM_COLORS[ship.team] ?? 0xffffff;
  const accent = ship.team === 'enemy' ? mix(ship.accent, 0xff3b4d, 0.45) : ship.accent;

  const hull = std(ship.team === 'enemy' ? mix(HULL_DARK, 0x3a1c22, 0.5) : HULL_DARK, { rough: 0.46 });
  const plate = std(PLATE, { metal: 0.9, rough: 0.55 });
  const accentMat = std(accent, { metal: 0.25, rough: 0.3, emissive: accent, ei: 1.7 });

  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const build = BUILDERS[ship.classId] || BUILDERS.LANCE;
  build(body, hull, plate, accentMat);

  // Engine glow: additive quads at the stern that pulse with thrust.
  const engineGroup = new THREE.Group();
  const glowMat = new THREE.MeshBasicMaterial({
    color: ship.team === 'enemy' ? mix(teamColor, accent, 0.5) : teamColor,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const stern = ship.classId === 'BULWARK' ? -1.7 : ship.classId === 'LANCE' ? -1.4 : -1.2;
  const offsets = ship.classId === 'BULWARK' || ship.classId === 'TEMPEST' ? [-0.42, 0.42] : [0];
  for (const z of offsets) {
    const flame = add(engineGroup, GEO.cone(0.2, 0.95, 10), glowMat, stern - 0.35, 0, z, 0, 0, Math.PI / 2);
    flame.renderOrder = 3;
  }
  body.add(engineGroup);

  // Rotating sensor bar.
  const radar = new THREE.Group();
  add(radar, GEO.box(0.02, 0.36, 0.02), plate, 0, 0.18, 0);
  add(radar, GEO.box(0.44, 0.03, 0.06), accentMat, 0, 0.36, 0);
  radar.position.set(ship.classId === 'REVENANT' ? -0.2 : 0.25, 0.42, 0);
  body.add(radar);

  // Navigation blink lights.
  const blinkA = new THREE.MeshBasicMaterial({ color: 0xff5c6e, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
  const blinkB = new THREE.MeshBasicMaterial({ color: 0x6effa8, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
  add(body, GEO.sph(0.055, 6), blinkA, 0.1, 0.05, -0.62).renderOrder = 4;
  add(body, GEO.sph(0.055, 6), blinkB, 0.1, 0.05, 0.62).renderOrder = 4;

  // Shield bubble.
  const shieldMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(teamColor) },
      uOpacity: { value: 0.6 },
      uPulse: { value: 0 },
    },
    vertexShader: SHIELD_VS,
    fragmentShader: SHIELD_FS,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const shield = add(body, GEO.sph(1.28, 20), shieldMat, 0.05, 0, 0);
  shield.scale.set(1.35, 0.72, 1.05);
  shield.visible = false;

  // Selection / target ring drawn flat on the battlefield plane.
  const ringMat = new THREE.MeshBasicMaterial({
    color: teamColor,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.55, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  ring.visible = false;
  group.add(ring);

  // Threat marker ring (used on enemy ships inside the player's firing lines).
  const threatRing = new THREE.Mesh(
    new THREE.RingGeometry(1.6, 1.72, 40),
    new THREE.MeshBasicMaterial({ color: 0xff3b4d, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  threatRing.rotation.x = -Math.PI / 2;
  threatRing.position.y = 0.05;
  threatRing.visible = false;
  group.add(threatRing);

  // Billboard status: nameplate + hull/shield bars, drawn in screen space so
  // they stay legible whatever the camera pitch.
  const billboard = new THREE.Group();
  billboard.visible = false;
  const css = ship.team === 'enemy' ? '#ff8a94' : '#8fe9ff';
  const plateTex = nameplateTexture(ship, css);
  const nameSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: plateTex, transparent: true, depthTest: false, depthWrite: false }),
  );
  nameSprite.scale.set(2.3, 0.575, 1);
  nameSprite.position.set(0, 1.72, 0);
  nameSprite.renderOrder = 12;
  billboard.add(nameSprite);

  const barBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x060a10, transparent: true, opacity: 0.72, depthTest: false, depthWrite: false }));
  barBg.scale.set(1.5, 0.15, 1);
  barBg.position.set(0, 1.36, 0);
  barBg.renderOrder = 11;
  billboard.add(barBg);

  const mkBar = (color, y, order) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ color, transparent: true, depthTest: false, depthWrite: false }));
    s.scale.set(1.44, 0.075, 1);
    s.position.set(0, y, 0);
    s.renderOrder = order;
    billboard.add(s);
    return s;
  };
  const hullBar = mkBar(0x63f0a3, 1.4, 12);
  const shieldBar = mkBar(0x59c8ff, 1.31, 12);

  group.add(billboard);

  group.scale.setScalar(ship.cls.scale);
  group.userData = {
    shipId: ship.id,
    team: ship.team,
    body,
    engineGroup,
    glowMat,
    radar,
    blinkA,
    blinkB,
    shield,
    shieldMat,
    ring,
    ringMat,
    threatRing,
    billboard,
    hullBar,
    shieldBar,
    plateTex,
    hull,
    plate,
    accentMat,
    accent,
    hitFlash: 0,
    phase: Math.random() * 10,
  };
  return group;
}

/** Attach the picking proxy: an invisible box that makes thin hulls clickable. */
export function addPickProxy(group, ship) {
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(3.1, 1.5, 1.9),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  box.position.y = 0.2;
  box.userData.pickShipId = ship.id;
  group.add(box);
  return box;
}

/** Per-frame animation: heading, idle drift, engines, radar, blink, bars. */
export function updateShipMesh(group, ship, dt, elapsed, camera) {
  const u = group.userData;
  if (!u || !ship) return;
  // animLock means a scripted move/rotate owns the transform this frame.
  if (!u.animLock) {
    const yaw = DIR_YAW[ship.facing % 6];
    let t = yaw - group.rotation.y;
    while (t > Math.PI) t -= Math.PI * 2;
    while (t < -Math.PI) t += Math.PI * 2;
    group.rotation.y += t * Math.min(1, dt * 5.5);
  }

  const bob = Math.sin(elapsed * 0.8 + u.phase) * 0.045;
  u.body.position.y = 0.34 + bob;
  u.body.rotation.z = Math.sin(elapsed * 0.55 + u.phase) * 0.022;
  u.body.rotation.x = Math.cos(elapsed * 0.43 + u.phase) * 0.016;

  u.radar.rotation.y += dt * 2.1;
  const blink = (elapsed * 1.6 + u.phase) % 1 < 0.5;
  u.blinkA.opacity = blink ? 1 : 0.08;
  u.blinkB.opacity = blink ? 0.08 : 1;

  const thrust = ship.acted ? 0.32 : 1;
  const flick = 0.82 + 0.18 * Math.sin(elapsed * 22 + u.phase);
  u.glowMat.opacity = (0.28 + 0.5 * thrust) * flick;
  u.engineGroup.scale.set(0.8 + 0.5 * thrust * flick, 1, 1);

  const shieldRatio = ship.shieldMax > 0 ? ship.shields / ship.shieldMax : 0;
  u.shield.visible = ship.shields > 0;
  u.shieldMat.uniforms.uOpacity.value = 0.22 + 0.5 * shieldRatio;
  u.shieldMat.uniforms.uPulse.value = elapsed * (2 + 6 * (1 - shieldRatio));

  if (u.hitFlash > 0) {
    u.hitFlash = Math.max(0, u.hitFlash - dt * 3.4);
    const k = u.hitFlash * u.hitFlash;
    u.hull.emissive.setRGB(k, k * 0.75, k * 0.55);
    u.hull.emissiveIntensity = 1.6 * k + 0.05;
  } else if (ship.hull < ship.hullMax * 0.34) {
    const w = 0.5 + 0.5 * Math.sin(elapsed * 5 + u.phase);
    u.hull.emissive.setRGB(0.32 * w, 0.09 * w, 0.03 * w);
    u.hull.emissiveIntensity = 1;
  } else {
    u.hull.emissiveIntensity = 0.02;
    u.hull.emissive.setRGB(0, 0, 0);
  }

  const hullRatio = Math.max(0, ship.hull / ship.hullMax);
  u.hullBar.scale.x = 1.44 * hullRatio;
  u.hullBar.position.x = -0.72 * (1 - hullRatio);
  u.hullBar.material.color.setHex(hullRatio > 0.6 ? 0x63f0a3 : hullRatio > 0.3 ? 0xffc94d : 0xff5566);
  const sr = Math.max(0, shieldRatio);
  u.shieldBar.scale.x = 1.44 * sr;
  u.shieldBar.position.x = -0.72 * (1 - sr);
  u.shieldBar.visible = ship.shields > 0;
  u.billboard.visible = ship.alive;

  if (camera) {
    // Keep the ring flat but the bars readable: billboard group only yaws to
    // the camera so the bars never appear edge-on.
    const dx = camera.position.x - group.position.x;
    const dz = camera.position.z - group.position.z;
    u.billboard.rotation.y = Math.atan2(dx, dz) * 0;
    const dist = Math.hypot(dx, dz);
    const k = THREE.MathUtils.clamp(dist / 42, 0.72, 1.5) / ship.cls.scale;
    u.billboard.scale.setScalar(k);
  }
}

/** Highlight modes: 'selected' | 'target' | 'hover' | null. */
export function setShipHighlight(group, mode) {
  const u = group?.userData;
  if (!u) return;
  u.ring.visible = mode !== null && mode !== undefined;
  if (!u.ring.visible) return;
  const color = mode === 'selected' ? 0x7cf0c8 : mode === 'target' ? 0xff6a5e : u.ringMat.color.getHex();
  u.ringMat.color.setHex(color);
  u.ringMat.opacity = mode === 'hover' ? 0.45 : 0.95;
  u.ring.scale.setScalar(mode === 'selected' ? 1 + Math.sin(performance.now() / 260) * 0.035 : 1);
}

export function setShipThreat(group, on) {
  const u = group?.userData;
  if (!u) return;
  u.threatRing.visible = Boolean(on);
  if (on) u.threatRing.material.opacity = 0.55 + 0.35 * Math.sin(performance.now() / 300);
}

export function flashShip(group) {
  const u = group?.userData;
  if (u) u.hitFlash = 1;
}

/** Sink-and-fade wreck state; the caller removes the group when it returns true. */
export function updateWreck(group, dt) {
  const u = group?.userData;
  if (!u) return true;
  u.wreckT = (u.wreckT || 0) + dt;
  const t = Math.min(1, u.wreckT / 1.6);
  group.position.y = -t * t * 2.2;
  u.body.rotation.x += dt * 0.7;
  u.body.rotation.z += dt * 0.4;
  u.glowMat.opacity *= 1 - dt * 1.4;
  u.hull.emissive.setRGB(0.6 * (1 - t), 0.15 * (1 - t), 0.02);
  u.hull.emissiveIntensity = 2 * (1 - t);
  u.billboard.visible = false;
  u.shield.visible = false;
  u.ring.visible = false;
  u.threatRing.visible = false;
  return t >= 1;
}

export function disposeShipMesh(group) {
  if (!group) return;
  const u = group.userData;
  group.traverse((o) => {
    if (o.isMesh || o.isSprite) {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m?.map && m.map !== u?.plateTex) m.map.dispose?.();
        m?.dispose?.();
      }
    }
  });
  u?.plateTex?.dispose?.();
  group.parent?.remove(group);
}

/** Shared material/geometry scratch for grid and effects to reuse. */
export function shared(key, make) {
  if (!CACHE.has(key)) CACHE.set(key, make());
  return CACHE.get(key);
}

export function disposeShared() {
  for (const v of CACHE.values()) v?.dispose?.();
  CACHE.clear();
}
