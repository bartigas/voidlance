// Static game data: ship roster, weapons, systems, battlefield layout.
// Both fleets use the same mirror roster so the match is symmetric.

export const ARC = {
  fore: [0],
  broad: [1, 5],
  foreBroad: [0, 1, 5],
  all: [0, 1, 2, 3, 4, 5],
};

export const ARC_LABEL = {
  fore: 'Fore',
  broad: 'Broadside',
  foreBroad: 'Fore + Broad',
  all: 'Full Circle',
};

export const WEAPON_KIND = {
  kinetic: { label: 'Kinetic', partials: true, vsShield: 0.5, ignoresArmor: false },
  energy: { label: 'Energy', partials: false, vsShield: 1.5, ignoresArmor: true },
  torpedo: { label: 'Torpedo', partials: true, vsShield: 1.0, ignoresArmor: false, pierce: 0.5 },
  missile: { label: 'Missile', partials: true, vsShield: 1.0, ignoresArmor: false },
};

// armor value by aspect: fore, broad, aft
export const ASPECT_ARMOR = [3, 2, 1];

export const SHIP_CLASSES = {
  LANCE: {
    id: 'LANCE',
    name: 'Lance',
    role: 'Destroyer',
    glyph: '🗡',
    hull: 70,
    armor: 1,
    shield: 20,
    regen: 6,
    thrust: 5,
    evade: 8,
    scale: 0.82,
    accent: 0x53e0ff,
    accentCss: '#53e0ff',
    blurb: 'Fragile sprinter. Closes fast and stabs with a torpedo rack that punches through armour.',
    weapons: [
      {
        id: 'lance_rack', name: 'Lance Torpedo Rack', kind: 'torpedo',
        dmg: [22, 34], range: [2, 6], arc: 'foreBroad', acc: 70, cooldown: 1,
        note: 'Heavy torpedo. Ignores half of the target armour.',
      },
      {
        id: 'rail_spike', name: 'Rail Spike', kind: 'kinetic',
        dmg: [8, 12], range: [1, 3], arc: 'fore', acc: 85, cooldown: 0,
        note: 'Rapid railgun. Short range, very accurate.',
      },
    ],
    system: {
      id: 'overdrive', name: 'Overdrive', charges: 2,
      short: 'ODB', desc: '+3 thrust and +15 evade until the end of this turn.',
    },
  },
  BULWARK: {
    id: 'BULWARK',
    name: 'Bulwark',
    role: 'Dreadnought',
    glyph: '⛨',
    hull: 150,
    armor: 4,
    shield: 40,
    regen: 8,
    thrust: 2,
    evade: 0,
    scale: 1.25,
    accent: 0xffb648,
    accentCss: '#ffb648',
    blurb: 'Slow wall of the line. Thick armour and a nova battery that scorches shields.',
    weapons: [
      {
        id: 'nova_battery', name: 'Nova Battery', kind: 'energy',
        dmg: [26, 38], range: [3, 6], arc: 'broad', acc: 70, cooldown: 1,
        note: 'Energy lance. Ignores armour and overloads shields.',
      },
      {
        id: 'twin_cannon', name: 'Twin Cannon', kind: 'kinetic',
        dmg: [14, 20], range: [2, 5], arc: 'foreBroad', acc: 78, cooldown: 0,
        note: 'Dependable broadside cannon.',
      },
    ],
    system: {
      id: 'fortify', name: 'Fortify', charges: 2,
      short: 'FRT', desc: '+20 shields immediately and +2 armour until your next turn.',
    },
  },
  WARDEN: {
    id: 'WARDEN',
    name: 'Warden',
    role: 'Support Cruiser',
    glyph: '✚',
    hull: 90,
    armor: 2,
    shield: 30,
    regen: 10,
    thrust: 3,
    evade: 4,
    scale: 1.0,
    accent: 0x7dffb1,
    accentCss: '#7dffb1',
    blurb: 'Keeps the fleet alive. Projects aegis shields onto a ally and covers close range.',
    weapons: [
      {
        id: 'flak_salvo', name: 'Flak Salvo', kind: 'kinetic',
        dmg: [9, 13], range: [1, 3], arc: 'all', acc: 80, cooldown: 0,
        note: 'Close-range flak. Any facing.',
      },
      {
        id: 'pulse_lance', name: 'Pulse Lance', kind: 'energy',
        dmg: [12, 16], range: [3, 5], arc: 'all', acc: 75, cooldown: 0,
        note: 'Shield-stripping energy bolt, all aspects.',
      },
    ],
    system: {
      id: 'aegis', name: 'Aegis Field', charges: 2, target: 'ally', radius: 3,
      short: 'AEG', desc: 'Grant an ally within 3 hexes +25 shields.',
    },
  },
  TEMPEST: {
    id: 'TEMPEST',
    name: 'Tempest',
    role: 'Missile Frigate',
    glyph: '✦',
    hull: 80,
    armor: 1,
    shield: 24,
    regen: 7,
    thrust: 4,
    evade: 10,
    scale: 0.9,
    accent: 0xff7ad9,
    accentCss: '#ff7ad9',
    blurb: 'Swarms the enemy with missile pods. Weak to return fire — keep the distance.',
    weapons: [
      {
        id: 'swarm_launchers', name: 'Swarm Launchers', kind: 'missile',
        dmg: [5, 8], hits: 4, range: [2, 4], arc: 'all', acc: 65, cooldown: 1,
        note: 'Four independent pods, each rolled separately.',
      },
      {
        id: 'pulse_cannon', name: 'Pulse Cannon', kind: 'kinetic',
        dmg: [10, 14], range: [1, 4], arc: 'foreBroad', acc: 82, cooldown: 0,
        note: 'General-purpose autocannon.',
      },
    ],
    system: {
      id: 'saturation', name: 'Saturation Protocol', charges: 2,
      short: 'SAT', desc: 'Your next swarm fires 6 pods and ignores cover.',
    },
  },
  REVENANT: {
    id: 'REVENANT',
    name: 'Revenant',
    role: 'ECM Corvette',
    glyph: '◈',
    hull: 75,
    armor: 1,
    shield: 22,
    regen: 8,
    thrust: 5,
    evade: 12,
    scale: 0.85,
    accent: 0xb98cff,
    accentCss: '#b98cff',
    blurb: 'Jams enemy fire and slips between hexes. Disruptors peel shields away.',
    weapons: [
      {
        id: 'disruptor_beam', name: 'Disruptor Beam', kind: 'energy',
        dmg: [14, 20], range: [2, 4], arc: 'fore', acc: 72, cooldown: 0, shieldBurn: 2,
        note: 'On hit, permanently drains 2 points of the target shield capacity.',
      },
      {
        id: 'revenant_torpedo', name: 'Torpedo', kind: 'torpedo',
        dmg: [18, 26], range: [2, 5], arc: 'broad', acc: 68, cooldown: 1,
        note: 'Broadside torpedo.',
      },
    ],
    system: {
      id: 'phase_shift', name: 'Phase Shift', charges: 2, target: 'empty', radius: 3,
      short: 'PHS', desc: 'Teleport up to 3 hexes, ignoring obstacles.',
    },
  },
};

