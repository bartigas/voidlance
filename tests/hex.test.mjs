/**
 * Hex geometry: the whole game leans on offset/cube conversion, so every other
 * module assumes these invariants hold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AXIAL_DIRS, DIR_NAMES, aspectToward, axialToOffset, cellsWithin, cellToWorld,
  hexCorners, hexDistance, lineOfSight, neighbor, offsetToAxial, worldToCell,
} from '../src/core/hex.js';
import { buildMap } from '../src/core/data.js';

function plainMap(cols, rows, blocked = []) {
  const map = new Map();
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      map.set(`${col},${row}`, {
        col, row, kind: 'plain', blocksMove: false, blocksLos: false, debris: false, hazard: false,
      });
    }
  }
  for (const [col, row] of blocked) {
    const cell = map.get(`${col},${row}`);
    cell.kind = 'asteroid';
    cell.blocksMove = true;
    cell.blocksLos = true;
  }
  return map;
}

test('offset and axial conversions round-trip', () => {
  for (let col = 0; col < 12; col += 1) {
    for (let row = 0; row < 10; row += 1) {
      const ax = offsetToAxial(col, row);
      const back = axialToOffset(ax.q, ax.r);
      assert.deepEqual(back, { col, row }, `${col},${row}`);
    }
  }
});

test('direction names match the six neighbours', () => {
  assert.equal(DIR_NAMES.length, 6);
  for (let dir = 0; dir < 6; dir += 1) {
    const from = { col: 5, row: 4 };
    const to = neighbor(from.col, from.row, dir);
    assert.equal(directionCheck(from, to), dir);
  }
});

function directionCheck(a, b) {
  for (let d = 0; d < 6; d += 1) {
    const n = neighbor(a.col, a.row, d);
    if (n.col === b.col && n.row === b.row) return d;
  }
  return -1;
}

test('neighbours wrap past direction 5', () => {
  const a = { col: 5, row: 4 };
  assert.deepEqual(neighbor(a.col, a.row, 6), neighbor(a.col, a.row, 0));
  assert.deepEqual(neighbor(a.col, a.row, -1), neighbor(a.col, a.row, 5));
});

test('hex distance is symmetric, zero for self, one for neighbours', () => {
  const a = { col: 4, row: 5 };
  assert.equal(hexDistance(a, a), 0);
  for (let dir = 0; dir < 6; dir += 1) {
    const b = neighbor(a.col, a.row, dir);
    assert.equal(hexDistance(a, b), 1);
    assert.equal(hexDistance(b, a), 1);
  }
  // Odd-r rows shift, so a diagonal neighbour two rows up is still 2 hexes.
  assert.equal(hexDistance(a, { col: 4, row: 3 }), 2);
});

test('distance obeys the triangle inequality across the field', () => {
  const map = buildMap();
  const cells = [...map.values()];
  const a = cells[0];
  const b = cells[Math.floor(cells.length / 2)];
  const c = cells[cells.length - 1];
  assert.ok(hexDistance(a, c) <= hexDistance(a, b) + hexDistance(b, c));
});

test('worldToCell inverts cellToWorld for every hex on the board', () => {
  const size = 2.15;
  for (const cell of buildMap().values()) {
    const { x, z } = cellToWorld(cell.col, cell.row, size);
    const back = worldToCell(x, z, size);
    assert.deepEqual(back, { col: cell.col, row: cell.row }, `hex ${cell.col},${cell.row}`);
  }
});

test('hex corners are evenly spaced on the circumcircle', () => {
  const pts = hexCorners(1);
  assert.equal(pts.length, 6);
  for (const [x, y] of pts) assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-9);
});

test('aspectToward reads fore, broad and aft off the facing', () => {
  const from = { col: 4, row: 4 };
  const facing = 2;
  assert.equal(aspectToward(from, neighbor(from.col, from.row, facing), facing), 0);
  assert.equal(aspectToward(from, neighbor(from.col, from.row, (facing + 1) % 6), facing), 1);
  assert.equal(aspectToward(from, neighbor(from.col, from.row, (facing + 5) % 6), facing), 1);
  assert.equal(aspectToward(from, neighbor(from.col, from.row, (facing + 3) % 6), facing), 2);
});

test('cellsWithin returns exactly the hexes inside the radius', () => {
  const map = plainMap(20, 20);
  const from = { col: 10, row: 10 };
  for (const radius of [0, 1, 2, 3]) {
    const expected = 1 + 3 * radius * (radius + 1);
    assert.equal(cellsWithin(map, from, radius).length, expected, `radius ${radius}`);
  }
  const filtered = cellsWithin(map, from, 2, (cell) => cell.col === from.col);
  for (const cell of filtered) assert.equal(cell.col, from.col);
});

test('lineOfSight is broken only by cells that block it', () => {
  const map = plainMap(5, 5, [[2, 2]]);
  // Even rows keep col 0..4 collinear, so (2,2) sits dead centre of that line.
  assert.equal(lineOfSight(map, { col: 0, row: 2 }, { col: 4, row: 2 }), false);
  assert.equal(lineOfSight(map, { col: 0, row: 0 }, { col: 4, row: 0 }), true);
  assert.equal(lineOfSight(map, { col: 2, row: 2 }, { col: 4, row: 2 }), true, 'shooter hex never self-blocks');
});

test('the shipped battlefield has asteroids and debris off the lanes', () => {
  const map = buildMap();
  const blockers = [...map.values()].filter((c) => c.blocksLos);
  const debris = [...map.values()].filter((c) => c.debris);
  assert.ok(blockers.length >= 8, 'expected a field with real cover');
  assert.ok(debris.length >= 4, 'expected debris fields');
  for (const spawn of [[3, 7], [5, 8], [7, 7], [2, 6], [8, 6], [7, 1], [5, 0], [3, 1], [8, 2], [2, 2]]) {
    const cell = map.get(`${spawn[0]},${spawn[1]}`);
    assert.ok(cell, `deployment hex ${spawn} exists`);
    assert.equal(cell.blocksMove, false, `deployment hex ${spawn} must be walkable`);
  }
});

test('AXIAL_DIRS ordering matches DIR_NAMES', () => {
  assert.equal(AXIAL_DIRS.length, DIR_NAMES.length);
  const a = { col: 6, row: 3 };
  AXIAL_DIRS.forEach((_, d) => {
    const n = neighbor(a.col, a.row, d);
    assert.equal(hexDistance(a, n), 1, DIR_NAMES[d]);
  });
});
