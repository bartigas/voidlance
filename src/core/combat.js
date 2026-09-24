// Firing arcs, coverage, hit resolution and every order the player or the AI
// can give a ship. Everything here is pure over the game state object, so the
// AI can dry-run actions and the UI can preview results without committing.

import { ARC, RULES, ASPECT_ARMOR, WEAPON_KIND } from './data.js';
import {
  ASPECT_FORE,
  cellKey,
  hexDistance,
  lineOfSight,
  neighbor,
  aspectToward,
  directionToward,
} from './hex.js';
import { cellAt, shipAt, teleportOptions } from './paths.js';

// ---------------------------------------------------------------- statuses

export function addStatus(ship, key, data = {}) {
  const prev = ship.status[key];
  const next = {
    turns: data.turns ?? 1,
    expiresAt: data.expiresAt ?? 'selfTurnStart',
    ...data,
  };
  if (prev) next.turns = Math.max(next.turns, prev.turns);
  ship.status[key] = next;
}

export function hasStatus(ship, key) {
  const s = ship.status[key];
  return !!s && s.turns > 0;
}

export function removeStatus(ship, key) {
  delete ship.status[key];
}

// 'selfTurnStart' burns down at the start of the owner's own activation,
// 'selfTurnEnd' at the end of it (so "until next turn" effects last a full
// enemy phase).
export function tickStatuses(ship, when) {
  for (const key of Object.keys(ship.status)) {
    const s = ship.status[key];
    if (s.expiresAt !== when) continue;
    if (when === 'selfTurnStart') {
      s.turns -= 1;
      if (s.turns <= 0) delete ship.status[key];
    } else {
      delete ship.status[key];
    }
  }
}

// ------------------------------------------------------------ derived stats

export function armorBase(ship) {
  return ship.cls.armor + (hasStatus(ship, 'fortified') ? 2 : 0);
}

// Aspect multiplies the ship's base armour: 100% fore, ~67% broad, ~33% aft.
export function armorValue(ship, aspect) {
  return (armorBase(ship) * ASPECT_ARMOR[aspect]) / 3;
}

export function thrustOf(ship) {
  return ship.cls.thrust + (hasStatus(ship, 'overdrive') ? 3 : 0);
}

export function evadeOf(ship) {
  return ship.cls.evade + (hasStatus(ship, 'overdrive') ? 15 : 0);
}

export function regenOf(ship) {
  return Math.max(0, ship.cls.regen - ship.shieldBurn);
}

export function shieldMaxOf(ship) {
  return ship.cls.shield;
}

// ------------------------------------------------------------------ targeting

// Facing is a world direction index; arcs are expressed relative to it.
export function relativeArc(facing, arc) {
  return ARC[arc];
}

export function inArc(facing, arc, fromCell, toCell) {
  const rel = (directionToward(fromCell, toCell) - facing + 6) % 6;
  return ARC[arc].includes(rel);
}

export function arcWorldDirs(facing, arc) {
  return ARC[arc].map((rel) => (facing + rel) % 6);
}

// Intermediate hexes between two cells (exclusive) for debris screening.
export function hexLine(a, b) {
  const toCube = (c) => {
    const q = c.col - (c.row - (c.row & 1)) / 2;
    const r = c.row;
    return { q, r, s: -q - r };
  };
  const round = (v) => {
    let rq = Math.round(v.q), rr = Math.round(v.r), rs = Math.round(v.s);
    const dq = Math.abs(rq - v.q), dr = Math.abs(rr - v.r), ds = Math.abs(rs - v.s);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    else rs = -rq - rr;
    return { q: rq, r: rr };
  };
  const from = toCube(a), to = toCube(b);
  const n = Math.max(Math.abs(from.q - to.q), Math.abs(from.r - to.r), Math.abs(from.s - to.s));
  const out = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const c = round({
      q: from.q + (to.q - from.q) * t,
      r: from.r + (to.r - from.r) * t,
      s: from.s + (to.s - from.s) * t,
    });
    const row = c.r;
    const col = c.q + (row - (row & 1)) / 2;
    out.push({ col, row });
  }
  return out;
}

