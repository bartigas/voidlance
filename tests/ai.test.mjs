/**
 * Fleet command: the planner must only ever propose orders the shared rules
 * engine accepts, for either team, and a whole match driven by the planner has
 * to terminate inside the drift gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { RULES } from '../src/core/data.js';
import { createGame, shipsOf, endPhase } from '../src/core/state.js';
import { hexDistance } from '../src/core/hex.js';
import { applyShot } from '../src/core/combat.js';
import {
  executeOrder, nextEnemyShip, planShip, runEnemyPhase, targetPool, threatFor,
} from '../src/core/ai.js';

/** Run one order chain, applying deferred shot damage the way main.js does. */
function runPlan(state, ship, plan) {
  const failures = [];
  for (const order of plan.orders) {
    const res = executeOrder(state, ship, order);
    if (!res || res.ok === false) {
      failures.push(`${order.kind}: ${res ? res.reason : 'no result'}`);
      break;
    }
    if (order.kind === 'fire') {
      for (const shot of res.shots || []) applyShot(state, shot);
    }
    if (ship.acted) break;
  }
  return failures;
}

function nearestFoe(state, ship) {
  let best = Infinity;
  for (const other of state.ships.values()) {
    if (other.team === ship.team || !other.alive) continue;
    best = Math.min(best, hexDistance(ship, other));
  }
  return best;
}

/** Planner-driven phase for either side, with a hard loop ceiling. */
function autoPhase(state, team) {
  const seen = [];
  let guard = 0;
  while (!state.over && guard++ < 24) {
    const live = shipsOf(state, team).filter((s) => !s.acted);
    if (!live.length) break;
    live.sort((a, b) => nearestFoe(state, a) - nearestFoe(state, b) || a.index - b.index);
    const ship = live[0];
    const plan = planShip(state, ship);
    seen.push({ ship, plan });
    const failures = runPlan(state, ship, plan);
    assert.deepEqual(failures, [], `${ship.name} (${team}) orders must be legal: ${plan.reason}`);
    if (!ship.acted) {
      const rescue = executeOrder(state, ship, { kind: 'recharge' });
      assert.equal(rescue.ok, true, `${ship.name} must always be able to end its turn`);
    }
  }
  assert.ok(guard < 24, `${team} phase must drain every ship`);
  return seen;
}

test('the opening plan for every ship is executable as written', () => {
  const state = createGame({ seed: 2026, difficulty: 'normal' });
  const before = [...state.ships.values()].map((s) => `${s.id}:${s.col},${s.row} f${s.facing} a${s.acted}`);

  for (const team of ['player', 'enemy']) {
    for (const ship of shipsOf(state, team)) {
      const plan = planShip(state, ship);
      assert.equal(plan.shipId, ship.id);
      assert.equal(typeof plan.reason, 'string');
      assert.ok(plan.reason.length > 0);
      assert.ok(Number.isFinite(plan.score), `score for ${ship.name}`);
      assert.ok(plan.orders.length <= 3, 'at most move + rotate + one action');
      const kinds = plan.orders.map((o) => o.kind);
      if (kinds.includes('move')) assert.equal(kinds.indexOf('move'), 0);
      const fired = kinds.filter((k) => ['fire', 'system', 'recharge'].includes(k));
      assert.ok(fired.length <= 1, `${ship.name} spends at most one action: ${kinds}`);
    }
  }
  const after = [...state.ships.values()].map((s) => `${s.id}:${s.col},${s.row} f${s.facing} a${s.acted}`);
  assert.deepEqual(after, before, 'planning alone must not mutate the battle');
});

test('dead and spent ships are not planned', () => {
  const state = createGame({ seed: 310 });
  const dead = state.ships.get('p1');
  dead.alive = false;
  assert.deepEqual(planShip(state, dead), { shipId: 'p1', orders: [], reason: 'destroyed', score: 0 });
  const spent = state.ships.get('e1');
  spent.acted = true;
  assert.equal(planShip(state, spent).reason, 'already acted');
});

test('plans actually shoot when something stands in front of them', () => {
  const state = createGame({ seed: 411 });
  const gunner = state.ships.get('p1');
  const foe = state.ships.get('e1');
  gunner.col = 5; gunner.row = 5; gunner.facing = 0;
  foe.col = 6; foe.row = 5; foe.facing = 3;
  for (const other of shipsOf(state, 'enemy')) if (other !== foe) other.alive = false;

  const plan = planShip(state, gunner);
  const fire = plan.orders.find((o) => o.kind === 'fire');
  assert.ok(fire, `expected a shot, got ${plan.reason}`);
  assert.equal(fire.targetId, foe.id);
  const hull = foe.hull + foe.shields;
  const failures = runPlan(state, gunner, plan);
  assert.deepEqual(failures, []);
  assert.equal(gunner.acted, true);
  assert.ok(foe.hull + foe.shields <= hull, 'the shot should not heal anything');
  assert.ok(gunner.damageDealt >= 0);
});

