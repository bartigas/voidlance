# VOID LANCE

Turn-based 2.5D space fleet battle — five ships against five, on a hex battlefield, built with
Three.js and WebGL. No bundler, no build step: the rules engine is plain ESM, the renderer is
Three.js with a small bloom composer, and all audio is synthesised at runtime with WebAudio.

## Running it

The page uses an import map, so it must be served over HTTP (opening `index.html` from the file
system will not load `three`).

```bash
npm install          # three + puppeteer-core (dev only)
npm run vendor       # copies three.module.js and the addons used into vendor/
npm run serve        # python3 http.server on port 4173
```

Then open <http://localhost:4173>. Requires a browser with WebGL 2.

## Verifying

```bash
npm test             # 59 node:test specs over the rules engine (src/core is DOM-free)
npm run smoke        # drives a full battle in headless Chrome/Brave, screenshots to .qwen/tmp/shots
```

`npm run smoke` needs a Chromium-family browser (`/usr/bin/brave-browser`,
`/usr/bin/google-chrome` or `/usr/bin/chromium`) and a running dev server. It asserts the briefing
renders, the HUD wires up, three rounds play, camera/overlay toggles work, a full battle reaches a
result screen, and `NEW BATTLE` resets cleanly.

## Controls

| Input | Action |
| --- | --- |
| Left drag | Orbit the camera |
| Middle / right drag | Pan |
| Wheel | Zoom |
| `W A S D` | Pan · `Q` / `E` roll · `+` / `-` (or `[` `]`) animation speed |
| Click a hull | Select it — move range lights up cyan |
| Click a cyan hex | Move there (costs thrust) |
| `R` | Rotate 60° toward the pointer — free, once per ship per turn |
| Click a weapon row | Enter targeting; enemy hexes show hit chance and average damage |
| Click an enemy | Fire. `Esc` aborts |
| `G` | Threat overlay (intensity-weighted hexes the enemy fleet actually covers) |
| `V` | Top-down tactical view |
| `Tab` | Next ship that still has orders |
| `Space` | End your phase |
| `M` / `B` | Mute audio / toggle bloom |

Everything is mouse-only playable; the keyboard is only a shortcut layer.

## Turn rules

Each ship acts once per phase: move up to its thrust, take **one** free 60° rotation, then exactly
**one** of Fire / System / Recharge. Player phase, then enemy phase, then a new round.

- **Firing arcs beat range.** Weapons are `fore`, `fore + broadside`, `broadside` or `full circle`,
  so heading decides what you can shoot — the free rotation is usually the real decision.
- **Aspect armour.** Incoming damage is reduced by armour scaled on the aspect it arrives: fore
  ×1.0, broadside ×⅔, stern ×⅓. Getting a shot onto an enemy's stern matters more than +10 accuracy.
- **Shields** regenerate at the start of your own phase. A shield collapse jams weapons for two
  turns; energy weapons burn shield capacity permanently.
- **Kinetic vs energy vs torpedo.** Kinetic is halved by shields but fine against hull; energy is
  ×1.5 against shields and ignores armour; torpedoes pierce half of whatever shield is left but are
  badly penalised at the ends of their range band.
- **Terrain.** Asteroids block movement and line of sight. Debris fields degrade accuracy for
  shooter and target alike (20% cover) and scrape 5 hull on entry.
- **Systems** (Aegis, Overdrive, Saturation, Fortify, Phase Shift) have two charges per battle.
  Recharge restores regen ×1.5 and ends the ship's action.
- **The drift gate** closes after 12 rounds; whatever is still flying is scored on fleet integrity.

## Squadron

| Class | Role | Hull | Shield | Armor | Thrust | Evade | Weapons | System |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bulwark | Dreadnought | 150 | 40 | 4 | 2 | 0 | Nova Battery (energy, broadside, 3–6) · Twin Cannon (kinetic, fore+broad, 2–5) | Fortify |
| Warden | Support Cruiser | 90 | 30 | 2 | 3 | 4 | Flak Salvo (kinetic, all, 1–3) · Pulse Lance (energy, all, 3–5) | Aegis Field |
| Tempest | Missile Frigate | 80 | 24 | 1 | 4 | 10 | Swarm Launchers ×4 (missile, all, 2–4) · Pulse Cannon (kinetic, fore+broad, 1–4) | Saturation Protocol |
| Lance | Destroyer | 70 | 20 | 1 | 5 | 8 | Lance Torpedo Rack (torpedo, fore+broad, 2–6) · Rail Spike (kinetic, fore, 1–3) | Overdrive |
| Revenant | ECM Corvette | 75 | 22 | 1 | 5 | 12 | Disruptor Beam (energy, fore, 2–4) · Torpedo (torpedo, broadside, 2–5) | Phase Shift |

The enemy fleet fields the same five classes on mirrored spawns. Three commanders (Cadet, Captain,
Fleet Admiral) change enemy accuracy and how much noise enters its target evaluation.

## Layout

```
index.html            import map for three + three/addons, canvas, HUD mount
src/main.js           input state machine, event playback, enemy phase animation
src/core/             rules only — DOM-free and unit-tested
  hex.js              pointy-top odd-r offset storage, cube maths for metrics and rounding
  data.js             map, ship/weapon/system tables, rule constants, difficulty mods
  state.js            game state, phase/round transitions, end conditions, scoring
  combat.js           targeting, hit chance, damage, shields, statuses, threat map
  paths.js            thrust-cost movement search, occupancy, teleports
  ai.js               enemy planning: position/firing solution search per ship
src/render/
  scene.js            renderer, lights, bloom composer, raycast picking, frame loop
  grid.js             hex prisms, hazard decals, the five overlay channels
  shipModel.js        procedural hull silhouettes, engine plumes, selection rings
  effects.js          tracers, missile pods, impact and blast rings, floaters
  background.js       starfield and nebula
  camera.js           oblique/top-down rigs, pan, orbit, framing
src/audio/audio.js    WebAudio synthesis: engine hum, guns, impacts, alarms, UI
src/ui/               HUD (roster, inspector, log, toasts) and full-screen briefing/report
scripts/              vendor-three.mjs (copies three into vendor/), smoke.mjs (headless driver)
tests/                node:test specs for hex, combat, state, ai
```

Overlay channels (`move`, `arc`, `aim`, `threat`, `hazard`) are one merged mesh each, painted as
hex-space glow plates with per-hex vertex alpha, so a range band never bleeds into a neighbouring
hex and the threat map can show how hard each hex is actually covered. `arc` is rim-weighted rather
than filled — a lit hex lattice stays readable on top of the red threat wash where a second
translucent fill would turn to mud.
