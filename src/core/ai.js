/**
 * Enemy fleet command: utility search over (hex, facing, action) tuples.
 *
 * Planning is pure — candidate positions are evaluated by temporarily pointing
 * the ship record at them and restoring it afterwards, so the AI can score
 * firing lines and incoming fire without mutating the battle. Execution is
 * delegated back to the same order functions the player uses, which keeps
 * both fleets bound by identical rules and emits identical event objects.
 */

import { cellAt, reachOptions, teleportOptions } from './paths.js';
import {
  applyShot,
  estimateShot,
  fireWeapon,
  incomingThreat,
  moveShip,
  recharge,
  rotateShip,
  threatScore,
  thrustOf,
  useSystem,
} from './combat.js';
import { hexDistance } from './hex.js';

/** Relative value of the terms competing in the utility function. */
const W = {
  damage: 1.0,
  kill: 55,
  killHull: 0.35,
  shieldBreak: 6,
  aspectAft: 5,
  aspectBroad: 2.5,
  focus: 7,
  threat: 0.34,
  advance: 0.42,
  allyRadius: 4,
  ally: 1.1,
  debris: 2.2,
  hazard: 2.6,
};

function teammates(state, ship, aliveOnly = true) {
  const out = [];
  for (const other of state.ships.values()) {
    if (other.id === ship.id || other.team !== ship.team) continue;
    if (aliveOnly && !other.alive) continue;
    out.push(other);
  }
  return out;
}

function foes(state, ship) {
  const out = [];
  for (const other of state.ships.values()) {
    if (other.team === ship.team || !other.alive) continue;
    out.push(other);
  }
  return out;
}

function nearestRange(a, list) {
  let best = Infinity;
  for (const other of list) best = Math.min(best, hexDistance(a, other));
  return best;
}

/** Every hex the ship could occupy this phase, and how it would get there. */
function positions(state, ship) {
  const sys = ship.cls.system;
  const canPhase = !!sys && sys.id === 'phase_shift' && ship.systemCharges > 0;
  const out = [{ col: ship.col, row: ship.row, cells: [], mode: 'stay', cost: 0 }];

  for (const opt of reachOptions(state, ship, thrustOf(ship))) {
    if (opt.col === ship.col && opt.row === ship.row) continue;
    out.push({ col: opt.col, row: opt.row, cells: opt.cells, mode: 'move', cost: opt.cost });
  }
  if (canPhase) {
    for (const opt of teleportOptions(state, ship, sys.radius || 3)) {
      out.push({ col: opt.col, row: opt.row, cells: [], mode: 'phase', cost: opt.dist });
    }
  }
  return out;
}

/**
 * Value of spending the action on the ship's system instead of shooting.
 * @returns {{kind: string, targetRef: string|null, score: number}|null}
 */
function systemAction(state, ship, threat) {
  const sys = ship.cls.system;
  if (!sys || ship.systemCharges <= 0 || sys.id === 'phase_shift') return null;
  const missingShield = ship.shieldMax - ship.shields;

  switch (sys.id) {
    case 'fortify': {
      const score = 6 + Math.min(22, threat * 0.55) + Math.min(14, missingShield * 0.35);
      return { kind: 'system', targetRef: null, score };
    }
    case 'aegis': {
      let best = null;
      for (const ally of teammates(state, ship)) {
        const d = hexDistance(ship, ally);
        if (d > (sys.radius || 3)) continue;
        const missing = ally.shieldMax - ally.shields;
        const wounded = ally.hull < ally.hullMax * 0.65;
        if (missing < 6 && !wounded) continue;
        const score =
          4 +
          Math.min(20, missing * 0.5) +
          Math.min(16, threatScore(state, ally) * 0.4) +
          (wounded ? 6 : 0);
        if (!best || score > best.score) best = { kind: 'system', targetRef: ally.id, score };
      }
      return best;
    }
    case 'overdrive': {
      const score = 4 + threat * 0.35 + (ship.hull < ship.hullMax * 0.5 ? 3 : 0);
      return { kind: 'system', targetRef: null, score };
    }
    case 'saturation': {
      const swarm = ship.cls.weapons.find((w) => w.id === 'swarm_launchers');
      if (!swarm) return null;
      let inRange = 0;
      for (const foe of foes(state, ship)) {
        const d = hexDistance(ship, foe);
        if (d >= swarm.range[0] && d <= swarm.range[1]) inRange += 1;
      }
      if (!inRange) return null;
      return { kind: 'system', targetRef: null, score: 7 + inRange * 1.5 };
    }
    default:
      return null;
  }
}

