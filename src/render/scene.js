/**
 * Renderer orchestration: owns the WebGL context, the scene graph, the camera
 * rig, the grid and the ship display objects. Game logic never touches three —
 * it hands this module a state snapshot plus an ordered list of events and the
 * scene plays them back.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HEX_SIZE, MAP_COLS, MAP_ROWS } from '../core/data.js';
import { DIR_YAW, cellToWorld, worldToCell } from '../core/hex.js';
import { BattleCamera } from './camera.js';
import { HexGrid } from './grid.js';
import { Background } from './background.js';
import { Effects } from './effects.js';
import {
  addPickProxy,
  createShipMesh,
  disposeShipMesh,
  flashShip,
  setShipHighlight,
  setShipThreat,
  updateShipMesh,
  updateWreck,
} from './shipModel.js';

function worldOf(col, row, y = 0) {
  const w = cellToWorld(col, row, HEX_SIZE);
  return new THREE.Vector3(w.x, y, w.z);
}

export class BattleScene {
  constructor(canvas, { bloom = true } = {}) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.speed = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();

    const aspect = Math.max(0.4, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.cam = new BattleCamera(canvas, aspect);
    const w = MAP_COLS * HEX_SIZE * 1.8;
    const h = MAP_ROWS * HEX_SIZE * 1.6;
    this.cam.setBounds(w, h);

    this.hemi = new THREE.HemisphereLight(0x4c74ab, 0x070b12, 0.65);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xd6e8ff, 1.5);
    this.key.position.set(-22, 30, 16);
    this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0xff8a63, 0.75);
    this.rim.position.set(24, 12, -22);
    this.scene.add(this.rim);
    this.core = new THREE.PointLight(0x3f6fae, 28, 90, 2);
    this.core.position.set(0, 14, 0);
    this.scene.add(this.core);

    this.background = new Background(this.scene);
    this.grid = new HexGrid(this.scene, new Map(), HEX_SIZE);
    this.effects = new Effects(this.scene, this.cam.camera);

    this.timers = [];
    this.ships = new Map();
    this.wrecks = [];
    this.hoverCell = null;
    this.hoverShipId = null;
    this.selectedId = null;
    this.targetId = null;
    this.threatIds = new Set();

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.pointerDown = null;
    this.dragged = false;
    this.onPick = null;
    this.onHover = null;
    this.onGesture = null;

    this.composerOk = false;
    if (bloom) this.setupComposer();

    this.attachInput(canvas);
    this.resize();
  }

  get camera() {
    return this.cam.camera;
  }

  setupComposer() {
    try {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.cam.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.82, 0.55, 0.7);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      this.composerOk = true;
    } catch (err) {
      this.composer = null;
      this.composerOk = false;
      this.bloomOn = false;
      console.warn('Bloom unavailable, falling back to direct render.', err);
    }
  }

  setBloom(on) {
    if (!this.composerOk) return;
    this.bloomOn = Boolean(on);
    this.bloom.enabled = this.bloomOn;
  }

  setSpeed(mult) {
    this.speed = mult;
  }

  /** Build the grid once the battle map exists (state is created after scene). */
  bindMap(map) {
    this.scene.remove(this.grid.root);
    this.grid.dispose();
    this.grid = new HexGrid(this.scene, map, HEX_SIZE);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.cam.resize(Math.max(0.4, w / h));
    if (this.composerOk) {
      this.composer.setSize(w, h);
      this.bloom.setSize(w, h);
    }
  }

  // ------------------------------------------------------------- ship objects

  shipGroup(id) {
    return this.ships.get(id) || null;
  }

  worldFor(ship, y = 0.34) {
    return worldOf(ship.col, ship.row, y);
  }

  /** Plain offset, for nudging floating FX off a hull without importing three. */
  upVec(x, y, z) {
    return new THREE.Vector3(x, y, z);
  }

  /** Reconcile display objects with the state snapshot. */
  sync(state) {
    for (const ship of state.ships.values()) {
      let g = this.ships.get(ship.id);
      if (!g) {
        g = createShipMesh(ship);
        g.position.copy(this.worldFor(ship));
        g.rotation.y = DIR_YAW[ship.facing % 6];
        addPickProxy(g, ship);
        this.scene.add(g);
        this.ships.set(ship.id, g);
      }
      if (!ship.alive && !g.userData.dying) {
        g.userData.dying = true;
        this.wrecks.push(g);
        this.effects.explode(g.position.clone(), {
          size: ship.cls.scale > 1.1 ? 1.6 : 1.1,
          color: ship.team === 'enemy' ? 0xff8a5c : 0x8fd0ff,
        });
        this.effects.damageNumber(g.position.clone(), 'DESTROYED', { crit: true });
        this.cam.addShake(ship.cls.scale > 1.1 ? 0.75 : 0.45);
        this.ships.delete(ship.id);
        this.threatIds.delete(ship.id);
      }
    }
  }

  setSelected(id) {
    this.selectedId = id;
  }

  setTarget(id) {
    this.targetId = id;
  }

  setThreatIds(ids) {
    this.threatIds = new Set(ids);
  }

  // ------------------------------------------------------------------ picking

  pointerToNdc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    return this.ndc;
  }

  /** @returns {{kind:'ship',shipId:string}|{kind:'cell',col:number,row:number}|null} */
  pick(clientX, clientY) {
    this.pointerToNdc(clientX, clientY);
    this.raycaster.setFromCamera(this.ndc, this.cam.camera);
    const groups = [...this.ships.values()];
    const hits = this.raycaster.intersectObjects(groups, true);
    for (const h of hits) {
      let o = h.object;
      while (o) {
        if (o.userData?.pickShipId) return { kind: 'ship', shipId: o.userData.pickShipId };
        if (o.userData?.shipId) return { kind: 'ship', shipId: o.userData.shipId };
        o = o.parent;
      }
    }
    const p = this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
    if (!p) return null;
    const cell = this.gridCellFromWorld(p.x, p.z);
    return cell ? { kind: 'cell', col: cell.col, row: cell.row } : null;
  }

  gridCellFromWorld(x, z) {
    const c = worldToCell(x, z, HEX_SIZE);
    return this.grid.map?.has?.(c.col + ',' + c.row) ? c : null;
  }

  screenPos(v3) {
    const p = v3.clone().project(this.cam.camera);
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (p.x * 0.5 + 0.5) * r.width,
      y: (-p.y * 0.5 + 0.5) * r.height,
      visible: p.z < 1,
    };
  }

  // -------------------------------------------------------------------- input

  attachInput(canvas) {
    const opt = { passive: false };
    this._onDown = (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      this.pointerDown = { x: e.clientX, y: e.clientY, button: e.button, t: performance.now(), id: e.pointerId };
      this.dragged = false;
      if (e.button !== 0) this.cam.beginDrag(e.button, e.clientX, e.clientY);
      e.preventDefault();
    };
    this._onMove = (e) => {
      if (this.pointerDown && this.pointerDown.id === e.pointerId) {
        const dx = e.clientX - this.pointerDown.x;
        const dy = e.clientY - this.pointerDown.y;
        if (!this.dragged && Math.hypot(dx, dy) > 6) {
          this.dragged = true;
          this.cam.beginDrag(this.pointerDown.button, this.pointerDown.x, this.pointerDown.y);
        }
        if (this.dragged) {
          this.cam.dragTo(e.clientX, e.clientY);
          return;
        }
      }
      const hit = this.pick(e.clientX, e.clientY);
      const cell = hit && hit.kind === 'cell' ? hit : null;
      const shipId = hit && hit.kind === 'ship' ? hit.shipId : null;
      const changed = shipId !== this.hoverShipId || (cell?.col ?? -1) !== (this.hoverCell?.col ?? -1) || (cell?.row ?? -1) !== (this.hoverCell?.row ?? -1);
      this.hoverShipId = shipId;
      this.hoverCell = cell ? { col: cell.col, row: cell.row } : null;
      if (changed) this.onHover?.({ shipId, cell: this.hoverCell });
    };
    this._onUp = (e) => {
      const down = this.pointerDown;
      this.pointerDown = null;
      this.cam.endDrag();
      if (!down || this.dragged) {
        this.dragged = false;
        return;
      }
      if (down.button === 1 || down.button === 2) return;
      const hit = this.pick(e.clientX, e.clientY);
      this.onPick?.(hit, e);
    };
    this._onWheel = (e) => {
      e.preventDefault();
      this.cam.zoom(e.deltaY * (e.ctrlKey ? 0.4 : 1));
    };
    this._onCtx = (e) => e.preventDefault();
    this._onLeave = () => {
      this.hoverCell = null;
      this.hoverShipId = null;
      this.onHover?.({ shipId: null, cell: null });
    };

    canvas.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('wheel', this._onWheel, opt);
    canvas.addEventListener('contextmenu', this._onCtx);
    canvas.addEventListener('pointerleave', this._onLeave);
  }

  detachInput() {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('contextmenu', this._onCtx);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
  }

  // ---------------------------------------------------------------- animation

  sleep(ms) {
    return new Promise((res) => this.timers.push({ t: ms, res }));
  }

  /** Glide a ship along a hex path. Resolves when it docks. */
  async animateMove(shipId, cells, { warp = false, duration = null } = {}) {
    const g = this.ships.get(shipId);
    if (!g) return;
    const ship = this.state?.ships.get(shipId);
    const pts = [g.position.clone()];
    for (const c of cells || []) pts.push(worldOf(c.col, c.row, 0));
    if (pts.length < 2) return;
    const to = pts[pts.length - 1];
    // The frame loop lerps display objects toward the state hex; hold it off
    // while a scripted move owns the transform.
    g.userData.animLock = true;
    if (warp) {
      this.effects.warp(pts[0].clone(), { color: 0xb98cff });
      g.visible = false;
      await this.sleep(180);
      g.position.copy(to);
      g.visible = true;
      this.effects.warp(to.clone(), { color: 0xb98cff });
      g.userData.animLock = false;
      return;
    }
    const dur = (duration ?? cells.length * 230) / this.speed;
    const t0 = performance.now();
    const y0 = 0.34;
    await new Promise((resolve) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / dur);
        const seg = Math.min(pts.length - 2, Math.floor(k * (pts.length - 1)));
        const local = k * (pts.length - 1) - seg;
        const p = pts[seg].clone().lerp(pts[seg + 1], local);
        g.position.set(p.x, y0 + Math.sin(k * Math.PI) * 0.25, p.z);
        // steer toward the current segment
        const dir = pts[seg + 1].clone().sub(pts[seg]);
        if (dir.lengthSq() > 1e-6 && ship) {
          const yaw = Math.atan2(-dir.z, dir.x);
          let d = yaw - g.rotation.y;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          g.rotation.y += d * 0.28;
          g.userData.steer = d;
        }
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    g.userData.animLock = false;
    if (ship) g.userData.steer = 0;
  }

  async animateRotate(shipId, facing) {
    const g = this.ships.get(shipId);
    if (!g) return;
    const target = DIR_YAW[facing % 6];
    let d = target - g.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) < 0.01) return;
    const dur = (240 + Math.abs(d) * 120) / this.speed;
    const start = g.rotation.y;
    const t0 = performance.now();
    g.userData.animLock = true;
    await new Promise((resolve) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / dur);
        const e = 1 - (1 - k) * (1 - k);
        g.rotation.y = start + d * e;
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    g.userData.animLock = false;
  }

  focusShip(id, { distance = 26 } = {}) {
    const g = this.ships.get(id);
    if (g) this.cam.focus(g.position, { distance });
  }

  focusCell(col, row) {
    this.cam.focus(worldOf(col, row, 0));
  }

  centerOnTeam(team) {
    const v = new THREE.Vector3();
    let n = 0;
    for (const [id, g] of this.ships) {
      const s = this.state?.ships.get(id);
      if (!s || s.team !== team) continue;
      v.add(g.position);
      n += 1;
    }
    if (n) this.cam.focus(v.multiplyScalar(1 / n), { distance: 44 });
  }

  shake(amount) {
    this.cam.addShake(amount);
  }

  /** Brief white-hot hull flash on impact. */
  flash(shipId) {
    flashShip(this.ships.get(shipId));
  }

  // ------------------------------------------------------------------ frame

  frame(dtRaw) {
    const dt = Math.min(0.05, dtRaw);
    this.elapsed += dt;

    for (let i = this.timers.length - 1; i >= 0; i -= 1) {
      const t = this.timers[i];
      t.t -= dtRaw * 1000 * this.speed;
      if (t.t <= 0) {
        this.timers.splice(i, 1);
        t.res();
      }
    }

    for (const [id, g] of this.ships) {
      const ship = this.state?.ships.get(id);
      if (!ship) continue;
      if (!g.userData.animLock) {
        const want = worldOf(ship.col, ship.row, 0);
        g.position.x += (want.x - g.position.x) * Math.min(1, dt * 9);
        g.position.z += (want.z - g.position.z) * Math.min(1, dt * 9);
        g.position.y += (0.34 - g.position.y) * Math.min(1, dt * 9);
      }
      const mode = id === this.selectedId ? 'selected' : id === this.targetId ? 'target' : id === this.hoverShipId ? 'hover' : null;
      setShipHighlight(g, mode);
      setShipThreat(g, this.threatIds.has(id));
      updateShipMesh(g, ship, dt, this.elapsed, this.cam.camera);
    }

    for (let i = this.wrecks.length - 1; i >= 0; i -= 1) {
      const g = this.wrecks[i];
      if (updateWreck(g, dt)) {
        disposeShipMesh(g);
        this.wrecks.splice(i, 1);
      }
    }

    // Effects advance on the same hurried clock as the turn timers below;
    // feeding them raw dt at 4x leaves detonations on the deck long after the
    // round has moved on, where they stack into unreadable rings.
    this.effects.update(dt * this.speed);
    this.grid.pulse(this.elapsed);
    this.grid.update(dt);
    this.background.update(dt, this.elapsed, this.cam.camera);
    this.cam.update(dt);

    if (this.composerOk && this.bloomOn !== false) this.composer.render();
    else this.renderer.render(this.scene, this.cam.camera);
  }

  bindState(state) {
    this.state = state;
    this.sync(state);
  }

  dispose() {
    this.detachInput();
    for (const g of this.ships.values()) disposeShipMesh(g);
    for (const g of this.wrecks) disposeShipMesh(g);
    this.ships.clear();
    this.wrecks.length = 0;
    this.effects.dispose();
    this.grid.dispose();
    this.background.dispose();
    this.renderer.dispose();
  }
}
