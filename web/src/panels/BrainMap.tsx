import { useEffect, useRef, useSyncExternalStore } from 'react';
import { store } from '../bridge/store';
import type { Telemetry, WelcomeMessage } from '../protocol';
import { PixelIcon } from './PixelIcon';
import { Awaiting, Panel, PlotKey, Stat, compact } from './shared';

/**
 * Stylised dorsal schematic of the fly central nervous system. Each region is shaded by the
 * mean firing rate of the superclasses that live there; the decoder's readout cells sit as
 * dots on the descending bundles and flash when they spike.
 *
 * Drawn on a 240 x 160 pixel grid scaled 2x on the canvas so edges stay hard.
 */

const GW = 160;
const GH = 124;
const S = 4;
const SPARKLE_MS = 90; // re-roll the firing pixels ~11x per second
const FLASH_MS = 150;
const RATE_FLOOR_HZ = 0.02;
const RATE_CEIL = 300;
const ALPHA_MIN = 0.08;
const LINE = '#333';
const ACCENT = '#555';

export type RegionKey = 'ol' | 'vp' | 'cb' | 'dn' | 'an' | 'vnc';
type Side = 'L' | 'R';
interface Acc {
  spikes: number;
  neurons: number;
}
interface RegionRates {
  L: number;
  R: number;
  all: number;
  neurons: number;
}
export type Rates = Record<RegionKey, RegionRates>;

/** Where a superclass is drawn. Peripheral / unplaced classes (sensory, ens, *_tbc) return null. */
export function regionOf(name: string): RegionKey | null {
  if (name === 'visual_projection' || name === 'vpn') return 'vp';
  if (name === 'visual_centrifugal') return 'cb';
  if (name.startsWith('ol_')) return 'ol';
  if (name.startsWith('cb_') || name === 'central_brain') return 'cb';
  if (name.startsWith('descending')) return 'dn';
  if (name.startsWith('ascending')) return 'an';
  if (name.startsWith('vnc_') || name === 'motor' || name.startsWith('efferent')) return 'vnc';
  return null;
}

const KEYS: RegionKey[] = ['ol', 'vp', 'cb', 'dn', 'an', 'vnc'];

/** Sum spikes and neurons per (region, side) over the telemetry window and turn them into Hz. */
export function aggregate(t: Telemetry | null): { rates: Rates; sided: boolean } | null {
  if (!t) return null;
  const windowS = Math.max(1e-3, t.window_ms / 1000);
  const acc = {} as Record<RegionKey, { L: Acc; R: Acc; all: Acc }>;
  for (const k of KEYS) acc[k] = { L: { spikes: 0, neurons: 0 }, R: { spikes: 0, neurons: 0 }, all: { spikes: 0, neurons: 0 } };
  const add = (a: Acc, spikes: number, neurons: number) => {
    a.spikes += spikes;
    a.neurons += neurons;
  };
  const sided = !!t.regions?.length;
  if (t.regions?.length) {
    for (const r of t.regions) {
      const k = regionOf(r.name);
      if (!k) continue;
      add(acc[k].all, r.spikes, r.neurons);
      if (r.side === 'L') add(acc[k].L, r.spikes, r.neurons);
      else if (r.side === 'R') add(acc[k].R, r.spikes, r.neurons);
      else {
        // Midline / unknown side: contributes to both hemispheres.
        add(acc[k].L, r.spikes, r.neurons);
        add(acc[k].R, r.spikes, r.neurons);
      }
    }
  } else {
    for (const p of t.populations) {
      const k = regionOf(p.name);
      if (!k) continue;
      add(acc[k].all, p.spikes, p.neurons);
      add(acc[k].L, p.spikes, p.neurons);
      add(acc[k].R, p.spikes, p.neurons);
    }
  }
  const hz = (a: Acc) => (a.neurons > 0 ? a.spikes / a.neurons / windowS : 0);
  const rates = {} as Rates;
  for (const k of KEYS) rates[k] = { L: hz(acc[k].L), R: hz(acc[k].R), all: hz(acc[k].all), neurons: acc[k].all.neurons };
  return { rates, sided };
}