// Total to-hit penalty from terrain: the target's own cover plus any debris
// field the shot has to punch through.
export function coverPenalty(state, attacker, target, ignoreCover) {
  if (ignoreCover) return 0;
  let penalty = 0;
  const own = cellAt(state, target.col, target.row);
  if (own && own.debris) penalty += RULES.debrisCover;
  else {
    for (let d = 0; d < 6; d++) {
      const n = neighbor(target.col, target.row, d);
      const c = state.map.get(cellKey(n.col, n.row));
      if (c && c.blocksLos) {
        penalty += RULES.coverPenalty;
        break;
      }
    }
  }
  for (const mid of hexLine({ col: attacker.col, row: attacker.row }, { col: target.col, row: target.row })) {
    const c = state.map.get(cellKey(mid.col, mid.row));
    if (c && c.debris) {
      penalty += RULES.debrisCover;
      break;
    }
  }
  return penalty;
}

export function targetCheck(state, attacker, weapon, target) {
  if (!target || !target.alive) return { ok: false, reason: 'No target' };
  if (target.team === attacker.team) return { ok: false, reason: 'Friendly ship' };
  const from = { col: attacker.col, row: attacker.row };
  const to = { col: target.col, row: target.row };
  const dist = hexDistance(from, to);
  if (dist < weapon.range[0]) return { ok: false, reason: `Out of range (${dist} < ${weapon.range[0]})`, dist };
  if (dist > weapon.range[1]) return { ok: false, reason: `Out of range (${dist} > ${weapon.range[1]})`, dist };
  if (!inArc(attacker.facing, weapon.arc, from, to)) {
    return { ok: false, reason: 'Target outside firing arc', dist };
  }
  if (!lineOfSight(state.map, from, to)) return { ok: false, reason: 'Blocked by asteroid', dist };
  return { ok: true, dist };
}

// ---------------------------------------------------------------- weapons

export function findWeapon(ship, weaponId) {
  return ship.cls.weapons.find((w) => w.id === weaponId) || null;
}

export function d100(state) {
  return Math.floor(state.rng() * 100) + 1;
}

export function saturationActive(ship) {
  return hasStatus(ship, 'saturation');
}

// ------------------------------------------------------------------- to-hit

export function computeHitChance(state, attacker, weapon, target, opts = {}) {
  const check = targetCheck(state, attacker, weapon, target);
  if (!check.ok) return { ...check, hitChance: 0 };
  const dist = check.dist;
  let acc = weapon.acc;
  if (attacker.team === 'enemy') acc += state.difficulty.accMod;
  if (dist < weapon.range[0]) acc += RULES.rangeAcc.short;
  if (dist > weapon.range[1]) acc += RULES.rangeAcc.long;
  if (weapon.kind === 'torpedo' && dist >= weapon.range[1]) acc += RULES.torpedoRangeAcc;
  acc -= evadeOf(target);
  if (hasStatus(attacker, 'jammed')) acc -= RULES.jamPenalty;
  if (hasStatus(target, 'locked')) acc += RULES.lockBonus;
  const ignoreCover = opts.ignoreCover || saturationActive(attacker);
  const cover = coverPenalty(state, attacker, target, ignoreCover);
  acc -= cover;
  const hitChance = Math.max(RULES.minHit, Math.min(RULES.maxHit, Math.round(acc)));
  return { ok: true, dist, cover, hitChance };
}

// ------------------------------------------------------------------ damage

// Shared shield/hull split: shields soak at the weapon's shield multiplier,
// whatever is left over (converted back through that multiplier) eats hull.
function splitDamage(raw, kind, reduction, shields) {
  const afterArmor = kind.ignoresArmor ? raw : Math.max(1, raw - reduction);
  const eff = afterArmor * kind.vsShield;
  if (eff <= shields) return { shield: eff, hull: 0 };
  return { shield: shields, hull: (eff - shields) / kind.vsShield };
}

// Average single-pod damage split into the shield / hull it would consume so
// the UI can advertise a credible range and the AI can rank options.
export function expectedDamage(state, attacker, weapon, target) {
  const kind = WEAPON_KIND[weapon.kind];
  const mid = (weapon.dmg[0] + weapon.dmg[1]) / 2;
  const aspect = aspectToward({ col: attacker.col, row: attacker.row }, target, target.facing);
  const reduction = kind.ignoresArmor ? 0 : armorValue(target, aspect) * (1 - (kind.pierce || 0));
  const parts = splitDamage(mid, kind, reduction, target.shields);
  return {
    aspect,
    shield: parts.shield,
    hull: parts.hull,
    total: parts.shield + parts.hull,
    breaksShield: parts.hull > 0,
  };
}

