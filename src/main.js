/**
 * VOID LANCE — game controller.
 *
 * Owns the input state machine (select → reposition → aim → fire), plays the
 * rules engine's events back through the renderer, and drives the enemy phase
 * one animated ship at a time. The rules themselves live in src/core; nothing
 * here decides damage.
 */

import { BattleScene } from './render/scene.js';
import { disposeShipMesh } from './render/shipModel.js';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { audio } from './audio/audio.js';
import { buildMap } from './core/data.js';
import { cellsWithin, hexDistance, lineOfSight } from './core/hex.js';
import {
  checkEnd, createGame, endPhase, labelFor, shipById, shipsOf,
} from './core/state.js';
import {
  aimReport, applyShot, fireWeapon, findWeapon, inArc, incomingThreat, moveShip,
  recharge, rotateShip, shieldMaxOf, thrustOf, useSystem,
} from './core/combat.js';
import { reachOptions, shipAt, teleportOptions } from './core/paths.js';
import { executeOrder, nextEnemyShip, planShip } from './core/ai.js';

const KIND_COLOR = {
  kinetic: 0xfff0b8,
  energy: 0x7ce8ff,
  torpedo: 0xffb066,
  missile: 0xff7ad9,
};
const FIRE_SFX = {
  kinetic: 'fireKinetic',
  energy: 'fireEnergy',
  torpedo: 'fireTorpedo',
  missile: 'fireMissile',
};
const SPEEDS = [0.5, 1, 2, 4];

class Game {
  constructor(refs) {
    this.canvas = refs.canvas;
    this.scene = new BattleScene(refs.canvas, { bloom: true });
    this.state = null;
    this.selectedId = null;
    this.inspectId = null;
    this.hoverTargetId = null;
    this.pendingMode = null; // null | 'weapon' | 'system'
    this.pendingWeaponId = null;
    this.busy = false;
    this.resultShown = false;
    this.speedIdx = 1;
    this.soundOn = true;
    this.bloomOn = this.scene.composerOk;
    this.threatOn = false;
    this.topDown = false;
    this.pointer = { x: 0, y: 0 };
    this.uiHover = false;

    this.hud = new Hud(refs.hud, {
      onCycleSpeed: () => this.cycleSpeed(),
      onToggleSound: () => this.toggleSound(),
      onToggleBloom: () => this.toggleBloom(),
      onToggleThreat: () => this.toggleThreat(),
      onToggleView: () => this.toggleView(),
      onHelp: () => this.screens && this.screens.showHelp(),
      onEndPhase: () => this.endPhase(),
      onRotate: () => this.rotateSelected(),
      onRecharge: () => this.rechargeSelected(),
      onSystem: () => this.useSystemSelected(),
      onSelectWeapon: (id) => this.armWeapon(id),
      onSelectShip: (id, focus) => {
        const ship = this.state && shipById(this.state, id);
        if (!ship) return;
        if (ship.team === 'player') this.selectShip(id, { focus });
        else {
          this.inspectId = id;
          if (focus) this.scene.focusShip(id, { distance: 26 });
          this.refresh();
        }
      },
    });
    this.screens = new Screens(refs.screens, {
      onStart: (difficulty) => this.start(difficulty),
    });

    this.scene.onPick = (hit) => this.onPick(hit);
    this.scene.onHover = ({ shipId, cell }) => this.onHover(shipId, cell);
  }

  // ------------------------------------------------------------------ boot