/** Value of nursing shields back instead of fighting. */
function rechargeAction(state, ship, threat) {
  const missing = ship.shieldMax - ship.shields;
  if (missing <= 0) return null;
  const ratio = missing / ship.shieldMax;
  const pressure = Math.min(24, threat * 0.6);
  return { kind: 'recharge', targetRef: null, score: ratio * 16 + pressure * ratio };
}

/**
 * Pick this ship's whole turn: where to go, how to face, what to do.
 * @returns {{shipId: string, orders: object[], reason: string, score: number}}
 */
export function planShip(state, ship) {
  if (!ship.alive) return { shipId: ship.id, orders: [], reason: 'destroyed', score: 0 };
  if (ship.acted) return { shipId: ship.id, orders: [], reason: 'already acted', score: 0 };

  const diff = state.difficulty || {};
  const noise = diff.aiNoise ?? 8;
  const aggression = diff.aggression ?? 1;
  const focus = diff.focus ?? 1;
  const targets = foes(state, ship);
  const pals = teammates(state, ship);

  let best = null;

  for (const pos of positions(state, ship)) {
    const prevCol = ship.col;
    const prevRow = ship.row;
    const prevFacing = ship.facing;
    ship.col = pos.col;
    ship.row = pos.row;

    const threat = threatScore(state, ship);
    const cell = cellAt(state, pos.col, pos.row);
    let base = -threat * W.threat * aggression;
    base += (6 - Math.min(nearestRange(ship, targets), 6)) * W.advance * aggression;
    if (pals.length) base += Math.max(0, W.allyRadius - nearestRange(ship, pals)) * W.ally;
    if (cell && cell.debris) base += W.debris - (pos.mode === 'move' ? W.hazard : 0);

    const candidates = [];
    if (pos.mode === 'phase') {
      candidates.push({ kind: 'system', targetRef: `${pos.col},${pos.row}`, score: 0 });
    } else {
      const sys = systemAction(state, ship, threat);
      if (sys) candidates.push(sys);
      const rec = rechargeAction(state, ship, threat);
      if (rec) candidates.push(rec);
    }

    let bestFacing = prevFacing;
    let bestAttack = null;
    if (pos.mode !== 'phase') {
      for (const weapon of ship.cls.weapons) {
        if ((ship.cooldowns[weapon.id] || 0) > 0) continue;
        for (const target of targets) {
          // Turn from the current heading outward and take the smallest
          // rotation that brings this target into the weapon's arc.
          for (let turn = 0; turn < 6; turn += 1) {
            ship.facing = (prevFacing + turn) % 6;
            const est = estimateShot(state, ship, weapon, target);
            if (!est.ok) continue;
            let score = est.expected * W.damage;
            const killed = est.expectedShield >= target.shields && est.expectedHull >= target.hull;
            if (killed) score += W.kill + target.cls.hull * W.killHull;
            else if (est.breaksShield) score += W.shieldBreak;
            if (est.aspect === 2) score += W.aspectAft;
            else if (est.aspect === 1) score += W.aspectBroad;
            score += (1 - target.hull / target.hullMax) * W.focus * focus;
            if (!bestAttack || score > bestAttack.score) {
              bestAttack = { score, facing: ship.facing, weaponId: weapon.id, targetId: target.id, est };
            }
            break;
          }
        }
      }
      if (bestAttack) {
        bestFacing = bestAttack.facing;
        candidates.push({ kind: 'fire', weaponId: bestAttack.weaponId, targetId: bestAttack.targetId, score: bestAttack.score });
      }
    }

    ship.facing = prevFacing;
    for (const action of candidates) {
      const scored = {
        pos,
        action,
        facing: action.kind === 'fire' ? bestFacing : bestFacingFor(state, ship, pos, prevFacing),
        score: base + action.score + state.rng() * noise,
      };
      if (!best || scored.score > best.score) best = scored;
    }

    ship.col = prevCol;
    ship.row = prevRow;
    ship.facing = prevFacing;
  }

  if (!best) return { shipId: ship.id, orders: [], reason: 'no legal option', score: 0 };

  const orders = [];
  const { pos, action, facing } = best;
  if (pos.mode === 'move') orders.push({ kind: 'move', col: pos.col, row: pos.row, cells: pos.cells });
  if ((facing % 6) !== (ship.facing % 6)) orders.push({ kind: 'rotate', facing });
  orders.push(action);

  return {
    shipId: ship.id,
    orders,
    reason: describe(best, ship),
    score: Math.round(best.score * 10) / 10,
  };
}

