/**
 * Match flow: fleet setup, phase sequencing, the drift-gate end condition and
 * the scoring caps shown on the result screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ROSTER_ORDER, RULES, SHIP_CLASSES } from '../src/core/data.js';
import {
  aliveCount, allActed, beginPhase, beginRound, checkEnd, createGame, endPhase,
  fleetIntegrity, pushLog, shipsOf, shipById, statusList, summary,
} from '../src/core/state.js';
import { regenOf } from '../src/core/combat.js';

function setHull(state, team, fraction) {
  for (const ship of shipsOf(state, team, false)) {
    ship.alive = true;
    ship.hull = Math.round(ship.hullMax * fraction);
  }
}

test('a new battle fields five mirrored ships per side', () => {
  const state = createGame({ seed: 11, difficulty: 'normal' });
  assert.equal(state.ships.size, 10);
  assert.equal(state.round, 1);
  assert.equal(state.phase, 'player');
  assert.equal(state.over, null);
  assert.deepEqual(state.stats, { playerDamage: 0, enemyDamage: 0, rounds: 0, kills: 0, losses: 0 });

  const player = shipsOf(state, 'player');
  const enemy = shipsOf(state, 'enemy');
  assert.equal(player.length, 5);
  assert.equal(enemy.length, 5);
  assert.deepEqual(player.map((s) => s.classId), ROSTER_ORDER);
  assert.deepEqual(enemy.map((s) => s.classId), ROSTER_ORDER);
  assert.deepEqual(player.map((s) => s.id), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(enemy.map((s) => s.id), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.notDeepEqual(player.map((s) => s.name), enemy.map((s) => s.name));

  for (const ship of state.ships.values()) {
    assert.equal(ship.hull, ship.cls.hull);
    assert.equal(ship.shields, ship.cls.shield);
    assert.equal(ship.shieldMax, ship.cls.shield);
    assert.equal(ship.systemCharges, ship.cls.system.charges);
    assert.deepEqual(ship.cooldowns, Object.fromEntries(ship.cls.weapons.map((w) => [w.id, 0])));
    assert.equal(ship.acted, false);
    assert.ok(state.map.has(`${ship.col},${ship.row}`), 'every deployment hex exists');
    assert.equal(state.map.get(`${ship.col},${ship.row}`).blocksMove, false);
  }
  assert.equal(fleetIntegrity(state, 'player'), 1);
  assert.equal(fleetIntegrity(state, 'enemy'), 1);
  assert.ok(state.log.length >= 2, 'the briefing writes an opening log');
});

test('unknown difficulties fall back to normal and seeds are reproducible', () => {
  const fallback = createGame({ seed: 5, difficulty: 'impossible' });
  assert.equal(fallback.difficultyId, 'normal');
  assert.equal(fallback.difficulty.id ?? 'normal', 'normal');

  const a = createGame({ seed: 777 });
  const b = createGame({ seed: 777 });
  assert.deepEqual([...a.ships.values()].map((s) => [s.id, s.col, s.row, s.facing]),
    [...b.ships.values()].map((s) => [s.id, s.col, s.row, s.facing]));
  assert.equal(a.rng(), b.rng());
  assert.equal(a.rng(), b.rng(), 'the streams stay in lockstep, so rolls are replayable');

  const other = createGame({ seed: 778 });
  assert.notEqual(other.rng(), a.rng());
});

test('beginPhase refreshes orders, burns cooldowns and regenerates shields', () => {
  const state = createGame({ seed: 31 });
  const ship = state.ships.get('p2');
  const foe = state.ships.get('e2');
  ship.acted = true;
  ship.moved = true;
  ship.rotated = true;
  ship.cooldowns[Object.keys(ship.cooldowns)[0]] = 1;
  ship.shieldBurn = 2;
  ship.shields = 0;
  foe.shields = 0;
  foe.acted = true;

  beginPhase(state, 'player');
  assert.equal(ship.acted, false);
  assert.equal(ship.moved, false);
  assert.equal(ship.rotated, false);
  assert.equal(ship.cooldowns[Object.keys(ship.cooldowns)[0]], 0);
  assert.equal(ship.shieldBurn, 1);
  assert.equal(ship.shields, regenOf(ship), 'regen applies after the burn ticks down');
  assert.equal(state.phase, 'player');

  assert.equal(foe.acted, true, 'the other team keeps its spend');
  assert.equal(foe.shields, 0);
});

test('regeneration is capped and never touches wrecks', () => {
  const state = createGame({ seed: 63 });
  const full = state.ships.get('p1');
  full.shields = full.shieldMax;
  const wreck = state.ships.get('p3');
  wreck.alive = false;
  wreck.shields = 0;
  wreck.cooldowns[Object.keys(wreck.cooldowns)[0]] = 2;
  beginPhase(state, 'player');
  assert.equal(full.shields, full.shieldMax);
  assert.equal(wreck.shields, 0);
  assert.equal(wreck.cooldowns[Object.keys(wreck.cooldowns)[0]], 1, 'cooldowns still burn for wrecks');
});

test('phases alternate player → enemy → next round', () => {
  const state = createGame({ seed: 900 });
  const first = endPhase(state);
  assert.equal(first.phase, 'player');
  assert.equal(first.next, 'enemy');
  assert.equal(state.phase, 'enemy');
  assert.equal(state.round, 1);

  const second = endPhase(state);
  assert.equal(second.next, 'player');
  assert.equal(state.phase, 'player');
  assert.equal(state.round, 2);
  assert.equal(state.stats.rounds, 2);
  for (const ship of shipsOf(state, 'player')) assert.equal(ship.acted, false);
  // The enemy fleet was refreshed when its phase opened and nothing spent those orders.
  for (const ship of shipsOf(state, 'enemy')) assert.equal(ship.acted, false);

  beginRound(state);
  assert.equal(state.round, 3);
  assert.equal(state.phase, 'player');
});

test('allActed only clears when every live ship has spent', () => {
  const state = createGame({ seed: 42 });
  assert.equal(allActed(state, 'player'), false);
  for (const ship of shipsOf(state, 'player')) ship.acted = true;
  assert.equal(allActed(state, 'player'), true);
  shipsOf(state, 'player')[0].alive = false;
  assert.equal(allActed(state, 'player'), true, 'a wreck does not hold the phase open');
  for (const ship of shipsOf(state, 'player')) ship.acted = false;
  assert.equal(allActed(state, 'player'), false);
});

test('fleet integrity counts hull, ignores wrecks and survives a wiped side', () => {
  const state = createGame({ seed: 505 });
  setHull(state, 'player', 0.5);
  assert.ok(Math.abs(fleetIntegrity(state, 'player') - 0.5) < 0.02);
  for (const ship of shipsOf(state, 'player')) { ship.alive = false; ship.hull = 0; }
  assert.equal(fleetIntegrity(state, 'player'), 0);
  assert.equal(aliveCount(state, 'player'), 0);
});

test('annihilating one side ends the battle immediately', () => {
  const state = createGame({ seed: 71 });
  for (const ship of shipsOf(state, 'enemy')) { ship.alive = false; ship.hull = 0; }
  const over = checkEnd(state);
  assert.equal(over.result, 'victory');
  assert.equal(over.destroyed, 5);
  assert.equal(over.saved, 5);
  assert.equal(over.rank, over.score >= 88 ? 'S' : over.score >= 72 ? 'A' : over.score >= 55 ? 'B' : 'C');
  assert.equal(checkEnd(state), over, 'a decided battle is not re-decided');
});

test('losing every ship is a defeat capped at 40 with an F', () => {
  const state = createGame({ seed: 72, difficulty: 'hard' });
  state.stats.playerDamage = 9999;
  for (const ship of shipsOf(state, 'player')) { ship.alive = false; ship.hull = 0; }
  const over = checkEnd(state);
  assert.equal(over.result, 'defeat');
  assert.ok(over.score <= 40, `defeat should cap at 40, got ${over.score}`);
  assert.equal(over.rank, 'F');
  assert.equal(over.saved, 0);
});

test('the drift gate decides on integrity once round 12 closes', () => {
  const state = createGame({ seed: 73 });
  state.round = RULES.maxRounds;
  assert.equal(checkEnd(state), null, 'the gate is still open on the last allowed round');

  setHull(state, 'player', 0.9);
  setHull(state, 'enemy', 0.2);
  state.round = RULES.maxRounds + 1;
  const over = checkEnd(state);
  assert.equal(over.result, 'victory');
  assert.match(over.reason, /Drift gate/);

  const even = createGame({ seed: 74 });
  setHull(even, 'player', 0.5);
  setHull(even, 'enemy', 0.5);
  even.round = RULES.maxRounds + 1;
  const draw = checkEnd(even);
  assert.equal(draw.result, 'draw');
  assert.ok(draw.score <= 60, `a draw should cap at 60, got ${draw.score}`);
  assert.equal(draw.rank, 'F');

  const worse = createGame({ seed: 75 });
  setHull(worse, 'player', 0.2);
  setHull(worse, 'enemy', 0.9);
  worse.round = RULES.maxRounds + 1;
  assert.equal(checkEnd(worse).result, 'defeat');
});

test('a faster, cleaner win outscores a sluggish one', () => {
  const swift = createGame({ seed: 76 });
  swift.stats.playerDamage = 900;
  swift.stats.enemyDamage = 100;
  for (const ship of shipsOf(swift, 'enemy')) { ship.alive = false; ship.hull = 0; }
  const fast = checkEnd(swift);

  const slow = createGame({ seed: 76 });
  slow.round = RULES.maxRounds;
  slow.stats.playerDamage = 900;
  slow.stats.enemyDamage = 100;
  for (const ship of shipsOf(slow, 'enemy')) { ship.alive = false; ship.hull = 0; }
  const late = checkEnd(slow);

  assert.ok(fast.score > late.score, `${fast.score} should beat ${late.score}`);
  assert.equal(fast.rounds, 1);
});

test('the log keeps the last 240 lines', () => {
  const state = createGame({ seed: 77 });
  const start = state.log.length;
  for (let i = 0; i < 300; i += 1) pushLog(state, `line ${i}`);
  assert.equal(state.log.length, 240);
  assert.equal(state.log[239].text, 'line 299');
  assert.ok(start > 0);
});

test('statusList hides expired entries and shipById is null-safe', () => {
  const state = createGame({ seed: 78 });
  const ship = state.ships.get('p1');
  ship.status = { jammed: { turns: 2 }, locked: { turns: 0 } };
  assert.deepEqual(statusList(ship), [{ key: 'jammed', turns: 2 }]);
  assert.equal(shipById(state, 'p1'), ship);
  assert.equal(shipById(state, 'nope'), null);
});

test('summary reports what the HUD reads', () => {
  const state = createGame({ seed: 79 });
  const s = summary(state);
  assert.equal(s.round, 1);
  assert.equal(s.phase, 'player');
  assert.equal(s.playerAlive, 5);
  assert.equal(s.enemyAlive, 5);
  assert.equal(s.playerIntegrity, 1);
  assert.equal(s.enemyIntegrity, 1);
  assert.equal(s.over, null);
});

test('every class ships two weapons and a system with charges', () => {
  for (const [id, cls] of Object.entries(SHIP_CLASSES)) {
    assert.equal(cls.weapons.length, 2, id);
    assert.ok(cls.system.charges >= 1, id);
    assert.ok(cls.hull > 0 && cls.shield > 0, id);
    for (const w of cls.weapons) {
      assert.ok(w.range[0] <= w.range[1], `${id}/${w.id} range`);
      assert.ok(w.acc > 0 && w.acc <= 100, `${id}/${w.id} accuracy`);
      assert.ok(w.dmg[0] > 0 && w.dmg[1] >= w.dmg[0], `${id}/${w.id} damage`);
      assert.ok(w.cooldown >= 0, `${id}/${w.id} cooldown`);
    }
  }
});
