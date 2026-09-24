/**
 * The battlefield: hex prisms with emissive edges, hazard plates and the
 * translucent range/threat paints the player layers over during their phase.
 */

import * as THREE from 'three';
import { cellToWorld, hexCorners } from '../core/hex.js';

const KIND_COLOR = {
  empty: 0x0e1620,
  debris: 0x1d2a2b,
  asteroid: 0x2a2b33,
};

// Scratch colour for overlay tints — setOverlay repaints up to 150 plates per
// selection change, so allocating a Color per hex would churn every frame.
const tintColor = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);

function prismGeometry(size, height) {
  const pts = hexCorners(size).map(([x, y]) => new THREE.Vector2(x, y));
  const shape = new THREE.Shape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, height, 0);
  geo.computeVertexNormals();
  return geo;
}

function ringGeometry(size) {
  const pts = hexCorners(size).map(([x, y]) => new THREE.Vector3(x, 0.001, y));
  pts.push(pts[0].clone());
  return new THREE.BufferGeometry().setFromPoints(pts);
}

/**
 * Flat hexagon plate as a triangle fan with the circumradius mapped to the
 * unit disc, which is the coordinate space hexGlowTexture evaluates its
 * hex-distance field in. Returns raw arrays so overlay meshes can merge many
 * plates into one geometry.
 */
function hexPlate(size) {
  const corners = hexCorners(size);
  const pos = [0, 0, 0];
  const uv = [0.5, 0.5];
  for (const [x, y] of corners) {
    pos.push(x, 0, y);
    uv.push(0.5 + 0.5 * (x / size), 0.5 + 0.5 * (y / size));
  }
  const idx = [];
  for (let i = 0; i < corners.length; i += 1) {
    idx.push(0, 1 + i, 1 + ((i + 1) % corners.length));
  }
  return { pos, uv, idx, verts: corners.length + 1 };
}

function plateGeometry(size) {
  const p = hexPlate(size);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(p.uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(p.verts * 4).fill(1), 4));
  geo.setIndex(p.idx);
  return geo;
}

// hexCorners puts corners at ±30°, so the edge midpoints — and therefore the
// face normals of a pointy-top hex — sit at 0°, 60° and 120°.
const HEX_INRADIUS = Math.sqrt(3) / 2;
const HEX_NORMALS = [[1, 0], [0.5, HEX_INRADIUS], [-0.5, HEX_INRADIUS]];

function parseRgba(css) {
  const n = css.match(/[\d.]+/g) || [255, 255, 255, 1];
  return { r: +n[0], g: +n[1], b: +n[2], a: n[3] === undefined ? 1 : +n[3] };
}

/**
 * Glow whose alpha follows the hexagon's own distance field instead of a
 * circle. A radial gradient spills over the three neighbouring hexes at the
 * oblique camera angle, so range paints and threat bands read as blobs; the
 * hex metric keeps one plate inside its own cell. The band near d = 0.78 keeps
 * a lone highlighted hex legible as a plate rather than a smudge.
 *
 * `fill`/`band` trade the interior wash for that edge band. The arc channel
 * runs rim-heavy: it must stay readable where it overlaps the red threat
 * wash, and a lattice of lit hex edges reads as a firing envelope the way a
 * second translucent fill never does.
 */
