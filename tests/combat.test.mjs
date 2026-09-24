/**
 * Rules engine: firing arcs, hit chances, the armour/shield/hull split, order
 * legality and ship systems. All rolls come from the seeded RNG, so every
 * assertion here is reproducible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMap, ENEMY_SPAWNS, PLAYER_SPAWNS, RULES, SHIP_CLASSES } from '../src/core/data.js';
import { createGame, shipsOf } from '../src/core/state.js';
import { neighbor } from '../src/core/hex.js';
import {
  aimReport, applyDamage, applyShot, arcWorldDirs, armorValue, computeHitChance,
  coverPenalty, evadeOf, fireWeapon, findWeapon, inArc, incomingThreat, killShip,
  moveShip, podCount, recharge, regenOf, relativeArc, rotateShip, targetCheck, threatScore,
  thrustOf, useSystem, weaponReadiness,
} from '../src/core/combat.js';

/** A game whose map is flattened to open space, for pure geometry checks. */
function openGame(seed = 4242) {
  const state = createGame({ seed, difficulty: 'normal' });
  const map = new Map();
  for (let col = 0; col < 15; col += 1) {
    for (let row = 0; row < 15; row += 1) {
      map.set(`${col},${row}`, {
        col, row, kind: 'plain', blocksMove: false, blocksLos: false, debris: false, hazard: false,
      });
    }
  }
  state.map = map;
  return state;
}

function place(ship, col, row, facing) {
  ship.col = col;
  ship.row = row;
  if (facing !== undefined) ship.facing = facing;
  return ship;
}

test('firing arcs are relative to the ship and rotate with it', () => {
  assert.deepEqual(relativeArc(0, 'fore'), [0]);
  assert.deepEqual(relativeArc(3, 'fore'), [0]);
  assert.deepEqual(relativeArc(0, 'broad'), [1, 5]);
  assert.deepEqual(arcWorldDirs(2, 'broad'), [3, 1]);
  assert.deepEqual(arcWorldDirs(5, 'foreBroad'), [5, 0, 4]);

  const from = { col: 7, row: 7 };
  for (let facing = 0; facing < 6; facing += 1) {
    const head = neighbor(from.col, from.row, facing);
    const flank = neighbor(from.col, from.row, (facing + 1) % 6);
    const stern = neighbor(from.col, from.row, (facing + 3) % 6);
    assert.ok(inArc(facing, 'fore', from, head), `facing ${facing} sees its head hex`);
    assert.ok(!inArc(facing, 'fore', from, flank), `facing ${facing} does not see a flank`);
    assert.ok(inArc(facing, 'broad', from, flank));
    assert.ok(!inArc(facing, 'broad', from, head));
    assert.ok(!inArc(facing, 'foreBroad', from, stern));
    assert.ok(inArc(facing, 'all', from, stern));
  }
});

test('armour decays fore → broad → aft', () => {
  const ship = { cls: SHIP_CLASSES.BULWARK, status: {}, shieldBurn: 0 };
  assert.equal(armorValue(ship, 0), 4);
  assert.equal(armorValue(ship, 1), 8 / 3);
  assert.equal(armorValue(ship, 2), 4 / 3);
});

test('fortify raises the armour base', () => {
  const state = openGame();
  const ship = state.ships.get('p1');
  const before = armorValue(ship, 0);
  useSystem(state, ship, null);
  assert.equal(armorValue(ship, 0), before + 2);
  assert.equal(ship.acted, true);
  assert.equal(ship.systemCharges, SHIP_CLASSES.BULWARK.system.charges - 1);
});

test('targetCheck gates range, arc and line of sight', () => {
  const state = openGame();
  const gunner = place(state.ships.get('p2'), 7, 7, 0);
  const foe = place(state.ships.get('e1'), 9, 7, 3);
  const weapon = findWeapon(gunner, 'flak_salvo');

  place(foe, 11, 7);
  assert.equal(targetCheck(state, gunner, weapon, foe).reason, 'Out of range (4 > 3)', 'flak max range is 3');
  place(foe, 8, 7);
  assert.ok(targetCheck(state, gunner, weapon, foe).ok);

  // Same distance, but outside the fore arc of a forward-facing lance.
  const lance = place(state.ships.get('p4'), 7, 6, 1);
  const rail = findWeapon(lance, 'rail_spike');
  place(foe, 7, 5);
  assert.ok(targetCheck(state, lance, rail, foe).ok, 'straight ahead at range 1');
  place(foe, 8, 6);
  assert.equal(targetCheck(state, lance, rail, foe).reason, 'Target outside firing arc');

  // Arcs must stay meaningful past the adjacent hex.
  const rack = findWeapon(lance, 'lance_rack');
  place(foe, 9, 2);
  assert.ok(targetCheck(state, lance, rack, foe).ok, 'four hexes dead ahead');
  place(foe, 2, 6);
  assert.equal(targetCheck(state, lance, rack, foe).reason, 'Target outside firing arc',
    'a broadside cannot bend around to the stern');

  assert.equal(targetCheck(state, gunner, weapon, gunner).reason, 'Friendly ship');
  place(foe, 99, 99);
  assert.equal(targetCheck(state, gunner, weapon, foe).ok, false);
});