/** Soft log brightness: 0.02 Hz is barely lit, ~3 Hz is bright, 300 Hz saturates. */
export function alphaOf(rateHz: number) {
  const a = Math.log1p(Math.max(0, rateHz) / RATE_FLOOR_HZ) / Math.log1p(RATE_CEIL);
  return Math.min(1, Math.max(ALPHA_MIN, a));
}


// ---- pixel geometry (grid units; anterior at the top, fly's left on the viewer's left) ----

type Cells = (x: number, y: number) => void;

function ellipseCells(cx: number, cy: number, rx: number, ry: number, put: Cells) {
  for (let dy = -ry; dy <= ry; dy++) {
    const hw = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / (ry + 0.5)) ** 2)));
    for (let x = cx - hw; x <= cx + hw; x++) put(x, cy + dy);
  }
}
function rectCells(x: number, y: number, w: number, h: number, put: Cells) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) put(i, j);
}

/** Region ids stored in the mask; 0 = background. */
const R = { olL: 1, olR: 2, vpL: 3, vpR: 4, cb: 5, dnL: 6, dnR: 7, vnc: 8, anL: 9, anR: 10, sez: 11 } as const;
type RegionId = (typeof R)[keyof typeof R];

const MID = 80;
const OL = { L: 30, R: 130, cy: 44, rx: 22, ry: 26 };
const LOB = { rx: 6, ry: 11, offset: 12 }; // lobula: medial part of each optic lobe
const CB = { cx: MID, cy: 46, rx: 29, ry: 23 };
const AL = { dx: 11, cy: 30, r: 5 };
const MB = { dx: 17, calyxY: 58, r: 4, lobeY: 40 };
const CX = { cy: 47, r: 4 };
const SEZ = { cy: 74, rx: 11, ry: 5 };
const NECK = { top: 80, bottom: 89 };
const DN = { L: 75, R: 83, w: 3 };
const AN = { L: 71, R: 88 };
const DOT_Y = { move: 82, fire: 86 };
const VNC = [
  { cy: 95, rx: 15, ry: 5 },
  { cy: 104, rx: 18, ry: 6 },
  { cy: 112, rx: 13, ry: 4 },
];
const ABD = { cy: 118, rx: 5, ry: 3 };

/** One-time raster of every region into an id mask + per-region cell lists (for sparkles). */
const MASK = new Uint8Array(GW * GH);
const CELLS: Record<number, number[]> = {};
{
  const put = (id: RegionId): Cells => (x, y) => {
    if (x < 0 || y < 0 || x >= GW || y >= GH) return;
    MASK[y * GW + x] = id;
  };
  ellipseCells(OL.L, OL.cy, OL.rx, OL.ry, put(R.olL));
  ellipseCells(OL.R, OL.cy, OL.rx, OL.ry, put(R.olR));
  ellipseCells(OL.L + LOB.offset, OL.cy, LOB.rx, LOB.ry, put(R.vpL));
  ellipseCells(OL.R - LOB.offset, OL.cy, LOB.rx, LOB.ry, put(R.vpR));
  ellipseCells(CB.cx, CB.cy, CB.rx, CB.ry, put(R.cb));
  ellipseCells(MID, SEZ.cy, SEZ.rx, SEZ.ry, put(R.sez));
  rectCells(DN.L, NECK.top, DN.w, NECK.bottom - NECK.top, put(R.dnL));
  rectCells(DN.R, NECK.top, DN.w, NECK.bottom - NECK.top, put(R.dnR));
  rectCells(AN.L, NECK.top, 1, NECK.bottom - NECK.top, put(R.anL));
  rectCells(AN.R, NECK.top, 1, NECK.bottom - NECK.top, put(R.anR));
  for (const seg of VNC) ellipseCells(MID, seg.cy, seg.rx, seg.ry, put(R.vnc));
  ellipseCells(MID, ABD.cy, ABD.rx, ABD.ry, put(R.vnc));
  for (let i = 0; i < MASK.length; i++) if (MASK[i]) (CELLS[MASK[i]] ??= []).push(i);
}

