// Movement graph. Uniform-cost search over the hex field so that debris fields
// (expensive, hazardous) are avoided when a plain route exists at the same
// thrust budget.

import { cellKey, parseKey, neighbor } from './hex.js';

export function shipAt(state, col, row) {
  for (const s of state.ships.values()) {
    if (s.alive && s.col === col && s.row === row) return s;
  }
  return null;
}

export function cellAt(state, col, row) {
  return state.map.get(cellKey(col, row)) || null;
}

export function isPassable(state, ship, col, row) {
  const cell = cellAt(state, col, row);
  if (!cell || cell.blocksMove) return false;
  const occ = shipAt(state, col, row);
  return !occ || occ.id === ship.id;
}

function stepCost(cell) {
  return cell.debris ? 1.75 : 1;
}

// Cost of every hex the ship can spend its remaining thrust reaching.
// Returns { costs: Map<key, cost>, prev: Map<key, key>, start: key }.
export function computeReach(state, ship, thrust) {
  const start = cellKey(ship.col, ship.row);
  const costs = new Map([[start, 0]]);
  const prev = new Map();
  const settled = new Set();
  const frontier = [{ key: start, cost: 0 }];

  while (frontier.length) {
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].cost < frontier[bi].cost) bi = i;
    const cur = frontier.splice(bi, 1)[0];
    if (settled.has(cur.key)) continue;
    settled.add(cur.key);

    const at = parseKey(cur.key);
    for (let d = 0; d < 6; d++) {
      const n = neighbor(at.col, at.row, d);
      const key = cellKey(n.col, n.row);
      const cell = state.map.get(key);
      if (!cell || cell.blocksMove) continue;
      const occ = shipAt(state, n.col, n.row);
      if (occ && occ.id !== ship.id) continue;
      const cost = cur.cost + stepCost(cell);
      if (cost > thrust + 1e-6) continue;
      if (costs.has(key) && costs.get(key) <= cost) continue;
      costs.set(key, cost);
      prev.set(key, cur.key);
      frontier.push({ key, cost });
    }
  }
  costs.delete(start);
  return { costs, prev, start };
}

export function pathKeys(result, key) {
  const out = [key];
  let cur = key;
  let guard = 0;
  while (result.prev.has(cur) && guard++ < 256) {
    cur = result.prev.get(cur);
    out.push(cur);
    if (cur === result.start) break;
  }
  return out.reverse();
}

export function pathCells(result, key) {
  return pathKeys(result, key).map((k) => parseKey(k));
}

// Ordered list of reachable hexes with their world-agnostic path, used by both
// the movement overlay and the AI's candidate enumeration.
export function reachOptions(state, ship, thrust) {
  const result = computeReach(state, ship, thrust);
  const out = [];
  for (const [key, cost] of result.costs) {
    const at = parseKey(key);
    out.push({ key, col: at.col, row: at.row, cost, cells: pathCells(result, key) });
  }
  out.sort((a, b) => a.cost - b.cost || a.row - b.row || a.col - b.col);
  return out;
}

// Cells an actor can teleport into: any free, non-blocking hex within radius.
export function teleportOptions(state, ship, radius) {
  const out = [];
  for (const cell of state.map.values()) {
    if (cell.blocksMove) continue;
    const occ = shipAt(state, cell.col, cell.row);
    if (occ && occ.id !== ship.id) continue;
    const d = (function dist() {
      const a = { col: ship.col, row: ship.row };
      const b = { col: cell.col, row: cell.row };
      // inline hexDistance without importing twice for clarity
      const ax = { q: a.col - (a.row - (a.row & 1)) / 2, r: a.row };
      const bx = { q: b.col - (b.row - (b.row & 1)) / 2, r: b.row };
      const dq = ax.q - bx.q, dr = ax.r - bx.r;
      return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
    })();
    if (d === 0 || d > radius) continue;
    out.push({ key: cellKey(cell.col, cell.row), col: cell.col, row: cell.row, dist: d });
  }
  return out;
}
