/**
 * Dev helper: with `?mock=1` in the URL, feed the store a plausible synthetic brain so the
 * dashboard can be viewed without the Python server. Returns a cleanup function.
 */
import { store } from '../bridge/store';
import type { ActionMessage, Readout, RegionActivity, RoundSummary, Telemetry, TimelineEntry, WelcomeMessage } from '../protocol';

const FPS = 60;
const ACTION_HZ = 30; // per-tick actions (the real bridge runs at game rate)
const TELEMETRY_EVERY = 4; // -> 7.5 Hz telemetry
const POPS = ['ol_intrinsic', 'visual_projection', 'cb_intrinsic', 'descending_neuron', 'ascending_neuron', 'vnc_intrinsic', 'vnc_motor'];
const POP_SIZE = [58000, 6000, 62000, 1400, 1900, 30000, 1200];
const POP_RATE = [12, 6, 1.2, 0.8, 0.5, 0.9, 0.4];
// How strongly each population follows the eye that sees the bright blob (1 = fully lateral).
const POP_LATERAL = [0.9, 0.8, 0.25, 0, 0.1, 0.1, 0.1];
const EYE_X = { L: 0.36, R: 0.64 }; // retina UV centres in makeRetina
const CENTERING_TAU_S = 3;
const WIRING_BIAS = 0.18; // constant left/right offset the adaptive centering removes
const RASTER_ROWS = 128;

let seed = 41027;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function makeRetina(): WelcomeMessage['retina'] {
  const uv: [number, number][] = [];
  const side: string[] = [];
  const ids: string[] = [];
  const eyes: [number, string][] = [[0.36, 'L'], [0.64, 'R']];
  for (const [cx, s] of eyes) {
    let n = 0;
    while (n < 209) {
      const x = rand() * 2 - 1;
      const y = rand() * 2 - 1;
      if (x * x + y * y > 1) continue;
      uv.push([cx + x * 0.3, 0.5 + y * 0.42]);
      side.push(s);
      ids.push(String(720000000000 + uv.length));
      n++;
    }
  }
  return { uv, side, neuron_ids: ids, full_sample_count: 3335, display_stride: 8 };
}

function makeWelcome(): WelcomeMessage {
  const types: [string, string][] = [['DNp20', 'L'], ['DNp20', 'R'], ['DNpe017', 'L'], ['DNpe017', 'R'], ['DNa02', 'L'], ['DNa02', 'R'], ['MN9', 'L'], ['MN9', 'R']];
  return {
    type: 'welcome',
    protocol: 1,
    run_id: 'mock-9f3a2c1d-0000-4000-8000-000000000000',
    decoder: 'bci',
    phase: 'baseline',
    manifest: { neurons: 166700, edges: 25582938, synaptic_contacts: 124177617, retina_mapped: 3335, retina_total: 3377, retina_unmapped: 42, uncertain_sign_neurons: 3718, dataset: 'malecns_v1', synthetic: true },
    readouts: types.map(([type, side], index) => ({ index, id: String(880000000000 + index), type, side })),
    retina: makeRetina(),
    raster_ids: Array.from({ length: RASTER_ROWS }, (_, i) => String(900000000000 + i)),
    raster_groups: Array.from({ length: RASTER_ROWS }, (_, i) => POPS[Math.floor((i * POPS.length) / RASTER_ROWS)]),
    populations: POPS,
    protocol_info: { dt_ms: 0.1, lamina_bias_mv: 12, retinal_gain_mv: 30, photoreceptor_half_saturation: 0.02, seed: 41027, model: 'lif-r2-refractory-write-protection' },
  };
}