const grey = (alpha: number) => {
  const s = Math.round(255 * Math.min(1, Math.max(0, alpha)));
  return `rgb(${s},${s},${s})`;
};

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}
function ellipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string) {
  ctx.fillStyle = color;
  for (let dy = -ry; dy <= ry; dy++) {
    const hw = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / (ry + 0.5)) ** 2)));
    ctx.fillRect(cx - hw, cy + dy, hw * 2 + 1, 1);
  }
}
/** Region body: dark interior that warms with activity, 1-cell outline that brightens with it. */
function organ(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, a: number) {
  ellipse(ctx, cx, cy, rx + 1, ry + 1, grey(0.22 + 0.78 * a));
  ellipse(ctx, cx, cy, rx, ry, grey(0.05 + 0.38 * a));
}
function ring(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string, inner: string) {
  ellipse(ctx, cx, cy, rx, ry, color);
  ellipse(ctx, cx, cy, rx - 1, ry - 1, inner);
}

interface Dot {
  id: string;
  side: Side;
  kind: 'move' | 'fire';
}

interface Sparkles {
  at: number;
  cells: number[];
}

/** How many cells to light for a region's spikes in this window: sublinear so the optic lobe doesn't white out. */
function sparkleCount(spikes: number, available: number) {
  if (spikes <= 0) return 0;
  return Math.min(Math.floor(available * 0.45), Math.max(1, Math.ceil(Math.pow(spikes, 0.62) / 2)));
}

function rollSparkles(spikesByRegion: Partial<Record<RegionId, number>>): number[] {
  const out: number[] = [];
  for (const key of Object.keys(spikesByRegion)) {
    const id = Number(key) as RegionId;
    const cells = CELLS[id];
    if (!cells) continue;
    const n = sparkleCount(spikesByRegion[id] ?? 0, cells.length);
    for (let i = 0; i < n; i++) out.push(cells[(Math.random() * cells.length) | 0]);
  }
  return out;
}