  boot() {
    this.scene.bindMap(buildMap());
    this.screens.showTitle();
    this.hud.setLocked(true);
    this.bindDom();
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      this.scene.frame(dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  bindDom() {
    window.addEventListener('resize', () => this.scene.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      const onPanel = e.target && e.target.closest && e.target.closest('.vl-top, .vl-inspector, .vl-log, .vl-actions, .vl-strip, .vl-pip, .vl-weapon');
      this.uiHover = Boolean(onPanel);
      if (this.uiHover) {
        this.hoverTargetId = null;
        this.hud.showAim(null, null);
      }
    }, true);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) audio.suspend();
      else if (!this.soundOn) audio.suspend();
      else audio.resume();
    });
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.hud.toast('GPU context lost — reload the page to continue.', 'bad', 9000);
    });
  }

  // ------------------------------------------------------------------ match

  start(difficulty) {
    audio.init();
    audio.setMuted(!this.soundOn);
    if (this.state) this.clearSceneShips();

    this.state = createGame({ difficulty });
    this.scene.bindMap(this.state.map);
    this.scene.bindState(this.state);
    this.selectedId = null;
    this.inspectId = null;
    this.hoverTargetId = null;
    this.resultShown = false;
    this.clearPending();

    this.hud.clearLog();
    for (const entry of this.state.log) this.hud.addLog(entry);
    this.screens.clear();
    this.hud.setLocked(false);
    this.scene.setBloom(this.bloomOn);
    this.scene.setSpeed(SPEEDS[this.speedIdx]);
    this.scene.centerOnTeam('player');
    this.hud.updateTop(this.state);
    audio.startAmbient();
    audio.play('turnStart');
    this.autoSelect();
    this.hud.toast(`ROUND 1 — YOUR PHASE`, 'good', 1800);
    this.refresh();
  }

  clearSceneShips() {
    const s = this.scene;
    for (const g of s.ships.values()) {
      s.scene.remove(g);
      disposeShipMesh(g);
    }
    s.ships.clear();
    for (const g of s.wrecks) {
      s.scene.remove(g);
      disposeShipMesh(g);
    }
    s.wrecks.length = 0;
    s.selectedId = null;
    s.targetId = null;
    s.threatIds.clear();
    s.effects.clear();
  }

  get sel() {
    return this.state ? shipById(this.state, this.selectedId) : null;
  }

  get interactive() {
    return Boolean(this.state) && !this.state.over && !this.busy && this.state.phase === 'player';
  }

  /** Wrap an async action: lock input, play it, unlock, repaint. */
  async sequence(fn) {
    this.busy = true;
    this.hud.setLocked(true);
    this.scene.grid.clearOverlays();
    try {
      await fn();
    } catch (err) {
      console.error(err);
      this.hud.toast('Sequence error — see console.', 'bad');
    }
    this.busy = false;
    this.hud.setLocked(Boolean(this.state && (this.state.over || this.state.phase !== 'player')));
    this.refresh();
  }

  // ----------------------------------------------------------------- input

  selectShip(id, { focus = false } = {}) {
    const ship = this.state && shipById(this.state, id);
    if (!ship || ship.team !== 'player' || !ship.alive) return;
    this.selectedId = id;
    this.inspectId = id;
    this.clearPending();
    audio.play('select');
    if (focus) this.scene.focusShip(id, { distance: 26 });
    this.refresh();
  }

  autoSelect() {
    const list = shipsOf(this.state, 'player').sort((a, b) => a.index - b.index);
    const ready = list.find((s) => !s.acted) || list[0];
    if (ready) {
      this.selectedId = ready.id;
      this.inspectId = ready.id;
    }
  }

  clearPending() {
    this.pendingMode = null;
    this.pendingWeaponId = null;
    this.hoverTargetId = null;
    this.scene.setTarget(null);
    this.hud.showAim(null, null);
  }

  armWeapon(weaponId) {
    const ship = this.sel;
    if (!this.interactive || !ship || ship.acted) return;
    const weapon = findWeapon(ship, weaponId);
    if (!weapon) return;
    if (this.pendingMode === 'weapon' && this.pendingWeaponId === weaponId) {
      this.clearPending();
      this.refresh();
      return;
    }
    this.pendingMode = 'weapon';
    this.pendingWeaponId = weaponId;
    this.hoverTargetId = null;
    audio.play('lockOn');
    // If exactly one enemy is shootable with this weapon, aim at it already.
    const options = this.targetOptions(ship, weapon);
    if (options.length === 1) this.hoverTargetId = options[0].id;
    this.refresh();
  }

  /** Enemies this weapon can actually engage right now. */
  targetOptions(ship, weapon) {
    const out = [];
    for (const foe of shipsOf(this.state, ship.team === 'player' ? 'enemy' : 'player')) {
      if (aimReport(this.state, ship, weapon.id, foe.id).ok) out.push(foe);
    }
    return out;
  }

  rotateSelected() {
    const ship = this.sel;
    if (!this.interactive || !ship || ship.acted || ship.rotated) return;
    const dir = 1;
    this.runSequenceSync(async () => {
      const res = rotateShip(this.state, ship, (ship.facing + dir + 6) % 6);
      if (!res.ok) {
        audio.play('error');
        this.hud.toast(res.reason, 'bad');
        return;
      }
      audio.play('thruster', { gain: 0.45, rate: 1.25 });
      this.playEvents(res.events);
      await this.scene.animateRotate(ship.id, ship.facing);
    });
  }

  rechargeSelected() {
    const ship = this.sel;
    if (!this.interactive || !ship || ship.acted) return;
    this.runSequenceSync(async () => {
      const res = recharge(this.state, ship);
      if (!res.ok) {
        audio.play('error');
        this.hud.toast(res.reason, 'bad');
        return;
      }
      this.playEvents(res.events);
      await this.scene.sleep(260);
      this.advanceSelection();
    });
  }

  useSystemSelected() {
    const ship = this.sel;
    if (!this.interactive || !ship || ship.acted || ship.systemCharges <= 0) return;
    const sys = ship.cls.system;
    if (!sys) return;
    if (sys.target) {
      if (this.pendingMode === 'system') {
        this.clearPending();
        this.refresh();
        return;
      }
      this.pendingMode = 'system';
      audio.play('lockOn');
      this.refresh();
      return;
    }
    this.runSequenceSync(async () => {
      const res = useSystem(this.state, ship, null);
      if (!res.ok) {
        audio.play('error');
        this.hud.toast(res.reason, 'bad');
        return;
      }
      this.playEvents(res.events);
      await this.scene.sleep(320);
      this.advanceSelection();
    });
  }

  /** Small sync actions still need the busy gate so nothing overlaps. */
  runSequenceSync(fn) {
    if (this.busy) return;
    this.clearPending();
    this.sequence(fn);
  }

  /** Move the selection on to the next ship that still has orders. */
  advanceSelection() {
    if (!this.state || this.state.over || this.state.phase !== 'player') return;
    const list = shipsOf(this.state, 'player').sort((a, b) => a.index - b.index);
    const next = list.find((s) => !s.acted);
    if (next) {
      this.selectedId = next.id;
      this.inspectId = next.id;
      audio.play('uiHover', { gain: 0.25 });
    }
    this.refresh();
  }

  onKey(e) {
    if (e.metaKey || e.ctrlKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();

    if (k === 'escape') {
      if (this.pendingMode) {
        this.clearPending();
        audio.play('uiBack');
        this.refresh();
      }
      return;
    }
    if (k === ' ' || k === 'spacebar') {
      e.preventDefault();
      if (this.interactive) this.endPhase();
      return;
    }
    if (k >= '1' && k <= '5') {
      const list = this.state ? [...shipsOf(this.state, 'player')].sort((a, b) => a.index - b.index) : [];
      const ship = list[Number(k) - 1];
      if (ship) this.selectShip(ship.id, { focus: false });
      return;
    }
    switch (k) {
      case 'tab': {
        e.preventDefault();
        const list = shipsOf(this.state, 'player').sort((a, b) => a.index - b.index);
        if (!list.length) return;
        const start = list.findIndex((s) => s.id === this.selectedId);
        const ready = list.find((s, i) => i > start && !s.acted)
          || list.find((s) => !s.acted)
          || list[(start + 1 + list.length) % list.length];
        if (ready) this.selectShip(ready.id, { focus: true });
        break;
      }
      case 'r':
        this.rotateSelected();
        break;
      case 'f':
        if (this.selectedId) this.scene.focusShip(this.selectedId, { distance: 24 });
        break;
      case 'g':
        this.toggleThreat();
        break;
      case 'b':
        this.toggleBloom();
        break;
      case 'm':
        this.toggleSound();
        break;
      case 'v':
        this.toggleView();
        break;
      case 'h':
        if (!this.screens.which) this.screens.showHelp();
        break;
      case 'q':
        this.scene.cam.orbit(-60, 0);
        break;
      case 'e':
        this.scene.cam.orbit(60, 0);
        break;
      case 'a':
        this.scene.cam.pan(36, 0);
        break;
      case 'd':
        this.scene.cam.pan(-36, 0);
        break;
      case 'w':
        this.scene.cam.pan(0, 30);
        break;
      case 's':
        this.scene.cam.pan(0, -30);
        break;
      case 'arrowleft':
        this.scene.cam.pan(40, 0);
        break;
      case 'arrowright':
        this.scene.cam.pan(-40, 0);
        break;
      case 'arrowup':
        this.scene.cam.pan(0, 34);
        break;
      case 'arrowdown':
        this.scene.cam.pan(0, -34);
        break;
      case '[':
        this.setSpeedIdx(Math.max(0, this.speedIdx - 1));
        break;
      case ']':
        this.setSpeedIdx(Math.min(SPEEDS.length - 1, this.speedIdx + 1));
        break;
      default:
        break;
    }
  }

  onPick(hit) {
    if (!this.interactive) return;
    const ship = this.sel;
    if (!hit) {
      if (this.pendingMode) {
        this.clearPending();
        audio.play('uiBack');
        this.refresh();
      }
      return;
    }

    if (hit.kind === 'ship') {
      const target = shipById(this.state, hit.shipId);
      if (!target) return;
      if (this.pendingMode === 'weapon') {
        if (target.team === 'enemy' && target.alive) this.fireAt(target.id);
        else this.rejectTarget('Not a valid target');
        return;
      }
      if (this.pendingMode === 'system') {
        if (target.team === 'player' && ship && target.id !== ship.id) this.fireSystem(target.id);
        else this.rejectTarget('Pick a friendly ship in range');
        return;
      }
      if (target.team === 'player') {
        if (target.alive) this.selectShip(target.id, { focus: false });
      } else {
        this.inspectId = target.id;
        audio.play('targetPing', { gain: 0.4 });
        this.refresh();
      }
      return;
    }

    // plain hex click
    const cell = hit;
    const occupant = shipAt(this.state, cell.col, cell.row);
    if (this.pendingMode === 'system') {
      const options = this.systemOptions(ship);
      const hit3 = options.some((o) => o.col === cell.col && o.row === cell.row);
      if (hit3) this.fireSystem(this.systemTargetRef(ship, cell));
      else this.rejectTarget('Out of system range');
      return;
    }
    if (this.pendingMode === 'weapon') {
      if (occupant && occupant.team === 'enemy' && occupant.alive) this.fireAt(occupant.id);
      else this.rejectTarget('No target there');
      return;
    }
    if (occupant && occupant.id === (ship && ship.id)) {
      this.scene.cam.focus(this.scene.worldFor(ship, 0.4));
      return;
    }
    if (occupant) {
      this.inspectId = occupant.id;
      audio.play('targetPing', { gain: 0.35 });
      this.refresh();
      return;
    }
    if (!ship || ship.acted || ship.moved) {
      this.rejectTarget(ship && ship.acted ? `${ship.name} has already acted` : 'No ship selected');
      return;
    }
    const opt = this.moveOptions(ship).find((o) => o.col === cell.col && o.row === cell.row);
    if (!opt) {
      this.rejectTarget('Out of movement range');
      return;
    }
    this.doMove(ship, opt);
  }

  onHover(shipId, cell) {
    if (this.uiHover) return;
    if (this.pendingMode !== 'weapon') return;
    const ship = this.sel;
    if (!ship) return;
    const target = shipId ? shipById(this.state, shipId) : null;
    if (!target || target.team === ship.team || !target.alive) {
      if (this.hoverTargetId) {
        this.hoverTargetId = null;
        this.hud.showAim(null, null);
        this.scene.setTarget(null);
      }
      return;
    }
    if (target.id !== this.hoverTargetId) {
      this.hoverTargetId = target.id;
      audio.play('targetPing', { gain: 0.3 });
    }
    this.scene.setTarget(target.id);
    this.hud.showAim(aimReport(this.state, ship, this.pendingWeaponId, target.id), target);
    this.hud.setAimPosition(this.pointer.x, this.pointer.y);
  }

  rejectTarget(reason) {
    audio.play('error');
    this.hud.toast(reason, 'bad', 1200);
  }

  // ------------------------------------------------------------- move/fire

  moveOptions(ship) {
    if (!ship || ship.acted || ship.moved) return [];
    return reachOptions(this.state, ship, thrustOf(ship));
  }

  systemOptions(ship) {
    if (!ship || ship.acted || ship.systemCharges <= 0) return [];
    const sys = ship.cls.system;
    if (sys.target === 'empty') return teleportOptions(this.state, ship, sys.radius || 3);
    if (sys.target === 'ally') {
      return shipsOf(this.state, ship.team)
        .filter((a) => a.id !== ship.id && a.alive
          && hexDistance(ship, a) <= (sys.radius || 3))
        .map((a) => ({ col: a.col, row: a.row, shipId: a.id }));
    }
    return [];
  }

  systemTargetRef(ship, cell) {
    const sys = ship.cls.system;
    if (sys.target === 'ally') {
      const occ = shipAt(this.state, cell.col, cell.row);
      return occ ? occ.id : null;
    }
    return `${cell.col},${cell.row}`;
  }

  async doMove(ship, opt) {
    await this.sequence(async () => {
      audio.play('thruster', { gain: 0.6 });
      this.pendingMoveShip = ship.id;
      await this.scene.animateMove(ship.id, opt.cells);
      const res = moveShip(this.state, ship, opt.col, opt.row, opt.cells);
      this.pendingMoveShip = null;
      if (!res.ok) {
        audio.play('error');
        this.hud.toast(res.reason, 'bad');
        return;
      }
      this.playEvents(res.events);
      this.scene.grid.flashCell(opt.col, opt.row, 0x5fd8ff, 0.4);
      checkEnd(this.state);
    });
  }

  async fireAt(targetId) {
    const ship = this.sel;
    const weaponId = this.pendingWeaponId;
    this.clearPending();
    if (!ship) return;
    await this.sequence(async () => {
      const res = this.fireWith(ship, weaponId, targetId);
      if (!res || !res.ok) return;
      this.playEvents(res.events);
      await this.flyShots(res.shots);
      checkEnd(this.state);
      this.advanceSelection();
    });
  }

  /** Rolls the volley, commits the action flag, returns shots to animate. */
  fireWith(ship, weaponId, targetId) {
    const weapon = findWeapon(ship, weaponId);
    const res = fireWeapon(this.state, ship, weaponId, targetId);
    if (!res || !res.ok) {
      audio.play('error');
      this.hud.toast(res && res.reason ? res.reason : 'Cannot fire', 'bad');
      return null;
    }
    if (weapon) this.hud.toast(`${weapon.name} — ${labelFor(shipById(this.state, targetId))}`, 'player', 1100);
    return res;
  }

  /**
   * Launch every pod on the weapon's own schedule, then commit each one's
   * damage as it visually arrives, so a salvo reads as one volley.
   */
  async flyShots(shots) {
    const list = (shots || []).filter(Boolean);
    if (!list.length) return;
    const sc = this.scene;
    const flying = [];
    let clock = 0;
    for (const shot of list) {
      const at = shot.delayMs || 0;
      if (at > clock) {
        await sc.sleep(at - clock);
        clock = at;
      }
      const from = shipById(this.state, shot.fromId);
      const to = shipById(this.state, shot.targetId);
      if (from && to) {
        const secs = sc.effects.shot(shot.kind, sc.worldFor(from, 0.45), sc.worldFor(to, 0.45), {
          crit: shot.crit,
        });
        flying.push({ shot, impact: clock + secs * 1000 });
      }
    }
    for (const job of flying) {
      if (job.impact > clock) {
        await sc.sleep(job.impact - clock);
        clock = job.impact;
      }
      const to = shipById(this.state, job.shot.targetId);
      if (!to || !to.alive) continue;
      const applied = applyShot(this.state, job.shot);
      if (applied) this.playEvents(applied.events);
      sc.sync(this.state);
    }
  }

  async fireSystem(targetRef) {
    const ship = this.sel;
    this.clearPending();
    if (!ship) return;
    await this.sequence(async () => {
      const sys = ship.cls.system;
      if (sys.id === 'phase_shift' && typeof targetRef === 'string') {
        const [col, row] = targetRef.split(',').map(Number);
        await this.scene.animateMove(ship.id, [{ col, row }], { warp: true });
      }
      const res = useSystem(this.state, ship, targetRef);
      if (!res.ok) {
        audio.play('error');
        this.hud.toast(res.reason, 'bad');
        return;
      }
      this.playEvents(res.events);
      await this.scene.sleep(300);
      checkEnd(this.state);
      this.advanceSelection();
    });
  }

  // ------------------------------------------------------------ enemy turn

  async endPhase() {
    if (!this.interactive) return;
    await this.sequence(async () => {
      this.clearPending();
      endPhase(this.state);
      this.hud.updateTop(this.state);
      audio.play('enemyTurn');
      this.hud.toast('ENEMY PHASE', 'enemy', 1400);
      audio.setTension(0.75);
      await this.scene.sleep(520);
      await this.runEnemyPhase();
      checkEnd(this.state);
      if (this.state.over) return;
      endPhase(this.state);
      audio.play('turnStart');
      audio.setTension(0.35);
      this.hud.toast(`ROUND ${this.state.round} — YOUR PHASE`, 'good', 1500);
      this.autoSelect();
    });
  }

  async runEnemyPhase() {
    let guard = 0;
    for (;;) {
      if (!this.state || this.state.over) break;
      const ship = nextEnemyShip(this.state);
      if (!ship || guard++ > 8) break;
      const plan = planShip(this.state, ship);
      this.scene.effects.lockRing(this.scene.worldFor(ship, 0.05), {
        color: 0xff6a5e, size: ship.cls.scale, dur: 0.7,
      });
      this.hud.toast(labelFor(ship), 'enemy', 900);
      for (const order of plan.orders) {
        if (!ship.alive || (this.state.over)) break;
        await this.runOrder(ship, order);
      }
      this.scene.sync(this.state);
      this.refresh();
      await this.scene.sleep(140);
    }
    this.scene.setTarget(null);
  }

  /** Animate and commit one order from an AI plan. Works for either team. */
  async runOrder(ship, order) {
    if (order.kind === 'move') {
      audio.play('thruster', { gain: 0.4 });
      await this.scene.animateMove(ship.id, order.cells);
      const res = executeOrder(this.state, ship, order);
      if (res && res.events) this.playEvents(res.events);
      return;
    }
    if (order.kind === 'rotate') {
      const res = executeOrder(this.state, ship, order);
      if (res && res.ok) await this.scene.animateRotate(ship.id, ship.facing);
      return;
    }
    if (order.kind === 'fire') {
      const res = executeOrder(this.state, ship, order);
      if (!res || !res.ok) return;
      this.playEvents(res.events);
      await this.flyShots(res.shots);
      return;
    }
    if (order.kind === 'system') {
      const sys = ship.cls.system;
      if (sys && sys.id === 'phase_shift' && typeof order.targetRef === 'string') {
        const [col, row] = order.targetRef.split(',').map(Number);
        await this.scene.animateMove(ship.id, [{ col, row }], { warp: true });
      }
      const res = executeOrder(this.state, ship, order);
      if (res && res.events) this.playEvents(res.events);
      await this.scene.sleep(240);
      return;
    }
    if (order.kind === 'recharge') {
      const res = executeOrder(this.state, ship, order);
      if (res && res.events) this.playEvents(res.events);
      await this.scene.sleep(200);
    }
  }

  // ---------------------------------------------------------------- events

  playEvents(events) {
    for (const ev of events || []) {
      if (ev) this.playEvent(ev);
    }
  }

  playEvent(ev) {
    const sc = this.scene;
    const at = (id, y = 0.5) => {
      const s = shipById(this.state, id);
      return s ? sc.worldFor(s, y) : null;
    };
    switch (ev.type) {
      case 'log':
        this.hud.addLog({ text: ev.text, kind: ev.kind, round: this.state ? this.state.round : 0 });
        break;
      case 'fire': {
        const from = at(ev.fromId, 0.45);
        const to = at(ev.targetId, 0.45);
        if (from && to) {
          const dir = to.clone().sub(from).normalize();
          const shooter = shipById(this.state, ev.fromId);
          sc.effects.muzzle(from, dir, KIND_COLOR[ev.weaponKind] || 0xffffff, (shooter ? shooter.cls.scale : 1) * 1.1);
        }
        audio.play(FIRE_SFX[ev.weaponKind] || 'fireKinetic');
        break;
      }
      case 'hit': {
        const p = at(ev.targetId, 0.5);
        if (!p) break;
        const target = shipById(this.state, ev.targetId);
        const size = (target ? target.cls.scale : 1) * (ev.crit ? 1.35 : 1);
        sc.effects.impact(p, { kind: ev.kind, crit: ev.crit, shield: ev.shield, hull: ev.hull, size });
        if (ev.shield > 0) sc.effects.damageNumber(p.clone().add(sc.upVec(0.5, 0.4, 0)), ev.shield, { shield: true });
        if (ev.hull > 0) sc.effects.damageNumber(p.clone().add(sc.upVec(-0.5, 0.5, 0)), ev.hull, { crit: ev.crit });
        sc.flash(ev.targetId);
        sc.shake(0.1 + Math.min(0.5, ev.hull * 0.012) + (ev.crit ? 0.18 : 0));
        audio.play(ev.shield > 0 && ev.hull === 0 ? 'shieldHit' : ev.hull >= 18 ? 'hullHit' : 'armorHit',
          { gain: ev.crit ? 1.1 : 0.9 });
        if (ev.crit) {
          sc.background.flash(0.35);
          this.hud.toast('CRITICAL HIT', 'good', 900);
        }
        break;
      }
      case 'miss': {
        const p = at(ev.targetId, 0.5);
        if (!p) break;
        sc.effects.damageNumber(p.clone().add(sc.upVec(0, 0.6, 0)), 'MISS', {});
        audio.play('uiBack', { gain: 0.4, rate: 1.4 });
        break;
      }
      case 'shieldBreak': {
        const p = at(ev.targetId, 0.5);
        const target = shipById(this.state, ev.targetId);
        if (p) sc.effects.shieldPop(p, (target ? target.cls.scale : 1) * 1.3);
        audio.play('shieldHit', { gain: 1.2, rate: 0.7 });
        this.hud.toast('SHIELD COLLAPSE — arrays jammed', target && target.team === 'player' ? 'bad' : 'good', 1400);
        break;
      }
      case 'shieldBurn': {
        this.hud.toast('Shield capacity burned', 'system', 1000);
        break;
      }
      case 'splash': {
        const p = at(ev.targetId, 0.5);
        if (!p) break;
        sc.effects.impact(p, { kind: 'kinetic', hull: ev.hull, shield: ev.shield, size: 0.7 });
        if (ev.hull > 0) sc.effects.damageNumber(p, ev.hull, {});
        sc.flash(ev.targetId);
        break;
      }
      case 'explode': {
        const s = shipById(this.state, ev.targetId);
        sc.sync(this.state);
        audio.play(ev.size === 'large' ? 'explodeLarge' : 'explodeSmall');
        sc.shake(ev.size === 'large' ? 0.75 : 0.5);
        sc.background.flash(ev.size === 'large' ? 0.5 : 0.3);
        if (s) this.hud.toast(`${labelFor(s)} lost`, s.team === 'player' ? 'bad' : 'good', 1800);
        break;
      }
      case 'system': {
        const p = at(ev.shipId, 0.5);
        const s = shipById(this.state, ev.shipId);
        if (p) sc.effects.aura(p, { color: s ? s.accent : 0x9fe8ff, size: s ? s.cls.scale : 1 });
        audio.play('system');
        break;
      }
      case 'buff': {
        const p = at(ev.shipId, 0.5);
        const s = shipById(this.state, ev.shipId);
        if (p) sc.effects.aura(p, { color: s ? s.accent : 0x9fe8ff, size: s ? s.cls.scale : 1 });
        if (s && s.team === 'player') this.hud.toast(`${s.name}: ${ev.status.toUpperCase()}`, 'system', 1000);
        break;
      }
      case 'shieldUp': {
        const p = at(ev.shipId, 0.5);
        const s = shipById(this.state, ev.shipId);
        if (!p) break;
        sc.effects.aura(p, { color: 0x7dffb1, size: s ? s.cls.scale : 1 });
        if (ev.amount > 0) sc.effects.damageNumber(p, ev.amount, { heal: true });
        audio.play('shieldUp');
        break;
      }
      case 'recharge': {
        const p = at(ev.shipId, 0.5);
        if (p && ev.amount > 0) sc.effects.damageNumber(p, ev.amount, { heal: true });
        audio.play('shieldUp', { gain: 0.8 });
        break;
      }
      case 'hazard': {
        const p = at(ev.targetId, 0.4);
        if (!p) break;
        sc.effects.impact(p, { kind: 'kinetic', hull: ev.hull, size: 0.6 });
        sc.effects.damageNumber(p, ev.hull, {});
        audio.play('hullHit', { gain: 0.6 });
        break;
      }
      case 'phase': {
        const to = shipById(this.state, ev.shipId);
        if (to) sc.effects.warp(sc.worldFor(to, 0.3), { color: 0xb98cff });
        break;
      }
      default:
        break;
    }
  }

  // ----------------------------------------------------------------- paint

  refresh() {
    if (!this.state) return;
    const over = checkEnd(this.state);
    this.hud.updateTop(this.state);
    const sel = this.sel;
    const shown = (this.inspectId && shipById(this.state, this.inspectId)) || sel;
    const aimMap = new Map();
    if (shown && shown.alive && this.hoverTargetId) {
      for (const w of shown.cls.weapons) {
        const rep = aimReport(this.state, shown, w.id, this.hoverTargetId);
        if (rep.ok) aimMap.set(w.id, rep);
      }
    }
    this.hud.updateInspector(this.state, shown, aimMap);
    this.hud.setContext(this.contextFor(sel));
    this.scene.setSelected(this.pendingMode ? null : sel && sel.alive ? sel.id : null);
    this.scene.setTarget(this.hoverTargetId || null);
    this.paintOverlays(sel);
    if (this.threatOn) this.paintThreat();
    if (over && !this.resultShown) {
      this.resultShown = true;
      audio.play(over.result === 'victory' ? 'victory' : 'defeat');
      audio.setTension(over.result === 'victory' ? 0.05 : 0.9);
      setTimeout(() => this.screens.showResult(over, this.state), 1200);
    }
  }

  contextFor(sel) {
    const st = this.state;
    let hint = '';
    if (!st) hint = 'Stand by.';
    else if (st.over) hint = 'Combat resolved.';
    else if (st.phase !== 'player') hint = 'Enemy phase — hold.';
    else if (this.pendingMode === 'weapon') hint = 'Click an enemy to fire · Esc holds fire';
    else if (this.pendingMode === 'system') hint = 'Click a highlighted hex to run the system · Esc cancels';
    else if (!sel) hint = 'Select one of your ships — 1 to 5, or click a hull';
    else if (sel.acted) hint = `${sel.name} has acted. Pick another ship, or end the phase`;
    else {
      const bits = [];
      if (!sel.moved) bits.push('click a cyan hex to move');
      if (!sel.rotated) bits.push('R turns 60°');
      bits.push('pick a weapon');
      hint = `${sel.name}: ${bits.join(' · ')}`;
    }
    const rest = st && st.phase === 'player' ? shipsOf(st, 'player').filter((s) => !s.acted).length : 0;
    if (st && st.phase === 'player' && !st.over && rest === 0) {
      hint = 'All ships have acted — End Phase (Space)';
    }
    const sys = sel && sel.cls.system;
    return {
      selectedId: sel ? sel.id : null,
      pendingWeaponId: this.pendingWeaponId,
      canRotate: Boolean(sel) && this.interactive && !sel.acted && !sel.rotated,
      canRecharge: Boolean(sel) && this.interactive && !sel.acted && sel.shields < shieldMaxOf(sel),
      canSystem: Boolean(sel) && this.interactive && !sel.acted && sel.systemCharges > 0,
      systemLabel: sys ? `${sys.short} ${sel.systemCharges}` : 'SYSTEM',
      phase: st ? st.phase : 'player',
      hint,
      alert: Boolean(st && st.phase === 'player' && !st.over && rest === 0),
    };
  }

  /** Hexes a weapon can actually cover from the ship's current facing. */
  arcCells(ship, weapon) {
    const from = { col: ship.col, row: ship.row };
    const out = [];
    for (const cell of cellsWithin(this.state.map, from, weapon.range[1])) {
      const d = hexDistance(from, cell);
      if (d < weapon.range[0] || cell.blocksLos) continue;
      if (!inArc(ship.facing, weapon.arc, from, cell)) continue;
      out.push({ col: cell.col, row: cell.row });
    }
    return out;
  }

  paintOverlays(sel) {
    const grid = this.scene.grid;
    grid.clearOverlays();
    if (!this.state || !this.interactive || !sel || !sel.alive) return;

    if (this.pendingMode === 'weapon') {
      const weapon = findWeapon(sel, this.pendingWeaponId);
      if (!weapon) return;
      // Near-white gold: the envelope has to stay legible where it overlaps the
      // red threat wash, and a saturated amber on red just turns to mud.
      grid.setOverlay('arc', this.arcCells(sel, weapon), { opacity: 0.5, color: 0xfff0cc });
      const cells = shipsOf(this.state, 'enemy')
        .filter((foe) => aimReport(this.state, sel, weapon.id, foe.id).ok)
        .map((foe) => ({ col: foe.col, row: foe.row }));
      grid.setOverlay('aim', cells, { opacity: 0.8, color: 0xff5a68 });
      return;
    }
    if (this.pendingMode === 'system') {
      grid.setOverlay('aim', this.systemOptions(sel), { opacity: 0.8, color: 0xb98cff });
      return;
    }
    if (!sel.acted) {
      const moves = this.moveOptions(sel).map((o) => ({ col: o.col, row: o.row }));
      grid.setOverlay('move', moves, { opacity: 0.5, color: 0x4fd6ff });
      const seen = new Set();
      const arc = [];
      for (const w of sel.cls.weapons) {
        for (const cell of this.arcCells(sel, w)) {
          const key = `${cell.col},${cell.row}`;
          if (seen.has(key)) continue;
          seen.add(key);
          arc.push(cell);
        }
      }
      grid.setOverlay('arc', arc, { opacity: 0.11, color: 0xffc45c });
    }
  }

  paintThreat() {
    const cells = new Map();
    for (const foe of shipsOf(this.state, 'enemy')) {
      const from = { col: foe.col, row: foe.row };
      for (const weapon of foe.cls.weapons) {
        if ((foe.cooldowns[weapon.id] || 0) > 0) continue;
        for (const cell of cellsWithin(this.state.map, from, weapon.range[1])) {
          const d = hexDistance(from, cell);
          if (d < weapon.range[0] || cell.blocksLos) continue;
          // Arc and cover matter: a range paint that ignores facing drowns the
          // whole board in red and teaches the player nothing.
          if (!inArc(foe.facing, weapon.arc, from, cell)) continue;
          if (!lineOfSight(this.state.map, from, cell)) continue;
          const occupant = shipAt(this.state, cell.col, cell.row);
          if (occupant && occupant.team === 'enemy') continue;
          const key = `${cell.col},${cell.row}`;
          const power = ((weapon.dmg[0] + weapon.dmg[1]) / 2) * (weapon.acc / 100) * (weapon.hits || 1);
          const seen = cells.get(key);
          if (seen) seen.power += power;
          else cells.set(key, { col: cell.col, row: cell.row, power });
        }
      }
    }
    const list = [...cells.values()];
    let peak = 0;
    for (const c of list) peak = Math.max(peak, c.power);
    // Intensity is relative: where the enemy fleet concentrates fire the plate
    // burns hot, a single long-range lance only tints the hex. The low floor
    // matters — with every covered hex lit alike, the band reads as a red fog
    // and the hot hexes are indistinguishable from the merely reachable ones.
    const weights = list.map((c) => 0.2 + 0.8 * Math.pow(c.power / (peak || 1), 0.8));
    this.scene.grid.setOverlay('threat', list, { opacity: 0.3, color: 0xff3d55, weights });
    const ids = [];
    const sel = this.sel;
    if (sel) {
      for (const t of incomingThreat(this.state, sel)) ids.push(t.shipId);
    } else {
      for (const mine of shipsOf(this.state, 'player')) {
        for (const t of incomingThreat(this.state, mine).slice(0, 1)) ids.push(t.shipId);
      }
    }
    this.scene.setThreatIds([...new Set(ids)]);
  }

  // ---------------------------------------------------------------- toggles

  setSpeedIdx(i) {
    this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
    const mult = SPEEDS[this.speedIdx];
    this.scene.setSpeed(mult);
    audio.setSpeed(mult);
    this.hud.setSpeedLabel(mult);
  }

  cycleSpeed() {
    this.setSpeedIdx((this.speedIdx + 1) % SPEEDS.length);
    audio.play('uiClick');
  }

  toggleSound() {
    this.soundOn = !this.soundOn;
    audio.init();
    audio.setMuted(!this.soundOn);
    if (this.soundOn) audio.resume();
    else audio.suspend();
    this.hud.setSoundLabel(this.soundOn);
    if (this.soundOn) audio.play('uiClick');
  }

  toggleBloom() {
    this.bloomOn = !this.bloomOn;
    this.scene.setBloom(this.bloomOn);
    this.hud.setBloomLabel(this.bloomOn);
    audio.play('uiClick');
  }

  toggleThreat() {
    this.threatOn = !this.threatOn;
    this.hud.setThreatLabel(this.threatOn);
    audio.play('uiClick');
    if (this.threatOn) this.paintThreat();
    else {
      this.scene.grid.setOverlay('threat', []);
      this.scene.setThreatIds([]);
    }
  }

  toggleView() {
    this.topDown = !this.topDown;
    this.scene.cam.setTopDown(this.topDown);
    this.hud.setViewLabel(this.topDown);
    audio.play('uiClick');
  }
}

function boot() {
  const refs = {
    canvas: document.getElementById('stage'),
    hud: document.getElementById('hud'),
    screens: document.getElementById('screens'),
  };
  if (!refs.canvas || !refs.hud || !refs.screens) {
    console.error('Missing boot elements.');
    return;
  }
  const game = new Game(refs);
  window.VOID_LANCE = game;
  game.boot();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => game.scene.resize());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