test('asteroids break line of sight and grant cover', () => {
  const state = openGame();
  const shooter = place(state.ships.get('p1'), 4, 4, 0);
  const foe = place(state.ships.get('e1'), 6, 4, 3);
  const weapon = findWeapon(shooter, 'twin_cannon');
  assert.ok(targetCheck(state, shooter, weapon, foe).ok);

  state.map.get('5,4').blocksLos = true;
  assert.equal(targetCheck(state, shooter, weapon, foe).reason, 'Blocked by asteroid');

  // Cover from a rock beside the target, not on the shot line.
  delete state.map.get('5,4').blocksLos;
  state.map.get('5,3').blocksLos = true;
  const clear = computeHitChance(state, shooter, weapon, foe);
  assert.ok(clear.ok);
  assert.ok(clear.cover >= RULES.coverPenalty, `expected cover penalty, got ${clear.cover}`);
});

test('debris degrades accuracy for both shooter and target', () => {
  const state = openGame();
  const shooter = place(state.ships.get('p1'), 4, 4, 0);
  const foe = place(state.ships.get('e1'), 6, 4, 3);
  const weapon = findWeapon(shooter, 'twin_cannon');

  const clean = computeHitChance(state, shooter, weapon, foe);
  state.map.get('6,4').debris = true;
  const inDebris = computeHitChance(state, shooter, weapon, foe);
  assert.ok(clean.hitChance > inDebris.hitChance);

  delete state.map.get('6,4').debris;
  state.map.get('5,4').debris = true;
  const throughDebris = computeHitChance(state, shooter, weapon, foe);
  assert.ok(clean.hitChance > throughDebris.hitChance);
  assert.equal(coverPenalty(state, shooter, foe), RULES.debrisCover, 'firing into debris costs accuracy');
  assert.equal(coverPenalty(state, shooter, foe, true), 0, 'saturation ignores cover');
});

test('hit chance stays inside the published floor and ceiling', () => {
  const state = openGame();
  const shooter = place(state.ships.get('p1'), 3, 3, 0);
  const foe = place(state.ships.get('e1'), 5, 3, 3);
  const weapon = findWeapon(shooter, 'twin_cannon');
  foe.status = {};
  foe.cls = { ...foe.cls, evade: 900 };
  assert.equal(computeHitChance(state, shooter, weapon, foe).hitChance, RULES.minHit);
  foe.cls = { ...foe.cls, evade: -900 };
  assert.equal(computeHitChance(state, shooter, weapon, foe).hitChance, RULES.maxHit);
});

test('energy punches through armour while kinetic eats it', () => {
  const state = openGame();
  const bulwark = place(state.ships.get('e1'), 7, 7, 0);
  const shielded = { ...bulwark };
  const energy = applyDamage(state, shielded, 30, 'energy', 2);
  assert.ok(energy.shield >= 30, `energy should land ~${30 * 1.5} on shields, got ${energy.shield}`);

  const kinetic = applyDamage(state, { ...bulwark, shields: 40 }, 30, 'kinetic', 0);
  assert.ok(kinetic.shield < energy.shield, 'kinetic loses damage to armour and shields');
});