export const ROSTER_ORDER = ['BULWARK', 'WARDEN', 'TEMPEST', 'LANCE', 'REVENANT'];

export const DIFFICULTIES = {
  easy: {
    id: 'easy', name: 'Cadet',
    desc: 'Enemy gunners hesitate. Reduced accuracy and lots of tactical mistakes.',
    aiNoise: 26, accMod: -8, focus: 0.55, aggression: 0.75,
  },
  normal: {
    id: 'normal', name: 'Captain',
    desc: 'A competent opposing fleet commander. Flanks, covers, and picks its fights.',
    aiNoise: 11, accMod: 0, focus: 0.85, aggression: 1.0,
  },
  hard: {
    id: 'hard', name: 'Fleet Admiral',
    desc: 'Brutally efficient. Concentrates fire, exploits rear arcs, punishes overextension.',
    aiNoise: 3, accMod: 6, focus: 1.15, aggression: 1.2,
  },
};

export const MAP_COLS = 11;
export const MAP_ROWS = 9;
export const HEX_SIZE = 2.15;

// Static battlefield layout. '#' asteroid (blocks movement + LOS),
// '.' plain, '~' debris field (passable, degrades accuracy, hurts on entry).
const LAYOUT = [
  '.#.......#.',
  '..#..~..#..',
  '...#...#...',
  '..~.#.#.~..',
  '...~...~...',
  '..~.#.#.~..',
  '...#...#...',
  '..#..~..#..',
  '.#.......#.',
];

// Player deployment cells (col,row) — bottom of the field.
export const PLAYER_SPAWNS = [
  [3, 7], [5, 8], [7, 7], [2, 6], [8, 6],
];
// Enemy deployment cells — top of the field.
export const ENEMY_SPAWNS = [
  [7, 1], [5, 0], [3, 1], [8, 2], [2, 2],
];

export function buildMap() {
  const cells = new Map();
  for (let row = 0; row < MAP_ROWS; row++) {
    const line = LAYOUT[row] || '';
    for (let col = 0; col < MAP_COLS; col++) {
      const ch = line[col] || '.';
      const cell = { col, row, kind: 'plain', blocksMove: false, blocksLos: false, debris: false, hazard: false };
      if (ch === '#') {
        cell.kind = 'asteroid';
        cell.blocksMove = true;
        cell.blocksLos = true;
        cell.hp = 40;
      } else if (ch === '~') {
        cell.kind = 'debris';
        cell.debris = true;
        cell.hazard = true;
      }
      cells.set(col + ',' + row, cell);
    }
  }
  return cells;
}

export const RULES = {
  maxRounds: 12,
  debrisCover: 20,      // accuracy penalty for firing through/into debris
  debrisEntryDamage: 5,  // hull damage when manoeuvring through debris
  jamPenalty: 25,
  lockBonus: 15,
  coverPenalty: 25,
  critRoll: 10,          // d100 <= 10 => critical
  critMult: 1.5,
  minHit: 5,
  maxHit: 95,
  rechargeMult: 1.5,
  splash: 4,
  rangeAcc: { short: -10, long: -8 }, // applied just below min / above max range
  torpedoRangeAcc: -18,
};

export const LOG_KIND = {
  info: 'info',
  player: 'player',
  enemy: 'enemy',
  good: 'good',
  bad: 'bad',
  kill: 'kill',
  system: 'system',
};