function hexGlowTexture(innerCss, outerCss, { fill = 0.8, band = 0.45, bandAt = 0.78, bandW = 0.2 } = {}) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const a = parseRgba(innerCss);
  const b = parseRgba(outerCss);
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const u = ((x + 0.5) / S) * 2 - 1;
      const v = ((y + 0.5) / S) * 2 - 1;
      let d = 0;
      for (const [nx, ny] of HEX_NORMALS) d = Math.max(d, Math.abs(u * nx + v * ny) / HEX_INRADIUS);
      if (d >= 1) continue;
      const i = (y * S + x) * 4;
      const k = Math.min(1, d / 0.9);
      const body = Math.pow(1 - d, 0.5) * fill;
      const edge = Math.max(0, 1 - Math.abs(d - bandAt) / bandW) * band;
      img.data[i] = a.r + (b.r - a.r) * k;
      img.data[i + 1] = a.g + (b.g - a.g) * k;
      img.data[i + 2] = a.b + (b.b - a.b) * k;
      img.data[i + 3] = Math.min(1, body + edge) * (a.a + (b.a - a.a) * k) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function discTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.72, outer);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class HexGrid {
  constructor(scene, map, hexSize) {
    this.scene = scene;
    this.map = map;
    this.size = hexSize;
    this.root = new THREE.Group();
    this.tiles = new Map();
    this.rings = new Map();
    this.overlay = new Map();
    this.pickPlane = null;
    this.disposables = [];

    const h = 0.16;
    const prism = prismGeometry(hexSize * 0.97, h);
    const ring = ringGeometry(hexSize * 0.985);
    this.disposables.push(prism, ring);

    const mats = {
      empty: new THREE.MeshStandardMaterial({ color: KIND_COLOR.empty, metalness: 0.35, roughness: 0.85, emissive: 0x060b12, emissiveIntensity: 0.8 }),
      debris: new THREE.MeshStandardMaterial({ color: KIND_COLOR.debris, metalness: 0.2, roughness: 0.95, emissive: 0x11241f, emissiveIntensity: 0.9 }),
      asteroid: new THREE.MeshStandardMaterial({ color: KIND_COLOR.asteroid, metalness: 0.55, roughness: 0.7, emissive: 0x0d1016, emissiveIntensity: 0.6 }),
    };
    Object.values(mats).forEach((m) => this.disposables.push(m));
    this.tileMats = mats;

    const edgeMat = new THREE.LineBasicMaterial({ color: 0x2f4b66, transparent: true, opacity: 0.55 });
    const edgeMatHot = new THREE.LineBasicMaterial({ color: 0x4e7ea6, transparent: true, opacity: 0.85 });
    this.disposables.push(edgeMat, edgeMatHot);

    for (const cell of map.values()) {
      const { x, z } = cellToWorld(cell.col, cell.row, hexSize);
      const kind = cell.blocksLos ? 'asteroid' : cell.debris ? 'debris' : 'empty';
      const tile = new THREE.Mesh(prism, mats[kind]);
      tile.position.set(x, kind === 'asteroid' ? 0 : 0, z);
      tile.userData.cell = { col: cell.col, row: cell.row };
      tile.userData.pickCell = true;
      this.root.add(tile);
      this.tiles.set(cell.col + ',' + cell.row, tile);

      const line = new THREE.Line(ring, cell.blocksLos ? edgeMatHot : edgeMat);
      line.position.set(x, h + 0.002, z);
      this.root.add(line);

      if (cell.blocksLos) {
        // Asteroids get a chunky irregular rock pile so cover reads instantly.
        const rockMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4b, metalness: 0.4, roughness: 0.95, flatShading: true });
        const rockGeo = new THREE.IcosahedronGeometry(1, 0);
        this.disposables.push(rockMat, rockGeo);
        const rocks = new THREE.Group();
        let s = (cell.col * 7 + cell.row * 13) % 5;
        for (let i = 0; i < 3; i += 1) {
          s = (s * 1103515245 + 12345) % 2147483647;
          const r = 0.42 + ((s >> 4) % 7) / 22;
          const rock = new THREE.Mesh(rockGeo, rockMat);
          const a = (i / 3) * Math.PI * 2 + ((s >> 8) % 62) / 40;
          rock.position.set(Math.cos(a) * r * 0.75, 0.16 + i * 0.12, Math.sin(a) * r * 0.75);
          rock.scale.set(0.62 + i * 0.1, 0.5 + i * 0.08, 0.6 + i * 0.06);
          rock.rotation.set(i * 0.7, a, i * 0.4);
          rocks.add(rock);
        }
        rocks.position.set(x, 0.16, z);
        rocks.userData.asteroid = true;
        this.root.add(rocks);
        tile.userData.rocks = rocks;
      } else if (cell.debris) {
        const dustMat = new THREE.MeshBasicMaterial({ color: 0x4bd6a6, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
        const dust = new THREE.Mesh(plateGeometry(hexSize * 0.94), dustMat);
        dust.position.set(x, 0.175, z);
        this.root.add(dust);
        this.disposables.push(dustMat, dust.geometry);
      }
    }

    this.buildOverlayPools();
    scene.add(this.root);
  }

  /** One reusable mesh per overlay channel; repaints merge hex plates. */
  buildOverlayPools() {
    this.flashes = [];
    this.flashGeo = plateGeometry(this.size * 0.93);
    this.plate = hexPlate(this.size * 0.95);
    const tex = {
      move: hexGlowTexture('rgba(120,220,255,0.55)', 'rgba(60,150,255,0.22)'),
      threat: hexGlowTexture('rgba(255,120,110,0.5)', 'rgba(255,40,60,0.2)'),
      aim: hexGlowTexture('rgba(255,205,110,0.55)', 'rgba(255,120,40,0.22)'),
      arc: hexGlowTexture('rgba(255,226,160,0.72)', 'rgba(255,170,60,0.4)', { fill: 0.3, band: 1, bandAt: 0.88, bandW: 0.15 }),
      hazard: hexGlowTexture('rgba(110,255,190,0.45)', 'rgba(30,180,140,0.18)'),
    };
    this.overlayTex = tex;
    const lane = { move: 0.2, threat: 0.19, aim: 0.22, arc: 0.205, hazard: 0.2 };
    for (const [key, t] of Object.entries(tex)) {
      const m = new THREE.MeshBasicMaterial({
        map: t,
        transparent: true,
        opacity: 0,
        // Per-hex intensity arrives as vertex alpha (see setOverlay's weights).
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.flashGeo, m);
      mesh.position.y = lane[key] ?? 0.2;
      mesh.visible = false;
      mesh.renderOrder = key === 'arc' ? 2 : 3;
      mesh.userData.lane = lane[key] ?? 0.2;
      this.scene.add(mesh);
      this.disposables.push(m, t);
      this.overlay.set(key, mesh);
    }
    this.disposables.push(this.flashGeo);

    // A big soft gradient plate under the grid so hexes sit in a lit pool.
    const poolTex = discTexture('rgba(40,90,140,0.45)', 'rgba(14,32,54,0.25)');
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(this.size * 34, this.size * 34), new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0.5, depthWrite: false }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = -0.35;
    this.scene.add(pool);
    this.disposables.push(poolTex, pool.geometry, pool.material);

    this.pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(this.size * 60, this.size * 60),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.pickPlane.rotation.x = -Math.PI / 2;
    this.pickPlane.userData.pickPlane = true;
    this.scene.add(this.pickPlane);
    this.disposables.push(this.pickPlane.geometry, this.pickPlane.material);
  }

  worldOf(col, row) {
    return cellToWorld(col, row, this.size);
  }

  tileAt(col, row) {
    return this.tiles.get(col + ',' + row) || null;
  }

  /**
   * Paint one overlay channel. `weights` (parallel to `cells`, 0..1) dims
   * individual hexes through vertex alpha so a threat band can show how hard
   * each hex is actually covered instead of shouting one flat colour.
   */
  setOverlay(key, cells, { opacity = 0.75, color = null, weights = null } = {}) {
    const mesh = this.overlay.get(key);
    if (!mesh) return;
    if (!cells || !cells.length) {
      mesh.visible = false;
      mesh.material.opacity = 0;
      return;
    }
    // Merge one hex plate per cell into a single geometry — counts stay small
    // (< 150) and repaints only happen when the selection or aim changes.
    const plate = this.plate;
    const tint = color === null ? WHITE : tintColor.setHex(color);
    const positions = [];
    const uvs = [];
    const cols = [];
    const idx = [];
    cells.forEach((c, i) => {
      const { x, z } = cellToWorld(c.col, c.row, this.size);
      const v = i * plate.verts;
      const a = weights ? Math.max(0, Math.min(1, weights[i] ?? 1)) : 1;
      for (let k = 0; k < plate.pos.length; k += 3) {
        positions.push(plate.pos[k] + x, plate.pos[k + 1], plate.pos[k + 2] + z);
      }
      for (let k = 0; k < plate.uv.length; k += 2) uvs.push(plate.uv[k], plate.uv[k + 1]);
      for (let n = 0; n < plate.verts; n += 1) cols.push(tint.r, tint.g, tint.b, a);
      for (const t of plate.idx) idx.push(v + t);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4));
    geo.setIndex(idx);
    const old = mesh.geometry;
    mesh.geometry = geo;
    mesh.position.y = mesh.userData.lane ?? 0.2;
    mesh.visible = true;
    mesh.material.opacity = opacity;
    mesh.userData.baseOpacity = opacity;
    if (color !== null) mesh.material.color.setHex(color);
    if (old && old !== this.flashGeo) old.dispose?.();
  }

  clearOverlays() {
    for (const mesh of this.overlay.values()) {
      mesh.visible = false;
      mesh.material.opacity = 0;
    }
  }

  pulse(elapsed) {
    const m = this.overlay.get('threat');
    if (m && m.visible) {
      const base = m.userData.baseOpacity ?? 0.32;
      m.material.opacity = base * (0.78 + 0.3 * Math.sin(elapsed * 3));
    }
  }

  flashCell(col, row, color = 0xff8844, time = 0.35) {
    // Decals are pooled because tile materials are shared between hexes — a
    // per-tile emissive would flash every tile that uses the same material.
    let d = this.flashes.find((f) => !f.mesh.visible);
    if (!d) {
      if (this.flashes.length >= 16) return;
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(this.flashGeo, mat);
      mesh.position.y = 0.22;
      mesh.renderOrder = 4;
      mesh.visible = false;
      this.scene.add(mesh);
      d = { mesh, mat, t: 0, dur: 0.35 };
      this.flashes.push(d);
    }
    const w = this.worldOf(col, row);
    d.mesh.position.set(w.x, 0.22, w.z);
    d.mesh.material.color.setHex(color);
    d.mesh.visible = true;
    d.t = d.dur = time;
    d.mat.opacity = 0.95;
  }

  update(dt) {
    for (const d of this.flashes) {
      if (!d.mesh.visible) continue;
      d.t = Math.max(0, d.t - dt);
      const k = d.t / d.dur;
      d.mat.opacity = 0.95 * k * k;
      d.mesh.scale.setScalar(1 + (1 - k) * 0.25);
      if (d.t === 0) d.mesh.visible = false;
    }
  }

  dispose() {
    for (const d of this.flashes) {
      this.scene.remove(d.mesh);
      d.mat.dispose();
    }
    this.flashes.length = 0;
    this.flashGeo?.dispose?.();
    for (const d of this.disposables) d?.dispose?.();
    this.scene.remove(this.root);
    for (const mesh of this.overlay.values()) this.scene.remove(mesh);
    this.scene.remove(this.pickPlane);
  }
}