function draw(
  ctx: CanvasRenderingContext2D,
  rates: Rates | null,
  sparkles: number[],
  dots: Dot[],
  flashUntil: Map<string, number>,
  now: number,
) {
  ctx.setTransform(S, 0, 0, S, 0, 0);
  px(ctx, 0, 0, GW, GH, '#000');
  const a = (k: RegionKey, side: Side | 'all') => (rates ? alphaOf(rates[k][side]) : ALPHA_MIN);

  // Faint midline + a dotted "specimen" frame so the schematic reads as a slide, not a logo.
  for (let y = 4; y < GH - 4; y += 3) px(ctx, MID, y, 1, 1, '#161616');

  // Optic lobes: lamina rim, medulla body, lobula (visual projection output) on the medial side.
  for (const side of ['L', 'R'] as Side[]) {
    const cx = OL[side];
    const ol = a('ol', side);
    organ(ctx, cx, OL.cy, OL.rx, OL.ry, ol);
    ring(ctx, cx, OL.cy, OL.rx - 3, OL.ry - 3, grey(0.12 + 0.5 * ol), grey(0.05 + 0.38 * ol)); // lamina/medulla boundary
    const lob = cx + (side === 'L' ? LOB.offset : -LOB.offset);
    organ(ctx, lob, OL.cy, LOB.rx, LOB.ry, a('vp', side));
    // Visual projection fibres: lobula -> central brain.
    const c = grey(0.15 + 0.85 * a('vp', side));
    const x0 = side === 'L' ? lob + LOB.rx + 1 : CB.cx + CB.rx + 1;
    const x1 = side === 'L' ? CB.cx - CB.rx - 1 : lob - LOB.rx - 1;
    for (const y of [OL.cy - 8, OL.cy - 3, OL.cy + 2, OL.cy + 7]) px(ctx, x0, y, x1 - x0 + 1, 1, c);
  }

  // Central brain with its landmarks: antennal lobes, mushroom bodies, central complex.
  const cb = a('cb', 'all');
  organ(ctx, CB.cx, CB.cy, CB.rx, CB.ry, cb);
  const accent = grey(0.3 + 0.7 * cb);
  const hollow = grey(0.02 + 0.2 * cb);
  for (const side of ['L', 'R'] as Side[]) {
    const sgn = side === 'L' ? -1 : 1;
    ring(ctx, MID + sgn * AL.dx, AL.cy, AL.r, AL.r, accent, hollow);
    const cx = MID + sgn * MB.dx;
    ring(ctx, cx, MB.calyxY, MB.r, MB.r, accent, hollow); // calyx
    px(ctx, cx, MB.lobeY, 1, MB.calyxY - MB.r - MB.lobeY, accent); // peduncle
    px(ctx, side === 'L' ? cx : MID + 4, MB.lobeY, side === 'L' ? MID - 4 - cx + 1 : cx - (MID + 4) + 1, 1, accent); // medial lobe
    px(ctx, cx - 1, MB.lobeY - 4, 3, 4, accent); // vertical lobe
  }
  ring(ctx, MID, CX.cy, CX.r, CX.r, accent, hollow); // ellipsoid body
  px(ctx, MID - 7, CX.cy - 7, 15, 1, accent); // fan-shaped body
  px(ctx, MID - 9, CX.cy + 8, 19, 1, accent); // protocerebral bridge

  // Subesophageal zone and the neck connective.
  organ(ctx, MID, SEZ.cy, SEZ.rx, SEZ.ry, cb);
  px(ctx, MID - 4, CB.cy + CB.ry, 9, SEZ.cy - SEZ.ry - (CB.cy + CB.ry), grey(0.05 + 0.38 * cb));
  for (const side of ['L', 'R'] as Side[]) {
    px(ctx, AN[side], NECK.top, 1, NECK.bottom - NECK.top, grey(0.12 + 0.7 * a('an', side)));
    px(ctx, DN[side] - 1, NECK.top - 1, DN.w + 2, NECK.bottom - NECK.top + 2, grey(0.22 + 0.78 * a('dn', side)));
    px(ctx, DN[side], NECK.top, DN.w, NECK.bottom - NECK.top, grey(0.05 + 0.5 * a('dn', side)));
  }

  // Ventral nerve cord: three thoracic neuromeres, leg nerves, abdominal ganglion.
  const vnc = a('vnc', 'all');
  px(ctx, MID - 2, NECK.bottom, 5, VNC[0].cy - VNC[0].ry - NECK.bottom, grey(0.05 + 0.38 * vnc));
  for (const seg of VNC) organ(ctx, MID, seg.cy, seg.rx, seg.ry, vnc);
  for (const seg of VNC) {
    px(ctx, MID - seg.rx - 7, seg.cy, 6, 1, grey(0.2 + 0.5 * vnc));
    px(ctx, MID + seg.rx + 2, seg.cy, 6, 1, grey(0.2 + 0.5 * vnc));
  }
  px(ctx, MID - 1, VNC[2].cy + VNC[2].ry, 3, ABD.cy - ABD.ry - (VNC[2].cy + VNC[2].ry), grey(0.05 + 0.38 * vnc));
  organ(ctx, MID, ABD.cy, ABD.rx, ABD.ry, vnc);

  // Firing pixels: each lit cell is a spike-weighted sample of that region's activity this window.
  ctx.fillStyle = '#fff';
  for (const i of sparkles) ctx.fillRect(i % GW, (i / GW) | 0, 1, 1);

  // Decoder readout cells on the descending bundles.
  for (const d of dots) {
    const cx = DN[d.side] + 1;
    const cy = DOT_Y[d.kind];
    const lit = (flashUntil.get(d.id) ?? 0) > now;
    if (lit) px(ctx, cx - 3, cy - 3, 7, 7, '#fff');
    px(ctx, cx - 2, cy - 2, 5, 5, '#000');
    px(ctx, cx - 1, cy - 1, 3, 3, lit ? '#fff' : '#8a8a8a');
  }
}

function decoderCells(welcome: WelcomeMessage): { move: string; fire: string } {
  return welcome.decoder === 'biological' ? { move: 'DNa02', fire: 'MN9' } : { move: 'DNp20', fire: 'DNpe017' };
}