export function podCount(attacker, weapon) {
  const base = weapon.hits || 1;
  if (weapon.id === 'swarm_launchers' && saturationActive(attacker)) return base + 2;
  return base;
}

// Full projection used by both the targeting overlay and the AI.
export function estimateShot(state, attacker, weapon, target) {
  const base = computeHitChance(state, attacker, weapon, target);
  if (!base.ok) return { ...base, pods: 0, avgPerPod: 0, expected: 0, expectedHull: 0 };
  const pods = podCount(attacker, weapon);
  const exp = expectedDamage(state, attacker, weapon, target);
  const rate = base.hitChance / 100;
  return {
    ok: true,
    dist: base.dist,
    cover: base.cover,
    aspect: exp.aspect,
    pods,
    hitChance: base.hitChance,
    avgPerPod: exp.total,
    expected: exp.total * rate * pods,
    expectedHull: exp.hull * rate * pods,
    expectedShield: exp.shield * rate * pods,
    breaksShield: exp.breaksShield,
  };
}

// What the HUD shows next to a weapon once a target is picked.
export function aimReport(state, attacker, weaponId, targetId) {
  const weapon = findWeapon(attacker, weaponId);
  if (!weapon) return { ok: false, reason: 'Unknown weapon' };
  const target = state.ships.get(targetId);
  const est = estimateShot(state, attacker, weapon, target);
  if (!est.ok) return est;
  const kind = WEAPON_KIND[weapon.kind];
  const aspect = est.aspect;
  const reduction = kind.ignoresArmor ? 0 : armorValue(target, aspect) * (1 - (kind.pierce || 0));
  const lo = splitDamage(weapon.dmg[0], kind, reduction, target.shields);
  const hi = splitDamage(weapon.dmg[1], kind, reduction, target.shields);
  return {
    ok: true,
    weapon,
    targetId,
    dist: est.dist,
    hitChance: est.hitChance,
    pods: est.pods,
    cover: est.cover,
    aspect,
    minDmg: Math.round((lo.shield + lo.hull) * est.pods),
    maxDmg: Math.round((hi.shield + hi.hull) * est.pods),
    expected: est.expected,
    expectedHull: est.expectedHull,
    expectedShield: est.expectedShield,
    breaksShield: est.breaksShield,
  };
}

// --------------------------------------------------------------- threat map

export function incomingThreat(state, ship, opts = {}) {
  const out = [];
  for (const other of state.ships.values()) {
    if (!other.alive || other.team === ship.team) continue;
    if (opts.ignoreActed && other.acted) continue;
    for (const weapon of other.cls.weapons) {
      if ((other.cooldowns[weapon.id] || 0) > 0) continue;
      const check = computeHitChance(state, other, weapon, ship);
      if (!check.ok) continue;
      out.push({
        shipId: other.id,
        weaponId: weapon.id,
        weapon,
        hitChance: check.hitChance,
        dist: check.dist,
        damage: expectedDamage(state, other, weapon, ship).total,
      });
    }
  }
  out.sort((a, b) => b.damage * b.hitChance - a.damage * a.hitChance);
  return out;
}

export function threatScore(state, ship) {
  let total = 0;
  for (const t of incomingThreat(state, ship, { ignoreActed: true })) {
    total += t.damage * (t.hitChance / 100);
  }
  return total;
}

// ---------------------------------------------------------------- destruction

export function killShip(state, ship) {
  if (!ship.alive) return [];
  ship.alive = false;
  ship.hull = 0;
  ship.shields = 0;
  ship.status = {};
  return [
    { type: 'explode', targetId: ship.id, size: ship.cls.scale > 1.1 ? 'large' : 'small' },
    {
      type: 'log',
      text: `${ship.name} "${ship.cls.name}" is destroyed.`,
      kind: ship.team === 'player' ? LOG_KIND.bad : LOG_KIND.good,
    },
  ];
}

// Armour is applied first (unless the weapon ignores it), then shields soak at
// the weapon's shield multiplier, then the remainder eats hull.
export function applyDamage(state, target, raw, kind, aspect, opts = {}) {
  const kd = WEAPON_KIND[kind] || WEAPON_KIND.kinetic;
  const before = target.shields;
  const reduction = kd.ignoresArmor || opts.ignoreArmor
    ? 0
    : armorValue(target, aspect) * (1 - (kd.pierce || 0));
  const parts = splitDamage(raw, kd, reduction, before);
  target.shields = Math.max(0, before - parts.shield);
  const hullDmg = parts.hull > 0 ? Math.max(1, Math.round(parts.hull)) : 0;
  if (hullDmg > 0) target.hull = Math.max(0, target.hull - hullDmg);

  const shieldBreak = before > 0 && target.shields === 0;
  let destroyed = false;
  let deathEvents = [];
  if (target.hull <= 0) {
    destroyed = true;
    deathEvents = killShip(state, target);
  }
  return { shield: parts.shield, hull: hullDmg, shieldBreak, destroyed, deathEvents };
}