/** Facing when the action is not a shot: keep it, or turn toward the fight. */
function bestFacingFor(state, ship, pos, current) {
  const prevCol = ship.col;
  const prevRow = ship.row;
  ship.col = pos.col;
  ship.row = pos.row;
  const list = foes(state, ship);
  let facing = current;
  let bestDist = Infinity;
  for (const foe of list) {
    const d = hexDistance(ship, foe);
    if (d < bestDist) {
      bestDist = d;
      facing = facingToward(ship, foe, current);
    }
  }
  ship.col = prevCol;
  ship.row = prevRow;
  return facing;
}

function facingToward(from, to, current) {
  const dc = to.col - from.col;
  const dr = to.row - from.row;
  if (dc === 0 && dr === 0) return current;
  // Chase the nearest axial direction using the odd-r offset layout.
  const parity = from.row & 1;
  const axialQ = from.col - ((from.row - (parity ? 1 : 0)) >> 1);
  const toParity = to.row & 1;
  const toQ = to.col - ((to.row - (toParity ? 1 : 0)) >> 1);
  const dq = toQ - axialQ;
  const drx = to.row - from.row;
  const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  let bestDir = current;
  let bestDot = -Infinity;
  const len = Math.hypot(dq, drx) || 1;
  for (let i = 0; i < 6; i += 1) {
    const [aq, ar] = dirs[i];
    const dot = (aq * dq + ar * drx) / len;
    if (dot > bestDot) {
      bestDot = dot;
      bestDir = i;
    }
  }
  return bestDir;
}

function describe(best, ship) {
  const { pos, action } = best;
  const where = pos.mode === 'stay' ? 'holds station' : `${pos.mode === 'phase' ? 'phases' : 'moves'} to ${pos.col},${pos.row}`;
  if (action.kind === 'fire') return `${ship.name} ${where}, fires ${action.weaponId}`;
  if (action.kind === 'system') return `${ship.name} ${where}, runs system`;
  if (action.kind === 'recharge') return `${ship.name} ${where}, recharges`;
  return `${ship.name} ${where}`;
}

/** The enemy ship that should act next: front line first, deterministic. */
export function nextEnemyShip(state) {
  const list = [];
  for (const s of state.ships.values()) {
    if (s.team !== 'enemy' || !s.alive || s.acted) continue;
    list.push({ s, d: nearestRange(s, foes(state, s)) });
  }
  list.sort((a, b) => a.d - b.d || a.s.index - b.s.index);
  return list.length ? list[0].s : null;
}

/** Run one order through the shared rules engine. */
export function executeOrder(state, ship, order) {
  switch (order.kind) {
    case 'move':
      return moveShip(state, ship, order.col, order.row, order.cells);
    case 'rotate':
      return rotateShip(state, ship, order.facing);
    case 'fire':
      return fireWeapon(state, ship, order.weaponId, order.targetId);
    case 'system':
      return useSystem(state, ship, order.targetRef);
    case 'recharge':
      return recharge(state, ship);
    default:
      return { ok: false, reason: 'Unknown order' };
  }
}

/**
 * Full enemy turn, resolved immediately (no animation). Used by tests and as
 * the reference behaviour the animated path in main.js reproduces.
 */
export function runEnemyPhase(state, emit = () => {}) {
  const events = [];
  let guard = 0;
  for (;;) {
    const ship = nextEnemyShip(state);
    if (!ship || guard++ > 16) break;
    const plan = planShip(state, ship);
    events.push({ type: 'aiPlan', shipId: ship.id, reason: plan.reason });
    for (const order of plan.orders) {
      const res = executeOrder(state, ship, order);
      if (res && res.events) events.push(...res.events);
      if (!res || res.ok === false) break;
      if (order.kind === 'fire') {
        for (const shot of res.shots || []) events.push(...applyShotSafe(state, shot));
      }
    }
  }
  const ev = events.filter(Boolean);
  emit(ev);
  return ev;
}

function applyShotSafe(state, shot) {
  const res = applyShot(state, shot);
  return res ? res.events : [];
}

/** Ordered list of player ships that could be targeted, for AI diagnostics. */
export function targetPool(state) {
  const out = [];
  for (const s of state.ships.values()) {
    if (s.team === 'player' && s.alive) out.push(s);
  }
  return out;
}

/** Quick threat readout for the HUD's danger overlay. */
export function threatFor(state, ship) {
  const list = incomingThreat(state, ship, { ignoreActed: false });
  return { count: list.length, score: threatScore(state, ship) };
}