test('shields soak before hull, and a break jams the victim', () => {
  const state = openGame();
  const victim = place(state.ships.get('e1'), 7, 7, 0);
  const shooter = place(state.ships.get('p1'), 5, 7, 0);
  victim.shields = 6;
  const res = applyDamage(state, victim, 40, 'kinetic', 0);
  assert.equal(victim.shields, 0);
  assert.ok(victim.hull < victim.hullMax);
  assert.equal(res.shieldBreak, true);

  applyShot(state, {
    fromId: shooter.id, targetId: victim.id, weaponName: 'Twin Cannon', kind: 'kinetic',
    hit: true, crit: false, dmg: 12, aspect: 0, hitChance: 70, shieldBurn: 0, splash: [], delayMs: 0,
  });
  assert.equal(victim.status.jammed, undefined, 'a shot into an already-dead shield cannot break it');

  // Kinetic soaks half through armour, so 12 vs 4 armour lands 4 on shields.
  victim.shields = 2;
  const breakAgain = applyShot(state, {
    fromId: shooter.id, targetId: victim.id, weaponName: 'Twin Cannon', kind: 'kinetic',
    hit: true, crit: false, dmg: 12, aspect: 0, hitChance: 70, shieldBurn: 2, splash: [], delayMs: 0,
  });
  assert.ok(breakAgain.events.some((e) => e.type === 'shieldBreak'));
  assert.ok(victim.status.jammed, 'a shield break should jam the target');
  assert.equal(victim.shields, 0);
  assert.ok(victim.status.locked, 'a hit paints the target for the next shooter');
});

test('fireWeapon rolls every pod, spends the action and sets the reload', () => {
  const state = openGame();
  const shooter = place(state.ships.get('p3'), 5, 7, 0);
  const foe = place(state.ships.get('e1'), 7, 7, 3);
  const swarm = findWeapon(shooter, 'swarm_launchers');
  assert.equal(podCount(shooter, swarm), swarm.hits);

  const res = fireWeapon(state, shooter, 'swarm_launchers', foe.id);
  assert.equal(res.ok, true);
  assert.equal(res.shots.length, swarm.hits);
  assert.equal(shooter.acted, true);
  assert.equal(shooter.cooldowns.swarm_launchers, swarm.cooldown);
  assert.equal(weaponReadiness(state, shooter, swarm).ready, false);

  const again = fireWeapon(state, shooter, 'pulse_cannon', foe.id);
  assert.equal(again.ok, false, 'one action per phase');
});

test('firing is deterministic for a given seed', () => {
  const run = () => {
    const state = openGame(20260923);
    const shooter = place(state.ships.get('p3'), 5, 7, 0);
    const foe = place(state.ships.get('e1'), 7, 7, 3);
    const res = fireWeapon(state, shooter, 'swarm_launchers', foe.id);
    return res.shots.map((s) => `${s.hit}:${s.dmg}`).join('|');
  };
  assert.equal(run(), run());
});

test('applyShot credits damage to the shooter and the fleet totals', () => {
  const state = openGame();
  const shooter = place(state.ships.get('p1'), 5, 7, 0);
  const foe = place(state.ships.get('e1'), 6, 7, 3);
  const before = foe.shields;
  const res = applyShot(state, {
    fromId: shooter.id, targetId: foe.id, weaponName: 'Twin Cannon', kind: 'kinetic',
    hit: true, crit: false, dmg: 10, aspect: 0, hitChance: 70, shieldBurn: 0, splash: [], delayMs: 0,
  });
  assert.ok(res.dealt > 0);
  assert.equal(foe.shields, Math.max(0, before - res.dealt));
  assert.equal(shooter.damageDealt, res.dealt);
  assert.equal(state.stats.playerDamage, res.dealt);

  const miss = applyShot(state, {
    fromId: shooter.id, targetId: foe.id, weaponName: 'Twin Cannon', kind: 'kinetic',
    hit: false, crit: false, dmg: 0, aspect: 0, hitChance: 70, shieldBurn: 0, splash: [], delayMs: 0,
  });
  assert.equal(miss.dealt, 0);
  assert.equal(state.stats.enemyDamage, 0, 'friendly fire is not scored');
});

test('torpedoes splash onto adjacent enemies', () => {
  const state = openGame();
  const shooter = place(state.ships.get('p4'), 4, 7, 0);
  const foe = place(state.ships.get('e1'), 6, 7, 3);
  const nearby = place(state.ships.get('e2'), 7, 7, 3);
  const hull = nearby.hull;
  applyShot(state, {
    fromId: shooter.id, targetId: foe.id, weaponName: 'Lance Torpedo Rack', kind: 'torpedo',
    hit: true, crit: false, dmg: 20, aspect: 0, hitChance: 70, shieldBurn: 0,
    splash: [{ shipId: nearby.id }], delayMs: 0,
  });
  assert.ok(nearby.hull < hull || nearby.shields < SHIP_CLASSES.WARDEN.shield);
});

test('destroying a ship removes it from the living order', () => {
  const state = openGame();
  const victim = state.ships.get('e1');
  const events = killShip(state, victim);
  assert.equal(victim.alive, false);
  assert.equal(victim.hull, 0);
  assert.ok(events.some((e) => e.type === 'explode'));
  assert.equal(shipsOf(state, 'enemy').length, 4);
  assert.equal(killShip(state, victim).length, 0, 'a wreck does not die twice');
});