// ---------------------------------------------------------------- firing

// Flight time per weapon kind drives the render/audio sequencing; the roll is
// resolved immediately so the AI and UI always agree with the committed state.
const KIND_DELAY = { kinetic: 240, energy: 420, torpedo: 1000, missile: 900 };

// Torpedoes detonate, so adjacent hulls take a scratch hit.
function splashTargets(state, target) {
  const out = [];
  for (let d = 0; d < 6; d++) {
    const n = neighbor(target.col, target.row, d);
    const victim = shipAt(state, n.col, n.row);
    if (victim && victim.alive && victim.team !== target.team) {
      out.push({ shipId: victim.id });
    }
  }
  return out;
}

export function fireWeapon(state, attacker, weaponId, targetId) {
  if (!attacker || !attacker.alive) return { ok: false, reason: 'Ship is destroyed' };
  if (attacker.acted) return { ok: false, reason: `${attacker.name} has already acted` };
  const weapon = findWeapon(attacker, weaponId);
  if (!weapon) return { ok: false, reason: 'Unknown weapon' };
  const target = state.ships.get(targetId);
  if (!target) return { ok: false, reason: 'Unknown target' };

  const ignoreCover = saturationActive(attacker);
  const check = computeHitChance(state, attacker, weapon, target, { ignoreCover });
  if (!check.ok) return check;

  const pods = podCount(attacker, weapon);
  const fromCell = { col: attacker.col, row: attacker.row };
  const shots = [];
  for (let i = 0; i < pods; i++) {
    const roll = d100(state);
    const hit = roll <= check.hitChance;
    const crit = hit && roll <= RULES.critRoll;
    const span = weapon.dmg[1] - weapon.dmg[0] + 1;
    const raw = weapon.dmg[0] + Math.floor(state.rng() * span);
    const dmg = hit ? Math.round(raw * (crit ? RULES.critMult : 1)) : 0;
    shots.push({
      fromId: attacker.id,
      targetId: target.id,
      weaponName: weapon.name,
      kind: weapon.kind,
      hit,
      crit,
      dmg,
      aspect: aspectToward(fromCell, { col: target.col, row: target.row }, target.facing),
      hitChance: check.hitChance,
      shieldBurn: weapon.shieldBurn || 0,
      splash: weapon.kind === 'torpedo' ? splashTargets(state, target) : [],
      delayMs: (KIND_DELAY[weapon.kind] || 300) + i * 70,
    });
  }

  attacker.acted = true;
  attacker.cooldowns[weaponId] = weapon.cooldown;
  if (weapon.id === 'swarm_launchers') removeStatus(attacker, 'saturation');

  return {
    ok: true,
    weapon,
    fromId: attacker.id,
    targetId: target.id,
    shots,
    events: [
      {
        type: 'fire',
        fromId: attacker.id,
        weaponId,
        weaponKind: weapon.kind,
        targetId: target.id,
        pods,
      },
      {
        type: 'log',
        text: `${attacker.name} fires ${weapon.name} at ${target.name}.`,
        kind: attacker.team === 'player' ? LOG_KIND.player : LOG_KIND.enemy,
      },
    ],
  };
}

