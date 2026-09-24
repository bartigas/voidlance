// Hex grid maths. Canonical storage coordinates are offset (col,row) using a
// pointy-top, odd-r shifted layout; all metric maths go through cube space.
// World layout: hexes lie on the y=0 plane, +x right, -z "up" the screen.

export const SQRT3 = Math.sqrt(3);

// pointy-top axial direction table (Red Blob Games ordering, CCW from East)
export const AXIAL_DIRS = [
  [+1, 0],  // 0 E
  [+1, -1], // 1 NE
  [0, -1],  // 2 NW
  [-1, 0],  // 3 W
  [-1, +1], // 4 SW
  [0, +1],  // 5 SE
];

export const DIR_NAMES = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

// Yaw (radians, rotation about +y) that points a model's local +x down a dir.
export const DIR_YAW = AXIAL_DIRS.map(([dq, dr]) => {
  const x = SQRT3 * (dq + dr / 2);
  const z = 1.5 * dr;
  return Math.atan2(-z, x);
});

export function offsetToAxial(col, row) {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

export function axialToOffset(q, r) {
  return { col: q + (r - (r & 1)) / 2, row: r };
}

export function cellKey(col, row) {
  return col + ',' + row;
}

export function parseKey(key) {
  const i = key.indexOf(',');
  return { col: +key.slice(0, i), row: +key.slice(i + 1) };
}

export function hexDistance(a, b) {
  const ax = offsetToAxial(a.col, a.row);
  const bx = offsetToAxial(b.col, b.row);
  const dq = ax.q - bx.q;
  const dr = ax.r - bx.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function neighbor(col, row, dir) {
  const ax = offsetToAxial(col, row);
  const d = AXIAL_DIRS[(dir % 6 + 6) % 6];
  return axialToOffset(ax.q + d[0], ax.r + d[1]);
}

// Direction index pointing from cell a to adjacent cell b (or -1).
export function directionTo(a, b) {
  for (let d = 0; d < 6; d++) {
    const n = neighbor(a.col, a.row, d);
    if (n.col === b.col && n.row === b.row) return d;
  }
  return -1;
}

// Direction index from any cell a toward any cell b (nearest of the 6).
export function directionToward(a, b) {
  const ax = offsetToAxial(a.col, a.row);
  const bx = offsetToAxial(b.col, b.row);
  const dq = bx.q - ax.q;
  const dr = bx.r - ax.r;
  if (dq === 0 && dr === 0) return -1;
  let best = 0, bestDot = -Infinity;
  const wx = SQRT3 * (dq + dr / 2), wz = 1.5 * dr;
  const len = Math.hypot(wx, wz) || 1;
  for (let d = 0; d < 6; d++) {
    const dx = SQRT3 * (AXIAL_DIRS[d][0] + AXIAL_DIRS[d][1] / 2);
    const dz = 1.5 * AXIAL_DIRS[d][1];
    const dot = (dx / len) * (wx / len) + (dz / len) * (wz / len);
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}

export const ASPECT_FORE = 0, ASPECT_BROAD = 1, ASPECT_AFT = 2;

// 0 fore, 1 broadside, 2 aft, given attacker facing and target cell.
export function aspectToward(fromCell, toCell, facing) {
  const d = directionToward(fromCell, toCell);
  if (d < 0) return ASPECT_FORE;
  const k = (d - facing + 6) % 6;
  if (k === 0) return ASPECT_FORE;
  if (k === 1 || k === 5) return ASPECT_BROAD;
  return ASPECT_AFT;
}

export function cellToWorld(col, row, size) {
  return {
    x: size * SQRT3 * (col + 0.5 * (row & 1)),
    z: size * 1.5 * row,
  };
}

export function worldToCell(x, z, size) {
  const r = (z / size) / 1.5;
  const q = (x / size) * SQRT3 / 3 - r / 2;
  // round in cube space
  let rx = q, rz = r, ry = -rx - rz;
  let ix = Math.round(rx), iy = Math.round(ry), iz = Math.round(rz);
  const dx = Math.abs(ix - rx), dy = Math.abs(iy - ry), dz = Math.abs(iz - rz);
  if (dx > dy && dx > dz) ix = -iy - iz;
  else if (dy > dz) iy = -ix - iz;
  else iz = -ix - iy;
  return axialToOffset(ix, iz);
}

// Corners of a pointy-top hex, in world space (y up out of the plane).
export function hexCorners(size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push([size * Math.cos(a), size * Math.sin(a)]);
  }
  return pts;
}

// Cells whose centers the segment a->b passes close enough to matter for LOS.
export function lineOfSight(map, a, b) {
  const ax = offsetToAxial(a.col, a.row), bx = offsetToAxial(b.col, b.row);
  const af = axialToWorldFrac(ax.q, ax.r), bf = axialToWorldFrac(bx.q, bx.r);
  const dist = hexDistance(a, b);
  const steps = Math.max(1, Math.ceil(dist * 3));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const w = { x: af.x + (bf.x - af.x) * t, z: af.z + (bf.z - af.z) * t };
    const c = worldToCell(w.x, w.z, 1);
    if (c.col === a.col && c.row === a.row) continue;
    if (c.col === b.col && c.row === b.row) continue;
    const cell = map.get(cellKey(c.col, c.row));
    if (cell && cell.blocksLos) return false;
  }
  return true;
}

function axialToWorldFrac(q, r) {
  const o = axialToOffset(q, r);
  return { x: SQRT3 * (o.col + 0.5 * (o.row & 1)), z: 1.5 * o.row };
}

export function cellsWithin(map, from, radius, filter) {
  const out = [];
  for (const cell of map.values()) {
    const d = hexDistance(from, cell);
    if (d <= radius && (!filter || filter(cell, d))) out.push(cell);
  }
  return out;
}