test('moveShip respects thrust, occupancy, asteroids and debris', () => {
  const state = openGame();
  const ship = place(state.ships.get('p1'), 4, 7, 0);
  const far = [{ col: 5, row: 7 }, { col: 6, row: 7 }, { col: 7, row: 7 }, { col: 8, row: 7 }, { col: 9, row: 7 }];
  assert.equal(moveShip(state, ship, 9, 7, far).reason, 'Too far', 'Bulwark thrust is 2');

  const ok = moveShip(state, ship, 6, 7, [{ col: 5, row: 7 }, { col: 6, row: 7 }]);
  assert.equal(ok.ok, true);
  assert.equal(ship.col, 6);
  assert.equal(ship.acted, false, 'moving alone does not spend the action');
  assert.equal(moveShip(state, ship, 6, 8, [{ col: 6, row: 8 }]).ok, true);
  ship.acted = true;
  assert.match(moveShip(state, ship, 5, 8, [{ col: 5, row: 8 }]).reason, /already acted/);

  const other = place(state.ships.get('p2'), 3, 3, 0);
  other.acted = false;
  assert.equal(moveShip(state, other, 6, 8, [{ col: 6, row: 8 }]).reason, 'Hex occupied');

  const lone = place(state.ships.get('p5'), 4, 4, 0);
  state.map.get('5,4').blocksMove = true;
  assert.equal(moveShip(state, lone, 5, 4, [{ col: 5, row: 4 }]).reason, 'Asteroid blocks that hex');
  assert.equal(moveShip(state, lone, 99, 99, [{ col: 99, row: 99 }]).reason, 'Off the battlefield');
});

test('entering a debris field costs hull', () => {
  const state = openGame();
  const ship = place(state.ships.get('p5'), 4, 4, 0);
  ship.shields = 0;
  state.map.get('5,4').debris = true;
  const hull = ship.hull;
  const res = moveShip(state, ship, 5, 4, [{ col: 5, row: 4 }]);
  assert.equal(res.ok, true);
  assert.equal(ship.hull, hull - RULES.debrisEntryDamage);
  assert.ok(res.events.some((e) => e.type === 'hazard'));
});

test('rotateShip turns to any legal heading once', () => {
  const state = openGame();
  const ship = place(state.ships.get('p1'), 4, 4, 0);
  assert.equal(rotateShip(state, ship, 5).ok, true);
  assert.equal(ship.facing, 5);
  assert.equal(rotateShip(state, ship, 9).ok, false);
  ship.acted = true;
  assert.match(rotateShip(state, ship, 1).reason, /already acted/);
});

test('ship systems do what the briefing says', () => {
  const state = openGame();

  const lance = place(state.ships.get('p4'), 4, 4, 0);
  const thrust = thrustOf(lance);
  const evade = evadeOf(lance);
  useSystem(state, lance, null);
  assert.equal(thrustOf(lance), thrust + 3);
  assert.equal(evadeOf(lance), evade + 15);

  const warden = place(state.ships.get('p2'), 4, 6, 0);
  const ally = state.ships.get('p1');
  place(ally, 6, 6, 0);
  ally.shields = 0;
  const aegis = useSystem(state, warden, ally.id);
  assert.equal(aegis.ok, true);
  assert.equal(ally.shields, 25);
  place(ally, 14, 14, 0);
  warden.acted = false;
  assert.match(useSystem(state, warden, ally.id).reason, /out of range/);
  warden.acted = false;
  assert.equal(useSystem(state, warden, 'e1').reason, 'Not a friendly ship');

  const revenant = place(state.ships.get('p5'), 4, 8, 0);
  const jump = useSystem(state, revenant, '6,9');
  assert.equal(jump.ok, true, jump.reason);
  assert.equal(revenant.col, 6);
  assert.equal(revenant.row, 9);
  revenant.acted = false;
  assert.match(useSystem(state, revenant, '10,14').reason, /Too far/);

  const tempest = place(state.ships.get('p3'), 4, 10, 0);
  useSystem(state, tempest, null);
  const swarm = findWeapon(tempest, 'swarm_launchers');
  assert.equal(podCount(tempest, swarm), swarm.hits + 2);

  const drained = state.ships.get('p1');
  drained.systemCharges = 0;
  drained.acted = false;
  assert.equal(useSystem(state, drained, null).reason, 'System depleted');
});