// Applies one already-rolled shot once its projectile has finished flying.
export function applyShot(state, shot) {
  const attacker = state.ships.get(shot.fromId);
  const target = state.ships.get(shot.targetId);
  const events = [];
  if (!target || !target.alive) return { events, destroyed: false, dealt: 0 };

  if (!shot.hit) {
    events.push({ type: 'miss', targetId: target.id });
    events.push({
      type: 'log',
      text: `${attacker ? attacker.name : 'A'} shot misses ${target.name}.`,
      kind: LOG_KIND.info,
    });
    return { events, destroyed: false, dealt: 0 };
  }

  const res = applyDamage(state, target, shot.dmg, shot.kind, shot.aspect);
  const dealt = Math.round(res.shield) + res.hull;

  events.push({
    type: 'hit',
    targetId: target.id,
    kind: shot.kind,
    aspect: shot.aspect,
    crit: shot.crit,
    shield: Math.round(res.shield),
    hull: res.hull,
    shieldBreak: res.shieldBreak,
  });

  let text = `${attacker ? attacker.name : 'A'} hits ${target.name} with ${shot.weaponName} for ${dealt}`;
  if (res.shieldBreak) text += ' — SHIELD BREAK';
  events.push({ type: 'log', text, kind: shot.crit ? LOG_KIND.good : LOG_KIND.info });

  if (shot.shieldBurn > 0 && !res.destroyed && target.shields > 0) {
    target.shieldBurn = Math.min(4, target.shieldBurn + shot.shieldBurn);
    events.push({ type: 'shieldBurn', targetId: target.id, amount: shot.shieldBurn });
  }
  if (res.shieldBreak && !res.destroyed) {
    addStatus(target, 'jammed', { turns: 2, expiresAt: 'selfTurnStart' });
    events.push({ type: 'shieldBreak', targetId: target.id });
    events.push({ type: 'flash', targetId: target.id, strength: 0.5 });
  }
  if (!res.destroyed) {
    addStatus(target, 'locked', { turns: 1, expiresAt: 'selfTurnStart' });
  }

  for (const s of shot.splash || []) {
    const victim = state.ships.get(s.shipId);
    if (!victim || !victim.alive) continue;
    const r = applyDamage(state, victim, RULES.splash, 'kinetic', 1, { ignoreArmor: true });
    events.push({
      type: 'splash',
      targetId: victim.id,
      hull: r.hull,
      shield: Math.round(r.shield),
    });
    if (r.hull > 0) {
      events.push({
        type: 'log',
        text: `${victim.name} takes blast damage from the torpedo impact.`,
        kind: victim.team === 'player' ? LOG_KIND.bad : LOG_KIND.good,
      });
    }
    events.push(...r.deathEvents);
  }

  if (attacker) {
    attacker.damageDealt += dealt;
    if (state.stats) {
      if (attacker.team === 'player') state.stats.playerDamage += dealt;
      else state.stats.enemyDamage += dealt;
    }
  }
  events.push(...res.deathEvents);
  if (res.destroyed && attacker) attacker.kills += 1;

  return { events, destroyed: res.destroyed, dealt };
}

import { LOG_KIND } from './data.js';

// ---------------------------------------------------------------- orders

export function moveShip(state, ship, col, row, cells) {
  if (!ship || !ship.alive) return { ok: false, reason: 'Ship is destroyed' };
  if (ship.acted) return { ok: false, reason: `${ship.name} has already acted` };
  const occupant = shipAt(state, col, row);
  if (occupant && occupant.id !== ship.id) return { ok: false, reason: 'Hex occupied' };
  const dest = cellAt(state, col, row);
  if (!dest) return { ok: false, reason: 'Off the battlefield' };
  if (dest.blocksMove) return { ok: false, reason: 'Asteroid blocks that hex' };

  const list = cells && cells.length ? cells : [{ col, row }];
  if (list.length > thrustOf(ship) + 1) return { ok: false, reason: 'Too far' };

  const events = [{ type: 'move', shipId: ship.id, cells: list.map((c) => ({ col: c.col, row: c.row })) }];
  ship.col = col;
  ship.row = row;
  ship.moved = true;

  if (dest.debris) {
    const r = applyDamage(state, ship, RULES.debrisEntryDamage, 'kinetic', 1, { ignoreArmor: true });
    events.push({ type: 'hazard', targetId: ship.id, hull: r.hull });
    events.push({
      type: 'log',
      text: `${ship.name} grinds through debris and takes ${r.hull} hull damage.`,
      kind: ship.team === 'player' ? LOG_KIND.bad : LOG_KIND.info,
    });
    events.push(...r.deathEvents);
  }
  return { ok: true, events };
}

export function rotateShip(state, ship, facing) {
  if (!ship || !ship.alive) return { ok: false, reason: 'Ship is destroyed' };
  if (ship.acted) return { ok: false, reason: `${ship.name} has already acted` };
  if (!Number.isInteger(facing) || facing < 0 || facing > 5) return { ok: false, reason: 'Bad heading' };
  ship.facing = facing % 6;
  ship.rotated = true;
  return { ok: true, events: [{ type: 'rotate', shipId: ship.id, facing: ship.facing }] };
}

