/**
 * Full-screen overlays: briefing before the first shot, the after-action report
 * when the drift gate closes, and the controls sheet. Same DOM toolkit as the
 * HUD so the whole interface shares one type ramp and palette.
 */

import { ARC_LABEL, DIFFICULTIES, RULES, SHIP_CLASSES } from '../core/data.js';
import { labelFor } from '../core/state.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

const button = (label, cls, handler) => {
  const b = el('button', `vl-btn ${cls || ''}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', handler);
  return b;
};

const CONTROLS = [
  ['Left drag', 'Orbit the camera around the fleet'],
  ['Middle / right drag', 'Pan the battlefield'],
  ['Wheel', 'Zoom in and out'],
  ['W A S D', 'Pan · Q / E roll · +/- or [ ] animation speed'],
  ['Click a hull', 'Select it — move range lights up in cyan'],
  ['Click a cyan hex', 'Move there (costs thrust, may be done before or after firing)'],
  ['R', 'Rotate 60° toward the pointer — free, once per ship per turn'],
  ['Click a weapon row', 'Enter targeting; enemy hexes show hit chance and average damage'],
  ['Click an enemy', 'Fire. Esc aborts the shot'],
  ['G', 'Threat overlay: every hex the enemy fleet can currently shoot'],
  ['V', 'Top-down tactical view'],
  ['Tab', 'Cycle to the next ship that still has orders'],
  ['Space', 'End your phase'],
  ['M / B', 'Mute audio / toggle bloom'],
];

const RULE_NOTES = [
  'Each ship acts once per phase: move up to its thrust, one free 60° rotation, then exactly one of Fire, System or Recharge.',
  'Weapons only fire inside their arc — fore, broadside or full circle — so facing matters more than range.',
  'Incoming damage is reduced by armour according to the aspect it arrives on: fore is hardest, a stern-on hit lands at its weakest.',
  'Shields regenerate at the start of your own phase. A shield collapse jams weapons for two turns; energy weapons burn shield capacity permanently.',
  'Aegis, Overdrive, Saturation, Fortify and Phase Shift each have two charges a battle. Recharge restores regen ×1.5 and ends the ship’s action.',
  `Debris fields degrade accuracy for shooter and target alike and scrape ${RULES.debrisEntryDamage} hull on entry. Asteroids block movement and line of sight.`,
  `The drift gate closes after ${RULES.maxRounds} rounds: whatever is still flying is scored on fleet integrity.`,
];

export class Screens {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.which = null;
    this.difficulty = 'normal';
  }

  clear() {
    this.root.textContent = '';
    this.root.classList.remove('is-visible');
    document.body.classList.remove('vl-screen-up');
    this.which = null;
  }

  present(cls) {
    this.root.textContent = '';
    this.root.classList.add('is-visible');
    document.body.classList.add('vl-screen-up');
    this.which = cls;
  }

  showTitle() {
    this.present('title');
    const wrap = el('div', 'vl-screen vl-screen-title');

    const hero = el('div', 'vl-hero');
    hero.appendChild(el('p', 'vl-hero-kicker', 'TURN-BASED FLEET TACTICS · 5 v 5'));
    const h1 = el('h1', 'vl-hero-title');
    h1.append(el('span', 'vl-hero-word', 'VOID'), el('span', 'vl-hero-word vl-hero-word-accent', 'LANCE'));
    hero.appendChild(h1);
    hero.appendChild(el('p', 'vl-hero-sub',
      'Five hulls against five, in the last readable light before the drift gate seals. Position, facing and firing arcs decide it — not how fast you click.'));
    wrap.appendChild(hero);

    // difficulty -------------------------------------------------------
    const diffBox = el('div', 'vl-block');
    diffBox.appendChild(el('h2', 'vl-block-title', 'OPPOSING COMMANDER'));
    const diffRow = el('div', 'vl-diff-row');
    this.diffCards = {};
    for (const d of Object.values(DIFFICULTIES)) {
      const card = el('button', `vl-diff ${d.id === this.difficulty ? 'is-on' : ''}`.trim());
      card.type = 'button';
      card.appendChild(el('h3', 'vl-diff-name', d.name));
      card.appendChild(el('p', 'vl-diff-desc', d.desc));
      card.appendChild(el('p', 'vl-diff-meta',
        `accuracy ${d.accMod >= 0 ? '+' : ''}${d.accMod} · judgement ${d.aiNoise <= 4 ? 'ruthless' : d.aiNoise <= 12 ? 'sharp' : 'loose'}`));
      card.addEventListener('click', () => {
        this.difficulty = d.id;
        for (const [k, c] of Object.entries(this.diffCards)) c.classList.toggle('is-on', k === d.id);
      });
      diffRow.appendChild(card);
      this.diffCards[d.id] = card;
    }
    diffBox.appendChild(diffRow);
    wrap.appendChild(diffBox);

    // roster -----------------------------------------------------------
    const roster = el('div', 'vl-block');
    roster.appendChild(el('h2', 'vl-block-title', 'YOUR SQUADRON'));
    const grid = el('div', 'vl-roster-grid');
    for (const cls of Object.values(SHIP_CLASSES)) {
      const c = el('div', 'vl-roster-card');
      c.style.setProperty('--accent', cls.accentCss);
      const head = el('div', 'vl-roster-head');
      head.appendChild(el('span', 'vl-roster-glyph', cls.glyph));
      const t = el('div');
      t.appendChild(el('h4', 'vl-roster-name', cls.name));
      t.appendChild(el('p', 'vl-roster-role', `${cls.role} · ${cls.hull} hull · ${cls.shield} shield · ${cls.thrust} thrust`));
      head.appendChild(t);
      c.appendChild(head);
      c.appendChild(el('p', 'vl-roster-blurb', cls.blurb));
      const w = el('ul', 'vl-roster-weapons');
      for (const wpn of cls.weapons) {
        w.appendChild(el('li', null, `${wpn.name} — ${wpn.dmg[0]}–${wpn.dmg[1]} · ${ARC_LABEL[wpn.arc]} · ${wpn.range[0]}–${wpn.range[1]} hex`));
      }
      w.appendChild(el('li', 'vl-roster-sys', `${cls.system.name}: ${cls.system.desc}`));
      c.appendChild(w);
      grid.appendChild(c);
    }
    roster.appendChild(grid);
    wrap.appendChild(roster);

    // rules ------------------------------------------------------------
    const rules = el('div', 'vl-block');
    rules.appendChild(el('h2', 'vl-block-title', 'STANDING ORDERS'));
    const list = el('ul', 'vl-rules');
    for (const note of RULE_NOTES) list.appendChild(el('li', null, note));
    rules.appendChild(list);
    wrap.appendChild(rules);

    const go = el('div', 'vl-screen-cta');
    go.appendChild(button('ENGAGE', 'vl-btn-primary', () => this.h.onStart(this.difficulty)));
    go.appendChild(button('CONTROLS', 'vl-btn-ghost', () => this.showHelp()));
    wrap.appendChild(go);

    this.root.appendChild(wrap);
  }

  showHelp() {
    this.helpReturn = this.which;
    this.present('help');
    const wrap = el('div', 'vl-screen vl-screen-help');
    const box = el('div', 'vl-panel');
    box.appendChild(el('h2', 'vl-panel-title', 'CONTROLS'));
    const table = el('div', 'vl-keys');
    for (const [k, v] of CONTROLS) {
      const row = el('div', 'vl-key-row');
      row.appendChild(el('span', 'vl-key', k));
      row.appendChild(el('span', 'vl-key-desc', v));
      table.appendChild(row);
    }
    box.appendChild(table);
    box.appendChild(el('p', 'vl-muted', 'Everything is mouse-only friendly: select, move, aim, fire. Keyboard just makes it quicker.'));
    const foot = el('div', 'vl-panel-foot');
    foot.appendChild(button('BACK', 'vl-btn-primary', () => {
      if (this.helpReturn === 'title') this.showTitle();
      else if (this.helpReturn === 'result') this.showResult(this.lastOver, this.lastState);
      else this.clear();
    }));
    box.appendChild(foot);
    wrap.appendChild(box);
    this.root.appendChild(wrap);
  }

  showResult(over, state) {
    this.lastOver = over;
    this.lastState = state;
    this.present('result');
    const wrap = el('div', 'vl-screen vl-screen-result');
    const box = el('div', 'vl-panel');
    const tone = over.result === 'victory' ? 'is-victory' : over.result === 'defeat' ? 'is-defeat' : 'is-draw';

    const head = el('div', `vl-result-head ${tone}`);
    head.appendChild(el('p', 'vl-result-kicker', over.reason));
    head.appendChild(el('h2', 'vl-result-title', over.result.toUpperCase()));
    const rank = el('div', 'vl-rank');
    rank.appendChild(el('span', 'vl-rank-letter', over.rank));
    rank.appendChild(el('span', 'vl-rank-score', `${over.score} PTS`));
    head.appendChild(rank);
    box.appendChild(head);

    const grid = el('div', 'vl-result-stats');
    const stat = (k, v) => {
      const c = el('div', 'vl-rstat');
      c.appendChild(el('span', null, k));
      c.appendChild(el('b', null, String(v)));
      grid.appendChild(c);
    };
    stat('ROUNDS', Math.min(over.rounds, RULES.maxRounds));
    stat('HULLS SAVED', `${over.saved} / 5`);
    stat('HULLS DESTROYED', `${over.destroyed} / 5`);
    stat('DAMAGE DEALT', over.playerDamage);
    stat('DAMAGE TAKEN', over.enemyDamage);
    stat('DIFFICULTY', DIFFICULTIES[state.difficultyId]?.name ?? state.difficultyId);
    box.appendChild(grid);

    const board = el('div', 'vl-board');
    board.appendChild(el('h3', 'vl-section-title', 'SQUADRON REPORT'));
    const rows = [...state.ships.values()].sort((a, b) => (a.team === b.team ? a.index - b.index : a.team === 'player' ? -1 : 1));
    for (const s of rows) {
      const r = el('div', `vl-board-row ${s.team === 'player' ? 'is-player' : 'is-enemy'} ${s.alive ? '' : 'is-dead'}`.trim());
      r.appendChild(el('span', 'vl-board-glyph', s.glyph));
      r.appendChild(el('span', 'vl-board-name', labelFor(s)));
      const bar = el('div', 'vl-board-bar');
      const f = el('i');
      f.style.width = `${Math.max(0, (s.hull / s.hullMax) * 100)}%`;
      bar.appendChild(f);
      r.appendChild(bar);
      r.appendChild(el('span', 'vl-board-num', s.alive ? `${Math.round(s.hull)}/${s.hullMax}` : 'DESTROYED'));
      r.appendChild(el('span', 'vl-board-num vl-muted', `${Math.round(s.damageDealt)} dealt`));
      board.appendChild(r);
    }
    box.appendChild(board);

    const foot = el('div', 'vl-panel-foot');
    foot.appendChild(button('NEW BATTLE', 'vl-btn-primary', () => this.h.onStart(state.difficultyId)));
    foot.appendChild(button('CHANGE ORDERS', 'vl-btn-ghost', () => this.showTitle()));
    box.appendChild(foot);
    wrap.appendChild(box);
    this.root.appendChild(wrap);
  }
}