export function installMockBrain(): () => void {
  const welcome = makeWelcome();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let interval: ReturnType<typeof setInterval> | null = null;
  const t0 = performance.now();

  // A real brain that connected before us owns the store; the mock stands down entirely.
  const realBrain = () => {
    const w = store.get().welcome;
    return !!w && w.run_id !== welcome.run_id;
  };

  store.setConnection('open');
  store.onStatus({ type: 'status', status: 'loading', message: 'loading graph', progress: 0 });
  for (let i = 1; i <= 5; i++) {
    timers.push(setTimeout(() => {
      if (!realBrain()) store.onStatus({ type: 'status', status: 'loading', message: i < 4 ? 'loading graph' : 'building retina', progress: i / 5 });
    }, i * 250));
  }
  timers.push(setTimeout(() => {
    if (realBrain()) return;
    store.onStatus({ type: 'status', status: 'ready', message: 'ready' });
    store.onWelcome(welcome);
  }, 1500));

  let tick = 0;
  let sequence = 0;
  let totalSpikes = 0;
  let score = 0;
  let lives = 3;
  let aliens = 55;
  let round = 1;
  let roundTick = 0;
  const episodes: RoundSummary[] = [];
  const timeline: TimelineEntry[] = [];
  const rates = welcome.readouts.map(() => 0);
  const filtered = welcome.retina.uv.map(() => 0);
  let moveBias = WIRING_BIAS;

  const step = () => {
    // A real brain took over the store (same page, server online): stop feeding.
    const current = store.get().welcome;
    if (current && current.run_id !== welcome.run_id) {
      if (interval) clearInterval(interval);
      interval = null;
      return;
    }
    tick++;
    roundTick++;
    if (store.get().connection !== 'open') store.setConnection('open');
    if (tick === 2) store.onStatus({ type: 'status', status: 'running', message: 'running' });
    const neuralS = tick / FPS;
    // Readouts: DNp20 R/L oscillate against each other; DNpe017 spikes occasionally.
    const drive = Math.sin(neuralS * 0.9) * 20;
    const readouts: Readout[] = welcome.readouts.map((r, i) => {
      const base = r.type === 'DNp20' ? 25 + (r.side === 'R' ? drive : -drive) : r.type === 'DNpe017' ? 4 : 0.5;
      const p = base / FPS;
      const spikes = rand() < p ? 1 : 0;
      rates[i] += (spikes * FPS - rates[i]) * (1 / (0.1 * FPS));
      return { ...r, spikes, rate_hz: Math.max(0, rates[i]) };
    });
    const rate = (type: string, side: string) => readouts.find((r) => r.type === type && r.side === side)?.rate_hz ?? 0;
    const moveRaw = (rate('DNp20', 'R') - rate('DNp20', 'L')) * 0.02 + WIRING_BIAS;
    moveBias += (moveRaw - moveBias) * (1 / (CENTERING_TAU_S * ACTION_HZ));
    const move = Math.max(-1, Math.min(1, moveRaw - moveBias));
    const fire = readouts.some((r) => r.type === 'DNpe017' && r.spikes > 0);
    if (fire && rand() < 0.35) { score += 10; aliens = Math.max(0, aliens - 1); }
    if (rand() < 0.002) lives--;
    const spikesThisTick = Math.round(800 + 300 * Math.sin(neuralS * 2) + rand() * 200);
    totalSpikes += spikesThisTick;
    timeline.push({ tick, spikes: spikesThisTick, move, fire });
    if (timeline.length > 50) timeline.shift();
    let ended: RoundSummary | undefined;
    if (lives <= 0 || aliens === 0) {
      ended = { round, ticks: roundTick, score, lives: Math.max(0, lives) };
      episodes.push(ended);
      round++; roundTick = 0; score = 0; lives = 3; aliens = 55;
    }

    let telemetry: Telemetry | null = null;
    if (tick % TELEMETRY_EVERY === 0) {
      sequence++;
      const windowMs = (TELEMETRY_EVERY / FPS) * 1000;
      // Retina: a bright blob sweeping across plus a dim alien row.
      const bx = 0.5 + 0.35 * Math.sin(neuralS * 0.7);
      const by = 0.55 + 0.15 * Math.cos(neuralS * 0.4);
      const luminance = welcome.retina.uv.map(([x, y]) => {
        const d = (x - bx) ** 2 + (y - by) ** 2;
        const alienRow = Math.abs(y - 0.3) < 0.03 && Math.floor(x * 12) % 2 === 0 ? 0.25 : 0;
        return Math.min(1, 0.02 + 0.95 * Math.exp(-d / 0.012) + alienRow);
      });
      luminance.forEach((l, i) => { filtered[i] += (l - filtered[i]) * 0.6; });
      const driveMv = filtered.map((f) => (30 * f) / (f + 0.02));
      const spikesLast = driveMv.map((d) => (rand() < d / 60 ? 1 : 0));
      const counts = Array.from({ length: RASTER_ROWS }, (_, r) => {
        const g = Math.floor((r * POPS.length) / RASTER_ROWS);
        const hz = POP_RATE[g] * (0.4 + 1.6 * rand()) * (g === 0 ? 0.7 + 0.6 * Math.sin(neuralS * 3 + r) : 1);
        return Math.max(0, Math.round((hz * windowMs) / 1000 + (rand() - 0.5)));
      });
      // Hemispheres: the eye nearer the blob drives its optic lobe harder; descending L/R follow the DNp20 drive.
      const eyeGain = (side: 'L' | 'R') => Math.exp(-((bx - EYE_X[side]) ** 2) / 0.05);
      const dnGain = { L: 1 - 0.6 * Math.tanh(drive / 20), R: 1 + 0.6 * Math.tanh(drive / 20) };
      const regions: RegionActivity[] = [];
      const populations = POPS.map((name, g) => {
        const mean = POP_RATE[g] * (0.8 + 0.4 * Math.sin(neuralS * 1.3 + g));
        let spikes = 0;
        for (const side of ['L', 'R'] as const) {
          const lateral = name === 'descending_neuron' ? dnGain[side] : 1 - POP_LATERAL[g] + 2 * POP_LATERAL[g] * eyeGain(side);
          const neurons = POP_SIZE[g] / 2;
          const n = Math.round((mean * lateral * neurons * windowMs) / 1000);
          spikes += n;
          regions.push({ name, side, neurons, spikes: n, mean_rate_hz: n / neurons / (windowMs / 1000) });
        }
        return { name, neurons: POP_SIZE[g], spikes, mean_rate_hz: spikes / POP_SIZE[g] / (windowMs / 1000) };
      });
      const wall = (performance.now() - t0) / 1000;
      telemetry = {
        sequence,
        generated_at_ms: Date.now(),
        clocks: { wall_seconds: wall, neural_seconds: neuralS, game_seconds: neuralS, speed: neuralS / Math.max(0.001, wall), brain_step_ms: 33 + rand() * 6 },
        game: { round, tick: roundTick, score, lives, aliens, finished: false, ship_x: 0.5 + move * 0.3 },
        episodes: [...episodes],
        action: { move, fire },
        readouts,
        total_spikes: totalSpikes,
        window_spikes: populations.reduce((n, p) => n + p.spikes, 0),
        window_ms: windowMs,
        total_action_ticks: tick,
        populations,
        regions,
        retina: { luminance, filtered_luminance: [...filtered], drive_mv: driveMv, spikes_last_step: spikesLast },
        raster_bin: { neural_ms: neuralS * 1000, window_ms: windowMs, counts, population_spikes: counts.reduce((a, b) => a + b, 0) },
        timeline: [...timeline],
        neuron_voltage_mv: Object.fromEntries(readouts.map((r) => [r.id, -52 + (rand() - 0.5) * 8 + (r.spikes ? 20 : 0)])),
        reward: { mode: 'off', sugar_pulses: 0, active: false, plasticity: false },
      };
    }
    const action: ActionMessage = { type: 'action', tick, move, fire, move_raw: moveRaw, move_bias: moveBias, neural_ms: neuralS * 1000, steps: Math.round(10000 / FPS), readouts, telemetry };
    store.onAction(action);
  };

  timers.push(setTimeout(() => { if (!realBrain()) interval = setInterval(step, 1000 / ACTION_HZ); }, 1600));

  return () => {
    for (const t of timers) clearTimeout(t);
    if (interval) clearInterval(interval);
    store.reset();
  };
}