export function useSystem(state, ship, targetRef) {
  if (!ship || !ship.alive) return { ok: false, reason: 'Ship is destroyed' };
  if (ship.acted) return { ok: false, reason: `${ship.name} has already acted` };
  const sys = ship.cls.system;
  if (!sys) return { ok: false, reason: 'No ship system' };
  if (ship.systemCharges <= 0) return { ok: false, reason: 'System depleted' };

  const events = [{ type: 'system', shipId: ship.id, systemId: sys.id }];
  const finish = (extra) => {
    ship.acted = true;
    ship.systemCharges -= 1;
    if (extra) events.push(...extra);
    events.push({
      type: 'log',
      text: `${ship.name} runs ${sys.name}.`,
      kind: ship.team === 'player' ? LOG_KIND.system : LOG_KIND.enemy,
    });
    return { ok: true, events, system: sys };
  };

  switch (sys.id) {
    case 'overdrive': {
      addStatus(ship, 'overdrive', { turns: 1, expiresAt: 'selfTurnEnd' });
      return finish([{ type: 'buff', shipId: ship.id, status: 'overdrive' }]);
    }
    case 'fortify': {
      addStatus(ship, 'fortified', { turns: 1, expiresAt: 'selfTurnStart' });
      const before = ship.shields;
      ship.shields = Math.min(shieldMaxOf(ship), ship.shields + 20);
      return finish([
        { type: 'shieldUp', shipId: ship.id, amount: ship.shields - before },
      ]);
    }
    case 'aegis': {
      const ally = typeof targetRef === 'string' ? state.ships.get(targetRef) : targetRef;
      if (!ally || !ally.alive) return { ok: false, reason: 'No ally selected' };
      if (ally.team !== ship.team) return { ok: false, reason: 'Not a friendly ship' };
      const d = hexDistance({ col: ship.col, row: ship.row }, { col: ally.col, row: ally.row });
      if (d > (sys.radius || 3)) return { ok: false, reason: `Ally out of range (${d})` };
      const before = ally.shields;
      ally.shields = Math.min(shieldMaxOf(ally), ally.shields + 25);
      return finish([
        { type: 'shieldUp', shipId: ally.id, amount: ally.shields - before },
      ]);
    }
    case 'saturation': {
      addStatus(ship, 'saturation', { turns: 2, expiresAt: 'selfTurnStart' });
      return finish([{ type: 'buff', shipId: ship.id, status: 'saturation' }]);
    }
    case 'phase_shift': {
      const key = typeof targetRef === 'string' ? targetRef : cellKey(targetRef.col, targetRef.row);
      const cell = state.map.get(key);
      if (!cell) return { ok: false, reason: 'Off the battlefield' };
      if (cell.blocksMove) return { ok: false, reason: 'Asteroid blocks that hex' };
      const occupant = shipAt(state, cell.col, cell.row);
      if (occupant) return { ok: false, reason: 'Hex occupied' };
      const d = hexDistance({ col: ship.col, row: ship.row }, cell);
      if (d > (sys.radius || 3)) return { ok: false, reason: `Too far (${d})` };
      const from = { col: ship.col, row: ship.row };
      ship.col = cell.col;
      ship.row = cell.row;
      ship.moved = true;
      return finish([
        { type: 'phase', shipId: ship.id, from, to: { col: cell.col, row: cell.row } },
      ]);
    }
    default:
      return { ok: false, reason: 'Unknown system' };
  }
}

export function recharge(state, ship) {
  if (!ship || !ship.alive) return { ok: false, reason: 'Ship is destroyed' };
  if (ship.acted) return { ok: false, reason: `${ship.name} has already acted` };
  const max = shieldMaxOf(ship);
  const amount = Math.min(max - ship.shields, Math.round(regenOf(ship) * RULES.rechargeMult));
  ship.shields += amount;
  ship.acted = true;
  return {
    ok: true,
    events: [
      { type: 'recharge', shipId: ship.id, amount },
      {
        type: 'log',
        text: `${ship.name} recharges shields (+${amount}).`,
        kind: ship.team === 'player' ? LOG_KIND.good : LOG_KIND.enemy,
      },
    ],
  };
}

export function weaponReadiness(state, ship, weapon) {
  const cd = ship.cooldowns[weapon.id] || 0;
  if (cd > 0) return { ready: false, reason: `Reloading (${cd})` };
  if (ship.acted) return { ready: false, reason: 'Already acted' };
  return { ready: true, reason: '' };
}