test('nextEnemyShip works front-line first and drains the phase', () => {
  const state = createGame({ seed: 512 });
  const lead = state.ships.get('e1');
  lead.col = 5; lead.row = 4;
  const first = nextEnemyShip(state);
  assert.equal(first.id, 'e1', 'the ship already in contact acts first');
  for (const ship of shipsOf(state, 'enemy')) ship.acted = true;
  assert.equal(nextEnemyShip(state), null);
  const wreck = shipsOf(state, 'enemy')[0];
  wreck.alive = false;
  wreck.acted = false;
  assert.equal(nextEnemyShip(state), null, 'wrecks never act');
});

test('executeOrder refuses nonsense', () => {
  const state = createGame({ seed: 613 });
  assert.equal(executeOrder(state, state.ships.get('p1'), { kind: 'warp' }).reason, 'Unknown order');
});

test('runEnemyPhase spends the whole enemy fleet and leaves my ships alone', () => {
  const state = createGame({ seed: 714 });
  const emitted = [];
  const events = runEnemyPhase(state, (list) => emitted.push(list.length));
  assert.equal(emitted.length, 1, 'the callback gets one batch');
  assert.ok(Array.isArray(events));
  assert.ok(events.some((e) => e.type === 'aiPlan'), 'each ship logs its intent');
  for (const ship of shipsOf(state, 'enemy')) {
    assert.equal(ship.acted, true, `${ship.name} should have acted`);
    assert.ok(Number.isFinite(ship.hull) && Number.isFinite(ship.shields));
  }
  for (const ship of shipsOf(state, 'player')) assert.equal(ship.acted, false);
  assert.equal(state.phase, 'player', 'phase transitions stay with the caller, not the planner');
});

test('a planner-driven match reaches a verdict inside the drift gate', () => {
  for (const seed of [9001, 9002, 9003]) {
    const state = createGame({ seed, difficulty: 'normal' });
    let switches = 0;
    while (!state.over && switches < (RULES.maxRounds + 2) * 2) {
      if (state.phase === 'player') autoPhase(state, 'player');
      else runEnemyPhase(state);
      switches += 1;
      endPhase(state);
    }
    assert.ok(state.over, `seed ${seed} must decide a winner`);
    assert.ok(state.over.rounds <= RULES.maxRounds + 1, `seed ${seed} ran ${state.over.rounds} rounds`);
    assert.ok(['victory', 'defeat', 'draw'].includes(state.over.result));
    assert.ok(Number.isFinite(state.over.score));
    assert.ok(state.stats.playerDamage > 0 && state.stats.enemyDamage > 0,
      `seed ${seed} traded blows: ${state.stats.playerDamage}/${state.stats.enemyDamage}`);
    for (const ship of state.ships.values()) {
      assert.ok(Number.isFinite(ship.hull) && Number.isFinite(ship.shields), `${ship.id} hull/shields`);
      assert.ok(ship.hull >= 0 && ship.hull <= ship.hullMax, `${ship.id} hull ${ship.hull}`);
      assert.ok(ship.shields >= 0 && ship.shields <= ship.shieldMax, `${ship.id} shields ${ship.shields}`);
      assert.ok(ship.systemCharges >= 0, `${ship.id} system charges`);
      if (!ship.alive) assert.equal(ship.hull, 0);
    }
  }
});

test('the AI presses the attack rather than turtle', () => {
  const state = createGame({ seed: 8121 });
  runEnemyPhase(state);
  const fired = shipsOf(state, 'enemy').filter((s) => s.damageDealt > 0).length;
  assert.ok(fired >= 1, 'at least one enemy should land damage on contact');
  assert.ok(state.stats.enemyDamage > 0);
  assert.ok(state.stats.playerDamage === 0, 'the enemy phase cannot score for the player');
});

test('targetPool and threatFor feed the HUD', () => {
  const state = createGame({ seed: 1234 });
  assert.equal(targetPool(state).length, 5);
  shipsOf(state, 'player')[0].alive = false;
  assert.equal(targetPool(state).length, 4);
  const read = threatFor(state, state.ships.get('e1'));
  assert.ok(read.count >= 0);
  assert.ok(Number.isFinite(read.score));
  const lone = state.ships.get('p5');
  for (const foe of shipsOf(state, 'enemy')) foe.acted = true;
  assert.equal(threatFor(state, lone).count >= 0, true);
});
