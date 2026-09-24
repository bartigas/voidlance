/**
 * Battle HUD. Everything textual lives in DOM above the WebGL canvas so type
 * stays crisp and screen readers can follow the fight; the 3D layer only draws
 * ships, hexes and effects.
 *
 * The HUD is a pure view: it renders from the state snapshot plus the small
 * `ctx` object main.js maintains (selection, pending weapon, aim reports).
 */

import { ARC_LABEL, RULES, WEAPON_KIND } from '../core/data.js';
import { DIR_NAMES } from '../core/hex.js';
import { labelFor, statusList, summary } from '../core/state.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

const btn = (label, cls, handler, title) => {
  const b = el('button', `vl-btn ${cls || ''}`.trim(), label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', handler);
  return b;
};

const ASPECT_LABEL = ['fore', 'broadside', 'aft'];

function bar(cls, ratio) {
  const wrap = el('div', `vl-bar ${cls}`);
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  wrap.appendChild(fill);
  return { wrap, fill };
}

function chip(text, cls) {
  return el('span', `vl-chipm ${cls || ''}`.trim(), text);
}

export class Hud {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.children = new Map();
    this.logLines = 0;
    this.build();
  }

  build() {
    this.root.textContent = '';

    // ------------------------------------------------------------ top bar
    const top = el('div', 'vl-top');
    const brand = el('div', 'vl-brand');
    brand.appendChild(el('span', 'vl-brand-mark', '◆'));
    brand.appendChild(el('span', 'vl-brand-text', 'VOID LANCE'));
    top.appendChild(brand);

    const status = el('div', 'vl-status');
    this.roundChip = el('span', 'vl-chip', 'ROUND 1');
    this.phaseChip = el('span', 'vl-chip vl-chip-phase', 'DEPLOYMENT');
    status.append(this.roundChip, this.phaseChip);
    top.appendChild(status);

    const fleets = el('div', 'vl-fleets');
    this.fleetBlocks = {};
    for (const team of ['player', 'enemy']) {
      const b = el('div', `vl-fleet vl-fleet-${team}`);
      const label = el('span', 'vl-fleet-label', team === 'player' ? 'FRIENDLY' : 'HOSTILE');
      const { wrap, fill } = bar('vl-fleet-bar', 1);
      const pips = el('div', 'vl-pips');
      b.append(label, wrap, pips);
      fleets.appendChild(b);
      this.fleetBlocks[team] = { wrap, fill, pips };
    }
    top.appendChild(fleets);

    const tools = el('div', 'vl-tools');
    this.speedBtn = btn('1.0×', 'vl-tool', () => this.h.onCycleSpeed(), 'Animation speed  [ ]');
    this.soundBtn = btn('♪ ON', 'vl-tool', () => this.h.onToggleSound(), 'Mute all audio (M)');
    this.bloomBtn = btn('GLOW ON', 'vl-tool', () => this.h.onToggleBloom(), 'Bloom post-processing (B)');
    this.threatBtn = btn('THREAT OFF', 'vl-tool', () => this.h.onToggleThreat(), 'Show enemy firing lines (G)');
    this.viewBtn = btn('TOP-DOWN', 'vl-tool', () => this.h.onToggleView(), 'Switch to tactical top-down (V)');
    this.helpBtn = btn('?', 'vl-tool', () => this.h.onHelp(), 'Controls (H)');
    tools.append(this.speedBtn, this.soundBtn, this.bloomBtn, this.threatBtn, this.viewBtn, this.helpBtn);
    top.appendChild(tools);
    this.root.appendChild(top);

    // -------------------------------------------------------- combat log
    this.logPanel = el('div', 'vl-log');
    this.logPanel.appendChild(el('div', 'vl-log-title', 'COMBAT LOG'));
    this.logBody = el('div', 'vl-log-body');
    this.logPanel.appendChild(this.logBody);
    this.root.appendChild(this.logPanel);

    // -------------------------------------------------------- inspector
    this.inspector = el('aside', 'vl-inspector');
    this.root.appendChild(this.inspector);

    // -------------------------------------------------------- action bar
    this.actions = el('div', 'vl-actions');
    this.actRow = el('div', 'vl-act-row');
    this.rotateBtn = btn('ROTATE ⟳', 'vl-act', () => this.h.onRotate(), 'Rotate 60° — free, once per turn (R)');
    this.rechargeBtn = btn('RECHARGE', 'vl-act', () => this.h.onRecharge(), 'Restore shields (regen ×1.5), ends action');
    this.systemBtn = btn('SYSTEM', 'vl-act vl-act-system', () => this.h.onSystem(), 'Run ship system');
    this.endBtn = btn('END PHASE', 'vl-act vl-act-end', () => this.h.onEndPhase(), 'End your phase (Space)');
    this.actRow.append(this.rotateBtn, this.rechargeBtn, this.systemBtn);
    this.actions.append(this.actRow, this.endBtn);
    this.hint = el('div', 'vl-hint', 'Select a ship');
    this.actions.appendChild(this.hint);
    this.root.appendChild(this.actions);

    // ------------------------------------------------ targeting readout
    this.aim = el('div', 'vl-aim is-hidden');
    this.root.appendChild(this.aim);

    // ------------------------------------------------------------- toast
    this.toastBox = el('div', 'vl-toast');
    this.root.appendChild(this.toastBox);

    // --------------------------------------------------------- ship strip
    this.strip = el('div', 'vl-strip');
    this.root.appendChild(this.strip);
  }

  // -------------------------------------------------------------- top bar

  updateTop(state) {
    const s = summary(state);
    this.roundChip.textContent = `ROUND ${Math.min(state.round, RULES.maxRounds)} / ${RULES.maxRounds}`;
    const phase = state.over
      ? 'BATTLE OVER'
      : state.phase === 'player'
        ? 'YOUR PHASE'
        : 'ENEMY PHASE';
    this.phaseChip.textContent = phase;
    this.phaseChip.classList.toggle('is-player', state.phase === 'player' && !state.over);
    this.phaseChip.classList.toggle('is-enemy', state.phase === 'enemy' && !state.over);

    for (const team of ['player', 'enemy']) {
      const block = this.fleetBlocks[team];
      const ratio = team === 'player' ? s.playerIntegrity : s.enemyIntegrity;
      block.fill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
      block.pips.textContent = '';
      const list = [...state.ships.values()].filter((x) => x.team === team).sort((a, b) => a.index - b.index);
      for (const ship of list) {
        const pip = el('button', `vl-pip ${ship.alive ? '' : 'is-dead'}`.trim());
        pip.type = 'button';
        pip.title = `${labelFor(ship)} — ${ship.alive ? `${Math.round(ship.hull)}/${ship.hullMax} hull` : 'destroyed'}`;
        pip.appendChild(el('span', 'vl-pip-glyph', ship.glyph));
        const mini = el('i', 'vl-pip-hull');
        mini.style.width = `${Math.max(0, (ship.hull / ship.hullMax) * 100)}%`;
        pip.appendChild(mini);
        pip.classList.toggle('is-acted', ship.alive && ship.acted);
        pip.classList.toggle('is-selected', this.ctx?.selectedId === ship.id);
        pip.addEventListener('click', () => this.h.onSelectShip(ship.id, true));
        block.pips.appendChild(pip);
      }
    }
  }

  // ------------------------------------------------------------ inspector

  updateInspector(state, ship, aimByWeapon) {
    this.inspector.textContent = '';
    if (!ship) {
      const empty = el('div', 'vl-insp-empty');
      empty.appendChild(el('div', 'vl-insp-empty-glyph', '◇'));
      empty.appendChild(el('p', null, 'No ship selected.'));
      empty.appendChild(el('p', 'vl-muted', 'Click a hull, or use the fleet pips above. Numbers 1–5 select your ships.'));
      this.inspector.appendChild(empty);
      this.strip.textContent = '';
      return;
    }

    const cls = ship.cls;
    const head = el('div', 'vl-insp-head');
    head.style.setProperty('--accent', cls.accentCss);
    head.appendChild(el('span', 'vl-insp-glyph', cls.glyph));
    const titles = el('div', 'vl-insp-titles');
    titles.appendChild(el('h2', 'vl-insp-name', ship.name));
    titles.appendChild(el('p', 'vl-insp-class', `${cls.name} · ${cls.role}`));
    head.appendChild(titles);
    if (ship.alive && ship.acted) head.appendChild(el('span', 'vl-tag vl-tag-dim', 'ACTED'));
    this.inspector.appendChild(head);

    const rows = el('div', 'vl-insp-bars');
    rows.append(
      this.statBar('HULL', ship.hull, ship.hullMax, ship.hull / ship.hullMax < 0.34 ? 'is-critical' : ''),
      this.statBar('SHIELD', ship.shields, ship.shieldMax, 'is-shield'),
    );
    this.inspector.appendChild(rows);

    const stats = el('div', 'vl-insp-stats');
    const entries = [
      ['THRUST', String(thrustNow(ship))],
      ['EVADE', `${evadeNow(ship)}%`],
      ['ARMOR', String(ship.armorBase)],
      ['HEADING', DIR_NAMES[ship.facing % 6]],
      ['LOCK', `${ship.systemCharges}`],
    ];
    for (const [k, v] of entries) {
      const cell = el('div', 'vl-stat');
      cell.appendChild(el('span', 'vl-stat-k', k));
      cell.appendChild(el('span', 'vl-stat-v', v));
      stats.appendChild(cell);
    }
    this.inspector.appendChild(stats);

    const st = statusList(ship);
    if (st.length) {
      const chips = el('div', 'vl-status-chips');
      for (const s of st) {
        const c = el('span', `vl-status vl-status-${s.key}`, `${s.key.toUpperCase()} ${s.turns}`);
        c.title = STATUS_HINTS[s.key] || '';
        chips.appendChild(c);
      }
      this.inspector.appendChild(chips);
    }

    // weapons
    const wList = el('div', 'vl-weapons');
    wList.appendChild(el('div', 'vl-section-title', 'WEAPONS'));
    for (const w of cls.weapons) {
      const ready = readiness(state, ship, w);
      const row = el('button', `vl-weapon ${ready.ready && !this.locked ? '' : 'is-disabled'}`.trim());
      row.type = 'button';
      const top = el('div', 'vl-weapon-top');
      top.appendChild(el('span', 'vl-weapon-kind', WEAPON_KIND[w.kind].label));
      top.appendChild(el('span', 'vl-weapon-name', w.name));
      if (this.ctx?.pendingWeaponId === w.id) top.classList.add('is-pending');
      const right = el('span', 'vl-weapon-state', ready.reason || (this.ctx?.pendingWeaponId === w.id ? 'PICK TARGET' : 'READY'));
      top.appendChild(right);
      row.appendChild(top);

      const meta = el('div', 'vl-weapon-meta');
      meta.append(
        chip(`${w.dmg[0]}–${w.dmg[1]}`, 'dmg'),
        chip(`${w.range[0]}–${w.range[1]} hex`, 'rng'),
        chip(ARC_LABEL[w.arc], 'arc'),
        chip(`${w.acc}% hit`, 'acc'),
      );
      if (w.hits) meta.appendChild(chip(`${w.hits} pods`, 'pods'));
      if (w.shieldBurn) meta.appendChild(chip(`−${w.shieldBurn} regen`, 'burn'));
      row.appendChild(meta);

      const aim = aimByWeapon?.get(w.id);
      if (aim && aim.ok) {
        const r = el('div', 'vl-weapon-aim');
        r.append(
          el('b', null, `${Math.round(aim.hitChance)}%`),
          el('span', null, `≈${Math.round(aim.expected)} dmg`),
          el('span', 'vl-muted', `to ${aim.aspect} ${ASPECT_LABEL[aim.aspect] ?? ''}`),
        );
        if (aim.cover > 0) r.appendChild(el('span', 'vl-warn', `cover −${aim.cover}`));
        if (aim.breaksShield) r.appendChild(el('span', 'vl-good', 'shield break'));
        row.appendChild(r);
      }
      if (w.note) row.appendChild(el('p', 'vl-weapon-note', w.note));
      if (ready.ready && !this.locked) row.addEventListener('click', () => this.h.onSelectWeapon(w.id));
      wList.appendChild(row);
    }
    this.inspector.appendChild(wList);

    // system
    const sys = cls.system;
    if (sys) {
      const s = el('div', 'vl-system');
      s.appendChild(el('div', 'vl-section-title', 'SYSTEM'));
      const head2 = el('div', 'vl-weapon-top');
      head2.appendChild(el('span', 'vl-weapon-kind', sys.short || 'SYS'));
      head2.appendChild(el('span', 'vl-weapon-name', sys.name));
      head2.appendChild(el('span', 'vl-weapon-state', ship.systemCharges > 0 && !ship.acted && !this.locked ? `${ship.systemCharges} LEFT` : 'SPENT'));
      s.appendChild(head2);
      s.appendChild(el('p', 'vl-weapon-note', sys.desc));
      this.inspector.appendChild(s);
    }

    this.inspector.appendChild(el('p', 'vl-insp-blurb', cls.blurb));
    this.updateStrip(state, ship);
  }

  statBar(label, value, max, cls) {
    const row = el('div', `vl-statbar ${cls || ''}`);
    row.appendChild(el('span', 'vl-statbar-k', label));
    const { wrap, fill } = bar(`vl-fill ${cls || ''}`.trim(), max > 0 ? value / max : 0);
    row.appendChild(wrap);
    row.appendChild(el('span', 'vl-statbar-v', `${Math.max(0, Math.round(value))}/${max}`));
    return row;
  }

  /** Roster strip along the bottom: quick select + status for all 5 ships. */
  updateStrip(state, selected) {
    this.strip.textContent = '';
    const list = [...state.ships.values()].filter((s) => s.team === 'player').sort((a, b) => a.index - b.index);
    list.forEach((ship, i) => {
      const c = el('button', `vl-card ${ship.id === selected?.id ? 'is-selected' : ''} ${ship.alive ? '' : 'is-dead'}`.trim());
      c.type = 'button';
      c.appendChild(el('span', 'vl-card-key', String(i + 1)));
      c.appendChild(el('span', 'vl-card-glyph', ship.glyph));
      const body = el('div', 'vl-card-body');
      body.appendChild(el('span', 'vl-card-name', ship.alive ? ship.name : 'LOST'));
      const mini = el('div', 'vl-card-bar');
      const f = el('i');
      f.style.width = `${Math.max(0, (ship.hull / ship.hullMax) * 100)}%`;
      const sh = el('i', 'vl-card-shield');
      sh.style.width = `${Math.max(0, (ship.shields / ship.shieldMax) * 100)}%`;
      mini.append(f, sh);
      body.appendChild(mini);
      c.appendChild(body);
      if (ship.alive && ship.acted) c.classList.add('is-acted');
      c.title = `${labelFor(ship)} — ${ship.alive ? 'ready' : 'destroyed'}`;
      c.addEventListener('click', () => this.h.onSelectShip(ship.id, true));
      this.strip.appendChild(c);
    });
  }

  // ------------------------------------------------------------- targeting

  showAim(report, target) {
    if (!report || !report.ok || !target) {
      this.aim.classList.add('is-hidden');
      this.aim.textContent = '';
      return;
    }
    this.aim.textContent = '';
    this.aim.classList.remove('is-hidden');
    const head = el('div', 'vl-aim-head');
    head.appendChild(el('span', 'vl-aim-glyph', target.glyph));
    head.appendChild(el('span', null, labelFor(target)));
    this.aim.appendChild(head);
    const grid = el('div', 'vl-aim-grid');
    const cell = (k, v, cls) => {
      const c = el('div', `vl-aim-cell ${cls || ''}`.trim());
      c.appendChild(el('span', null, k));
      c.appendChild(el('b', null, v));
      return c;
    };
    grid.append(
      cell('HIT', `${Math.round(report.hitChance)}%`, report.hitChance >= 65 ? 'vl-good' : report.hitChance >= 45 ? '' : 'vl-warn'),
      cell('DMG', `${report.minDmg}–${report.maxDmg}`),
      cell('AVG', `${Math.round(report.expected)}`),
      cell('RANGE', `${report.dist}`),
      cell('ASPECT', ASPECT_LABEL[report.aspect] ?? '—', report.aspect === 2 ? 'vl-good' : ''),
      cell('COVER', report.cover ? `−${report.cover}` : 'none', report.cover ? 'vl-warn' : ''),
    );
    if (report.pods > 1) grid.appendChild(cell('PODS', String(report.pods)));
    this.aim.appendChild(grid);
    const foot = el('div', 'vl-aim-foot');
    if (report.breaksShield) foot.appendChild(el('span', 'vl-good', 'Collapses shields'));
    if (report.expectedHull >= target.hull) foot.appendChild(el('span', 'vl-danger', 'LETHAL'));
    foot.appendChild(el('span', 'vl-muted', 'click to fire · esc to cancel'));
    this.aim.appendChild(foot);
  }

  setAimPosition(x, y) {
    const pad = 16;
    const w = this.aim.offsetWidth || 250;
    const h = this.aim.offsetHeight || 140;
    this.aim.style.left = `${Math.min(window.innerWidth - w - pad, Math.max(pad, x + 18))}px`;
    this.aim.style.top = `${Math.min(window.innerHeight - h - pad, Math.max(pad, y - h / 2))}px`;
  }

  // -------------------------------------------------------------- feedback

  addLog(entry) {
    const line = el('div', `vl-logline vl-log-${entry.kind || 'info'}`, entry.text);
    if (entry.round) line.title = `Round ${entry.round}`;
    this.logBody.appendChild(line);
    this.logLines += 1;
    while (this.logBody.childElementCount > 90) this.logBody.removeChild(this.logBody.firstChild);
    this.logBody.scrollTop = this.logBody.scrollHeight;
  }

  clearLog() {
    this.logBody.textContent = '';
    this.logLines = 0;
  }

  toast(text, kind = 'info', ms = 1800) {
    const t = el('div', `vl-toast-item vl-log-${kind}`, text);
    this.toastBox.appendChild(t);
    requestAnimationFrame(() => t.classList.add('is-in'));
    setTimeout(() => {
      t.classList.remove('is-in');
      setTimeout(() => t.remove(), 420);
    }, ms);
  }

  /** Lock the HUD while sequences (movement, enemy phase) are playing. */
  setLocked(on) {
    this.locked = Boolean(on);
    this.root.classList.toggle('is-locked', this.locked);
  }

  setSpeedLabel(mult) {
    this.speedBtn.textContent = `${mult}×`;
  }

  setSoundLabel(on) {
    this.soundBtn.textContent = on ? '♪ ON' : '♪ OFF';
    this.soundBtn.classList.toggle('is-off', !on);
  }

  setBloomLabel(on) {
    this.bloomBtn.textContent = on ? 'GLOW ON' : 'GLOW OFF';
    this.bloomBtn.classList.toggle('is-off', !on);
  }

  setThreatLabel(on) {
    this.threatBtn.textContent = on ? 'THREAT ON' : 'THREAT OFF';
    this.threatBtn.classList.toggle('is-on', on);
  }

  setViewLabel(topDown) {
    this.viewBtn.textContent = topDown ? 'OBLIQUE' : 'TOP-DOWN';
  }

  setContext(ctx) {
    this.ctx = ctx;
    this.rotateBtn.disabled = this.locked || !ctx.canRotate;
    this.rechargeBtn.disabled = this.locked || !ctx.canRecharge;
    this.systemBtn.disabled = this.locked || !ctx.canSystem;
    this.endBtn.disabled = this.locked || ctx.phase !== 'player';
    this.systemBtn.textContent = ctx.systemLabel || 'SYSTEM';
    this.hint.textContent = ctx.hint || '';
    this.hint.classList.toggle('is-alert', Boolean(ctx.alert));
  }
}

const STATUS_HINTS = {
  jammed: 'Shield collapse: arrays jammed, −25 to hit for 2 of your turns.',
  locked: 'Illuminated: the next enemy shot at you is +15 to hit.',
  fortified: 'Armour +2 and shields topped up until your next turn.',
  overdrive: '+3 thrust, +15 evade until the end of this turn.',
  saturation: 'Next swarm launch adds 2 pods and ignores cover.',
};

function thrustNow(ship) {
  return ship.cls.thrust + (ship.status.overdrive ? 3 : 0);
}
function evadeNow(ship) {
  return ship.cls.evade + (ship.status.overdrive ? 15 : 0);
}
function readiness(state, ship, weapon) {
  const cd = ship.cooldowns[weapon.id] || 0;
  if (cd > 0) return { ready: false, reason: `RELOADING ${cd}` };
  if (ship.acted) return { ready: false, reason: 'ACTED' };
  return { ready: true, reason: '' };
}