/** Spikes per region for the sparkle roll (uses regions when sided, else populations). */
function spikesByRegion(t: Telemetry | null): Partial<Record<RegionId, number>> {
  const out: Partial<Record<RegionId, number>> = {};
  if (!t) return out;
  const add = (id: RegionId, n: number) => (out[id] = (out[id] ?? 0) + n);
  const place = (name: string, side: string, spikes: number) => {
    const k = regionOf(name);
    if (!k || !spikes) return;
    const L = side === 'L', both = side !== 'L' && side !== 'R';
    if (k === 'ol') { if (L || both) add(R.olL, both ? spikes / 2 : spikes); if (!L || both) add(R.olR, both ? spikes / 2 : spikes); }
    else if (k === 'vp') { if (L || both) add(R.vpL, both ? spikes / 2 : spikes); if (!L || both) add(R.vpR, both ? spikes / 2 : spikes); }
    else if (k === 'dn') { if (L || both) add(R.dnL, both ? spikes / 2 : spikes); if (!L || both) add(R.dnR, both ? spikes / 2 : spikes); }
    else if (k === 'an') { if (L || both) add(R.anL, both ? spikes / 2 : spikes); if (!L || both) add(R.anR, both ? spikes / 2 : spikes); }
    else if (k === 'cb') { add(R.cb, spikes * 0.85); add(R.sez, spikes * 0.15); }
    else add(R.vnc, spikes);
  };
  if (t.regions?.length) for (const r of t.regions) place(r.name, r.side, r.spikes);
  else for (const p of t.populations) place(p.name, '?', p.spikes);
  return out;
}

