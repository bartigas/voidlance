#!/usr/bin/env node
/**
 * End-to-end smoke: boots the real page in a headless browser, plays a few
 * rounds through the game's own controller, and fails on any console error,
 * page error, failed request, or missing WebGL context.
 *
 *   node scripts/smoke.mjs [--rounds 3] [--url http://localhost:4173/] [--shots dir]
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BROWSERS = [
  process.env.CHROME_PATH,
  '/usr/bin/brave-browser',
  '/opt/brave.com/brave/brave-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL = arg('url', 'http://localhost:4173/');
const ROUNDS = Number(arg('rounds', 3));
const SHOTS = path.resolve(arg('shots', '.qwen/tmp/shots'));
const executablePath = BROWSERS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Chromium/Brave found. Set CHROME_PATH.');
  process.exit(2);
}

mkdirSync(SHOTS, { recursive: true });

const problems = [];
const logs = [];

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1600,900',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

page.on('console', (msg) => {
  const text = msg.text();
  logs.push(`${msg.type()}: ${text}`);
  if (msg.type() === 'error') problems.push(`console.error ${text}`);
  if (msg.type() === 'warning' && /three|webgl|shader/i.test(text)) problems.push(`console.warn ${text}`);
});
page.on('pageerror', (err) => problems.push(`pageerror ${err && err.message ? err.message : String(err)}`));
page.on('requestfailed', (req) => {
  const why = req.failure() ? req.failure().errorText : 'failed';
  problems.push(`requestfailed ${req.url()} ${why}`);
});

const shot = async (name) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  • screenshot ${path.relative(process.cwd(), file)}`);
};

const step = async (label, fn) => {
  process.stdout.write(`→ ${label}\n`);
  await fn();
};

try {
  await step('load page', async () => {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.vl-boot, .vl-screen-title', { timeout: 20000 });
  });

  await step('wait for the WebGL renderer and briefing', async () => {
    const info = await page.waitForFunction(
      () => (window.VOID_LANCE && window.VOID_LANCE.scene ? window.VOID_LANCE.scene.renderer.info : null),
      { timeout: 30000 },
    ).then((h) => h.jsonValue());
    if (!info) throw new Error('BattleScene never booted');
    console.log(`  • render calls=${info.render.calls} geometries=${info.memory.geometries} textures=${info.memory.textures}`);
    await page.waitForSelector('.vl-screen-title', { timeout: 15000 });
  });

  await shot('01-briefing');

  await step('start the battle on Captain', async () => {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.vl-btn-primary')].find((b) => /engage/i.test(b.textContent));
      if (!btn) throw new Error('ENGAGE button not found');
      btn.click();
    });
    await page.waitForFunction(() => {
      const g = window.VOID_LANCE;
      return Boolean(g && g.state && g.state.ships.size === 10 && !document.querySelector('.vl-screen'));
    }, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1200));
  });

  await shot('02-battle-start');

  await step('check the HUD painted', async () => {
    const counts = await page.evaluate(() => ({
      weapons: document.querySelectorAll('.vl-weapon').length,
      cards: document.querySelectorAll('.vl-card').length,
      pips: document.querySelectorAll('.vl-pip').length,
      log: document.querySelectorAll('.vl-logline').length,
      hint: (document.querySelector('.vl-hint') || {}).textContent,
    }));
    console.log(`  • ${JSON.stringify(counts)}`);
    if (counts.weapons < 1) problems.push('HUD rendered no weapon rows');
    if (counts.cards !== 5) problems.push(`expected 5 fleet cards, got ${counts.cards}`);
    if (counts.pips !== 10) problems.push(`expected 10 fleet pips, got ${counts.pips}`);
  });

  await step(`play ${ROUNDS} round(s) through the real controller`, async () => {
    await page.evaluate(async () => {
      const { planShip } = await import('/src/core/ai.js');
      const g = window.VOID_LANCE;
      g.setSpeedIdx(3);
      // Play the human side with the same planner the fleet AI uses, so the
      // smoke run exercises arcs, systems and recharging, not just point-blank fire.
      window.VL_SMOKE = async function playRound() {
        const st = g.state;
        const ids = [...st.ships.values()]
          .filter((s) => s.team === 'player' && s.alive && !s.acted)
          .sort((a, b) => a.index - b.index)
          .map((s) => s.id);
        for (const id of ids) {
          if (st.over || st.phase !== 'player') return;
          const ship = st.ships.get(id);
          if (!ship || !ship.alive || ship.acted) continue;
          g.selectShip(id);
          const plan = planShip(st, ship);
          for (const order of plan.orders) {
            if (st.over || st.phase !== 'player' || !ship.alive || ship.acted) break;
            await g.runOrder(ship, order);
          }
          if (!st.over && st.phase === 'player' && ship.alive && !ship.acted) {
            await g.runOrder(ship, { kind: 'recharge' });
          }
        }
        if (!st.over && st.phase === 'player') await g.endPhase();
      };
    });

    for (let r = 0; r < ROUNDS; r += 1) {
      const done = await page.evaluate(async () => {
        const g = window.VOID_LANCE;
        await window.VL_SMOKE();
        return { round: g.state.round, over: Boolean(g.state.over), phase: g.state.phase, busy: g.busy };
      });
      console.log(`  • round ${done.round} — phase=${done.phase} over=${done.over} busy=${done.busy}`);
      if (done.busy) problems.push('controller still busy after a full round — a sequence never resolved');
      if (done.over) break;
    }
  });

  await shot('03-midgame');

  await step('exercise camera, overlays and toggles', async () => {
    await page.evaluate(() => {
      const g = window.VOID_LANCE;
      g.toggleThreat();
      g.toggleView();
      g.toggleBloom();
      g.scene.cam.zoom(-4);
      g.scene.cam.orbit(120, 40);
      g.scene.cam.pan(30, -20);
      g.advanceSelection();
    });
    await new Promise((r) => setTimeout(r, 900));
  });

  await shot('04-overlays');

  await step('pointer sanity: hover a hull, click a hex', async () => {
    const box = await page.evaluate(() => {
      const g = window.VOID_LANCE;
      const ship = [...g.state.ships.values()].find((s) => s.team === 'enemy' && s.alive);
      if (!ship) return null;
      const p = g.scene.screenPos(g.scene.worldFor(ship, 0.4));
      return { x: p.x, y: p.y };
    });
    if (box) {
      await page.mouse.move(box.x, box.y);
      await new Promise((r) => setTimeout(r, 250));
      await page.mouse.click(box.x, box.y);
      await new Promise((r) => setTimeout(r, 350));
    }
    const ok = await page.evaluate(() => Boolean(window.VOID_LANCE.state));
    if (!ok) problems.push('pointer interaction dropped the game state');
  });

  await step('drive to a result screen', async () => {
    const result = await page.evaluate(async () => {
      const g = window.VOID_LANCE;
      let guard = 0;
      while (!g.state.over && guard++ < 14) await window.VL_SMOKE();
      await new Promise((r) => setTimeout(r, 2200));
      return {
        over: g.state.over ? g.state.over.result : null,
        rank: g.state.over ? g.state.over.rank : null,
        score: g.state.over ? g.state.over.score : null,
        screen: g.screens.which,
      };
    });
    console.log(`  • result=${result.over} rank=${result.rank} score=${result.score} screen=${result.screen}`);
    if (result.over && result.screen !== 'result') problems.push('battle ended but the after-action screen did not show');
  });

  await shot('05-result');

  await step('restart from the after-action report', async () => {
    const restarted = await page.evaluate(async () => {
      const btn = [...document.querySelectorAll('.vl-btn-primary')].find((b) => /new battle/i.test(b.textContent));
      if (!btn) return false;
      btn.click();
      await new Promise((r) => setTimeout(r, 900));
      const g = window.VOID_LANCE;
      return Boolean(g.state && g.state.round === 1 && !g.state.over && g.screens.which === null);
    });
    console.log(`  • restarted=${restarted}`);
    if (!restarted) problems.push('restart from the result screen did not begin a fresh battle');
  });

  await shot('06-restart');
} catch (err) {
  problems.push(`harness ${err && err.message ? err.message : String(err)}`);
  await shot('99-failure').catch(() => {});
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
  console.error('\nlast 40 console lines:');
  for (const l of logs.slice(-40)) console.error(`  ${l}`);
  process.exit(1);
}

console.log('\n✓ smoke clean — no console errors, no page errors, no failed requests.');
