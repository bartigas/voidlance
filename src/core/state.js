// Match state: deterministic RNG, fleet setup, phase sequencing, outcome check.
// This module owns the ship records; combat.js mutates them, never recreates them.

import {
  DIFFICULTIES,
  ENEMY_SPAWNS,
  LOG_KIND,
  PLAYER_SPAWNS,
  ROSTER_ORDER,
  RULES,
  SHIP_CLASSES,
  buildMap,
} from './data.js';
import { regenOf, tickStatuses } from './combat.js';

const FLEET_NAMES = {
  player: {
    LANCE: 'Slipstream',
    BULWARK: 'Ironhold',
    WARDEN: 'Sanctuary',
    TEMPEST: 'Stormbreak',
    REVENANT: 'Ghostwire',
  },
  enemy: {
    LANCE: 'Razorwake',
    BULWARK: 'Grim Bastion',
    WARDEN: 'Pale Chorale',
    TEMPEST: 'Hail of Ash',
    REVENANT: 'Null Shade',
  },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeShip(id, team, classId, spawn, index) {
  const cls = SHIP_CLASSES[classId];
  const facing = team === 'player'
    ? (spawn[0] < 5.5 ? 1 : 2)
    : (spawn[0] < 5.5 ? 5 : 4);
  return {
    id,
    team,
    classId,
    cls,
    name: FLEET_NAMES[team][classId],
    glyph: cls.glyph,
    accent: cls.accent,
    accentCss: cls.accentCss,
    col: spawn[0],
    row: spawn[1],
    facing,
    hull: cls.hull,
    hullMax: cls.hull,
    shields: cls.shield,
    shieldMax: cls.shield,
    shieldBurn: 0,
    armorBase: cls.armor,
    acted: false,
    moved: false,
    rotated: false,
    cooldowns: Object.fromEntries(cls.weapons.map((w) => [w.id, 0])),
    systemCharges: cls.system.charges,
    status: {},
    alive: true,
    damageDealt: 0,
    kills: 0,
    index,
  };
}

export function createGame(opts = {}) {
  const difficultyId = opts.difficulty in DIFFICULTIES ? opts.difficulty : 'normal';
  const seed = Number.isFinite(opts.seed) ? opts.seed : Date.now() >>> 0;
  const state = {
    seed,
    rng: mulberry32(seed),
    difficultyId,
    difficulty: DIFFICULTIES[difficultyId],
    map: buildMap(),
    ships: new Map(),
    round: 1,
    phase: 'player',
    log: [],
    stats: { playerDamage: 0, enemyDamage: 0, rounds: 0, kills: 0, losses: 0 },
    over: null,
  };
  ROSTER_ORDER.forEach((classId, i) => {
    state.ships.set(`p${i + 1}`, makeShip(`p${i + 1}`, 'player', classId, PLAYER_SPAWNS[i], i));
    state.ships.set(`e${i + 1}`, makeShip(`e${i + 1}`, 'enemy', classId, ENEMY_SPAWNS[i], i));
  });
  pushLog(state, `${RULES.maxRounds} rounds until the drift gate closes.`, LOG_KIND.info);
  pushLog(state, 'Enemy fleet detected on the far arc.', LOG_KIND.enemy);
  return state;
}

export function pushLog(state, text, kind = LOG_KIND.info) {
  state.log.push({ text, kind, round: state.round, phase: state.phase });
  if (state.log.length > 240) state.log.splice(0, state.log.length - 240);
}

export function shipsOf(state, team, aliveOnly = true) {
  const out = [];
  for (const ship of state.ships.values()) {
    if (ship.team !== team) continue;
    if (aliveOnly && !ship.alive) continue;
    out.push(ship);
  }
  return out;
}

export function fleetIntegrity(state, team) {
  let now = 0;
  let max = 0;
  for (const ship of state.ships.values()) {
    if (ship.team !== team) continue;
    max += ship.hullMax;
    now += ship.alive ? Math.max(0, ship.hull) : 0;
  }
  return max > 0 ? now / max : 0;
}

export function aliveCount(state, team) {
  return shipsOf(state, team).length;
}

export function allActed(state, team = 'player') {
  const list = shipsOf(state, team);
  return list.length === 0 || list.every((s) => s.acted);
}

// Called at the start of a team's own phase: refresh orders, burn cooldowns,
// regenerate shields (reduced by any lingering shield burn).
export function beginPhase(state, team) {
  for (const ship of state.ships.values()) {
    if (ship.team !== team) continue;
    ship.acted = false;
    ship.moved = false;
    ship.rotated = false;
    for (const id of Object.keys(ship.cooldowns)) {
      ship.cooldowns[id] = Math.max(0, ship.cooldowns[id] - 1);
    }
    if (ship.shieldBurn > 0) ship.shieldBurn -= 1;
    if (!ship.alive) continue;
    tickStatuses(ship, 'selfTurnStart');
    const gain = regenOf(ship);
    if (gain > 0 && ship.shields < ship.shieldMax) {
      ship.shields = Math.min(ship.shieldMax, ship.shields + gain);
    }
  }
  state.phase = team;
}

export function beginRound(state) {
  state.round += 1;
  state.stats.rounds = state.round;
  beginPhase(state, 'player');
}

export function endPhase(state) {
  const team = state.phase;
  for (const ship of state.ships.values()) {
    if (ship.team !== team || !ship.alive) continue;
    tickStatuses(ship, 'selfTurnEnd');
  }
  const ended = { phase: team };
  if (team === 'player') {
    beginPhase(state, 'enemy');
    ended.next = 'enemy';
  } else {
    beginRound(state);
    ended.next = 'player';
  }
  checkEnd(state);
  return ended;
}

function rankFor(score) {
  if (score >= 88) return 'S';
  if (score >= 72) return 'A';
  if (score >= 55) return 'B';
  return 'C';
}

export function checkEnd(state) {
  if (state.over) return state.over;
  const players = aliveCount(state, 'player');
  const enemies = aliveCount(state, 'enemy');
  if (enemies === 0 || players === 0) {
    return finish(state, enemies === 0 ? 'victory' : 'defeat',
      enemies === 0 ? 'Enemy fleet destroyed.' : 'All friendly ships lost.');
  }
  if (state.round > RULES.maxRounds) {
    const p = fleetIntegrity(state, 'player');
    const e = fleetIntegrity(state, 'enemy');
    if (Math.abs(p - e) < 0.05) return finish(state, 'draw', 'Both fleets disengaged.');
    return finish(state, p > e ? 'victory' : 'defeat', 'Drift gate closed — fleet integrity decides.');
  }
  return null;
}

function finish(state, result, reason) {
  const saved = fleetIntegrity(state, 'player');
  const dealt = state.stats.playerDamage;
  const taken = Math.max(1, state.stats.enemyDamage);
  const diffBonus = { easy: 0, normal: 6, hard: 11 }[state.difficultyId] ?? 0;
  const pace = Math.max(0, 1 - (state.round - 1) / RULES.maxRounds);
  let score = saved * 45 + Math.min(1.2, dealt / taken) * 20 + pace * 20 + diffBonus;
  if (result === 'defeat') score = Math.min(score, 40);
  if (result === 'draw') score = Math.min(score, 60);
  state.over = {
    result,
    reason,
    rank: result === 'victory' ? rankFor(score) : 'F',
    score: Math.round(score),
    rounds: state.round,
    saved: aliveCount(state, 'player'),
    destroyed: aliveCount(state, 'enemy') === 0 ? 5 : 5 - aliveCount(state, 'enemy'),
    playerDamage: Math.round(dealt),
    enemyDamage: Math.round(state.stats.enemyDamage),
  };
  pushLog(state, reason, LOG_KIND.info);
  pushLog(state, result === 'victory' ? 'VICTORY' : result === 'defeat' ? 'DEFEAT' : 'DRAW',
    result === 'victory' ? LOG_KIND.good : LOG_KIND.bad);
  return state.over;
}

// ------------------------------------------------------------------ helpers

export function shipById(state, id) {
  return state.ships.get(id) || null;
}

export function labelFor(ship) {
  return `${ship.classId} "${ship.name}"`;
}

export function statusList(ship) {
  return Object.entries(ship.status)
    .filter(([, s]) => s.turns > 0)
    .map(([key, s]) => ({ key, turns: s.turns }));
}

export function summary(state) {
  return {
    round: state.round,
    phase: state.phase,
    playerIntegrity: fleetIntegrity(state, 'player'),
    enemyIntegrity: fleetIntegrity(state, 'enemy'),
    playerAlive: aliveCount(state, 'player'),
    enemyAlive: aliveCount(state, 'enemy'),
    over: state.over,
  };
}