const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(1)}%`;
const hz = (x: number) => (x >= 10 ? x.toFixed(1) : x.toFixed(2));

const selectWelcome = () => store.get().welcome;
const selectTelemetry = () => store.get().telemetry;
const selectNull = () => null;

/** Which brain regions light up, live. */
export function BrainMap() {
  const welcome = useSyncExternalStore(store.subscribe, selectWelcome, selectNull);
  const telemetry = useSyncExternalStore(store.subscribe, selectTelemetry, selectNull);
  const ref = useRef<HTMLCanvasElement>(null);
  const agg = aggregate(telemetry);
  const cells = welcome ? decoderCells(welcome) : null;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !welcome) return;
    const { move, fire } = decoderCells(welcome);
    const dots: Dot[] = [];
    for (const r of welcome.readouts) {
      if (r.side !== 'L' && r.side !== 'R') continue;
      if (r.type === move) dots.push({ id: r.id, side: r.side, kind: 'move' });
      else if (r.type === fire) dots.push({ id: r.id, side: r.side, kind: 'fire' });
    }
    const dotIds = new Set(dots.map((d) => d.id));
    const flashUntil = new Map<string, number>();
    let lastAction = store.get().lastAction;
    let lastTelemetry: Telemetry | null = null;
    let rates: Rates | null = null;
    let spikes: Partial<Record<RegionId, number>> = {};
    const sparkles: Sparkles = { at: 0, cells: [] };
    let raf = 0;
    let disposed = false;

    const paint = (now: number) => {
      raf = 0;
      if (disposed) return;
      const t = store.get().telemetry;
      if (t !== lastTelemetry) {
        lastTelemetry = t;
        rates = aggregate(t)?.rates ?? null;
        spikes = spikesByRegion(t);
      }
      if (now - sparkles.at > SPARKLE_MS) {
        sparkles.at = now;
        sparkles.cells = rollSparkles(spikes);
      }
      draw(ctx, rates, sparkles.cells, dots, flashUntil, now);
      // Keep animating while there is anything alive to show.
      const fresh = t && Date.now() - t.generated_at_ms < 3000;
      let flashing = false;
      for (const until of flashUntil.values()) if (until > now) flashing = true;
      if (fresh || flashing) raf = requestAnimationFrame(paint);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const unsubscribe = store.subscribe(() => {
      const a = store.get().lastAction;
      if (a && a !== lastAction) {
        lastAction = a;
        const now = performance.now();
        for (const r of a.readouts) if (r.spikes > 0 && dotIds.has(r.id)) flashUntil.set(r.id, now + FLASH_MS);
      }
      schedule();
    });
    schedule();
    return () => {
      disposed = true;
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [welcome]);

  const dataset = welcome?.manifest.dataset ?? 'connectome';
  const rates = agg?.rates;
  const label = (text: string, x: number, y: number, cls = '') => (
    <span key={`${text}@${x},${y}`} className={`map-label ${cls}`} style={{ left: pct(x, GW), top: pct(y, GH) }}>
      {text}
    </span>
  );

  return (
    <Panel title="02 / BRAIN MAP" icon={<PixelIcon name="brain" />} caption={`${dataset} · dorsal view`} className="panel-map">
      {welcome ? (
        <>
          <div className="brain-map">
            <canvas
              ref={ref}
              width={GW * S}
              height={GH * S}
              aria-label="Schematic fly nervous system; regions brighten and sparkle with firing"
            />
            {label('optic lobe · L', OL.L, 8, 'center')}
            {label('central brain', MID, 3, 'center')}
            {label('optic lobe · R', OL.R, 8, 'center')}
            {label('lobula', OL.L + LOB.offset, OL.cy + OL.ry + 4, 'center')}
            {label('lobula', OL.R - LOB.offset, OL.cy + OL.ry + 4, 'center')}
            {label('al', MID, AL.cy - 1, 'center middle')}
            {label('mb', MID - MB.dx - 8, MB.calyxY, 'right middle')}
            {label('cx', MID + CX.r + 3, CX.cy, 'middle')}
            {label('sez', MID + SEZ.rx + 3, SEZ.cy, 'middle')}
            {label(`${cells?.move} ◂ move`, AN.L - 3, DOT_Y.move, 'right middle')}
            {label(`fire ▸ ${cells?.fire}`, AN.R + 4, DOT_Y.fire, 'middle')}
            {label('vnc', MID - VNC[1].rx - 10, VNC[1].cy, 'right middle')}
            {VNC.map((seg, i) => label(`t${i + 1}`, MID + seg.rx + 9, seg.cy, 'middle'))}
            {label('abd', MID + ABD.rx + 3, ABD.cy, 'middle')}
          </div>
          <div className="map-readouts">
            <Stat label="optic lobe L" value={rates ? hz(rates.ol.L) : '—'} unit="Hz" sub={rates ? `lobula ${hz(rates.vp.L)} Hz` : 'awaiting'} />
            <Stat label="central brain" value={rates ? hz(rates.cb.all) : '—'} unit="Hz" sub={rates ? `${compact(rates.cb.neurons)} cells` : 'awaiting'} />
            <Stat label="optic lobe R" value={rates ? hz(rates.ol.R) : '—'} unit="Hz" sub={rates ? `lobula ${hz(rates.vp.R)} Hz` : 'awaiting'} />
            <Stat label="descending L" value={rates ? hz(rates.dn.L) : '—'} unit="Hz" sub={rates ? `asc ${hz(rates.an.L)} Hz` : 'awaiting'} />
            <Stat label="vnc" value={rates ? hz(rates.vnc.all) : '—'} unit="Hz" sub={rates ? `${compact(rates.vnc.neurons)} cells` : 'awaiting'} />
            <Stat label="descending R" value={rates ? hz(rates.dn.R) : '—'} unit="Hz" sub={rates ? `asc ${hz(rates.an.R)} Hz` : 'awaiting'} />
          </div>
          <PlotKey>
            <span>
              {[ALPHA_MIN, 0.3, 0.55, 0.8, 1].map((v) => (
                <i key={v} className="swatch" style={{ background: grey(0.22 + 0.78 * v), borderColor: LINE }} />
              ))}
              outline = mean spk/s per cell (log) · white pixels = spikes this window
            </span>
            <span>{agg ? (agg.sided ? 'L/R split' : 'no L/R split') : 'awaiting telemetry'}</span>
          </PlotKey>
        </>
      ) : (
        <Awaiting minHeight={240} />
      )}
    </Panel>
  );
}