test('recharge restores regen ×1.5 up to the cap', () => {
  const state = openGame();
  const ship = state.ships.get('p1');
  ship.shields = 0;
  const res = recharge(state, ship);
  assert.equal(res.ok, true);
  assert.equal(ship.shields, Math.round(ship.cls.regen * RULES.rechargeMult));
  assert.equal(ship.acted, true);
  ship.acted = false;
  ship.shields = ship.cls.shield;
  assert.equal(recharge(state, ship).events[0].amount, 0);
});

test('shield burn throttles regeneration', () => {
  const state = openGame();
  const ship = state.ships.get('p2');
  ship.shields = 0;
  ship.shieldBurn = 2;
  recharge(state, ship);
  assert.equal(ship.shields, Math.round((ship.cls.regen - 2) * RULES.rechargeMult));
  assert.equal(regenOf(ship), ship.cls.regen - 2);

  ship.shieldBurn = ship.cls.regen + 4;
  assert.equal(regenOf(ship), 0);
});

test('incomingThreat lists live weapons and can skip spent ships', () => {
  const state = createGame({ seed: 99, difficulty: 'normal' });
  const mine = state.ships.get('p1');
  const foe = state.ships.get('e2');
  place(mine, 4, 4, 0);
  place(foe, 6, 4, 3);
  const list = incomingThreat(state, mine);
  assert.ok(list.length > 0, 'the enemy fleet should threaten the lead ship');
  assert.ok(list.some((t) => t.shipId === 'e2' && t.weaponId === 'flak_salvo'),
    'the enemy Warden flak should show up at range 2');
  for (const t of list) {
    assert.notEqual(t.shipId, mine.id);
    assert.ok(t.hitChance >= RULES.minHit && t.hitChance <= RULES.maxHit);
    assert.ok(t.damage > 0);
  }
  assert.ok(list[0].damage * list[0].hitChance >= list[list.length - 1].damage * list[list.length - 1].hitChance,
    'the deadliest answer is listed first');
  assert.ok(threatScore(state, mine) > 0);
  for (const other of shipsOf(state, 'enemy')) other.acted = true;
  assert.equal(incomingThreat(state, mine, { ignoreActed: true }).length, 0);
  assert.equal(threatScore(state, mine), 0);
});

test('aimReport explains a refusal instead of returning a blank', () => {
  const state = openGame();
  const shooter = place(state.ships.get('p1'), 4, 4, 0);
  const foe = place(state.ships.get('e1'), 14, 4, 3);
  const bad = aimReport(state, shooter, 'twin_cannon', foe.id);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /Out of range/);
  assert.equal(aimReport(state, shooter, 'nope', foe.id).reason, 'Unknown weapon');

  place(foe, 6, 4);
  const good = aimReport(state, shooter, 'twin_cannon', foe.id);
  assert.equal(good.ok, true);
  assert.ok(good.hitChance >= RULES.minHit && good.hitChance <= RULES.maxHit);
  assert.ok(good.minDmg > 0 && good.maxDmg >= good.minDmg);
});

test('the shipped map is reachable and symmetric', () => {
  const map = buildMap();
  assert.equal(map.size, 11 * 9);
  for (const [col, row] of [...PLAYER_SPAWNS, ...ENEMY_SPAWNS]) {
    const cell = map.get(`${col},${row}`);
    assert.ok(cell && !cell.blocksMove, `${col},${row} must be a clear deployment hex`);
  }
  // No rock wall may seal a deployment hex away from the midfield.
  const field = (() => {
    const [c0, r0] = PLAYER_SPAWNS[0];
    const seen = new Set([`${c0},${r0}`]);
    const queue = [[c0, r0]];
    while (queue.length) {
      const [c, r] = queue.shift();
      for (let d = 0; d < 6; d += 1) {
        const n = neighbor(c, r, d);
        const key = `${n.col},${n.row}`;
        if (seen.has(key) || !map.has(key) || map.get(key).blocksMove) continue;
        seen.add(key);
        queue.push([n.col, n.row]);
      }
    }
    return seen;
  })();
  for (const [col, row] of [...PLAYER_SPAWNS, ...ENEMY_SPAWNS]) {
    assert.ok(field.has(`${col},${row}`), `${col},${row} is cut off by asteroids`);
  }
  const state = createGame({ seed: 7 });
  assert.equal(shipsOf(state, 'player').length, 5);
  assert.equal(shipsOf(state, 'enemy').length, 5);
  const classes = shipsOf(state, 'player').map((s) => s.classId).sort();
  assert.deepEqual(classes, shipsOf(state, 'enemy').map((s) => s.classId).sort());
});
