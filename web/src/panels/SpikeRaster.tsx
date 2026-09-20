import { useEffect, useRef } from 'react';
import { RASTER_HISTORY, useBrain } from '../bridge/store';
import { PixelIcon } from './PixelIcon';
import { Awaiting, Panel, PlotKey, num, populationLabel } from './shared';

const W = 640;
const ROW = 2;
const SPARK_H = 40;
const MAX_HZ = 200;

/** Binned spike raster of the fixed display neurons plus a population sparkline. */
export function SpikeRaster() {
  const { welcome, rasterBins } = useBrain();
  const rasterRef = useRef<HTMLCanvasElement>(null);
  const sparkRef = useRef<HTMLCanvasElement>(null);
  const rows = welcome?.raster_ids.length ?? 0;
  // Contiguous runs of raster_groups -> [{name, rows}] (falls back to an even split).
  const runs = groupRuns(welcome?.raster_groups, welcome?.populations ?? [], rows);
  const H = Math.max(96, rows * ROW);
  const slotW = W / RASTER_HISTORY;

  useEffect(() => {
    const canvas = rasterRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // Group separators at population boundaries.
    if (runs.length > 1) {
      ctx.fillStyle = '#333';
      let y = 0;
      for (let g = 0; g < runs.length - 1; g++) {
        y += runs[g].rows;
        ctx.fillRect(0, y * ROW, W, 1);
      }
    }
    const offset = RASTER_HISTORY - rasterBins.length;
    for (let b = 0; b < rasterBins.length; b++) {
      const bin = rasterBins[b];
      const x = Math.floor((offset + b) * slotW);
      const w = Math.max(1, Math.ceil(slotW));
      const seconds = Math.max(1e-3, bin.window_ms / 1000);
      const counts = bin.counts;
      for (let r = 0; r < counts.length; r++) {
        const n = counts[r];
        if (!n) continue;
        const a = Math.min(1, n / seconds / MAX_HZ);
        ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.75 * a).toFixed(3)})`;
        ctx.fillRect(x, r * ROW, w, ROW);
      }
    }
  }, [rasterBins, rows, runs, H, slotW]);

  useEffect(() => {
    const canvas = sparkRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, SPARK_H);
    let max = 1;
    for (const bin of rasterBins) if (bin.population_spikes > max) max = bin.population_spikes;
    const offset = RASTER_HISTORY - rasterBins.length;
    ctx.fillStyle = '#fff';
    for (let b = 0; b < rasterBins.length; b++) {
      const h = Math.max(1, Math.round((rasterBins[b].population_spikes / max) * (SPARK_H - 2)));
      ctx.fillRect(Math.floor((offset + b) * slotW), SPARK_H - h, Math.max(1, Math.ceil(slotW)), h);
    }
  }, [rasterBins, slotW]);

  const first = rasterBins[0];
  const last = rasterBins[rasterBins.length - 1];
  const seconds = first && last ? (last.neural_ms - first.neural_ms + first.window_ms) / 1000 : 0;
  const caption = last ? `${num(last.population_spikes)} spikes / ${last.window_ms.toFixed(0)} ms` : 'awaiting spikes';

  return (
    <Panel title="07 / NEURAL ACTIVITY" icon={<PixelIcon name="signal" />} caption={caption} className="panel-raster">
      {welcome ? (
        <>
          <div className="raster-wrap">
            <div className="raster-groups" style={{ height: H }}>
              {runs.map((g) => (
                <span key={g.name} title={`${g.name} (${g.rows})`} style={{ flex: g.rows }}>
                  {populationLabel(g.name)}
                </span>
              ))}
            </div>
            <canvas
              ref={rasterRef}
              width={W}
              height={H}
              className="raster"
              aria-label="Binned firing of the fixed sample neurons; brighter is more spikes"
            />
          </div>
          <PlotKey>
            <span>{rows} sampled cells · optic lobe → descending</span>
            <span>{seconds.toFixed(2)} s brain time →</span>
            <span>0–{MAX_HZ} Hz</span>
          </PlotKey>
          <canvas ref={sparkRef} width={W} height={SPARK_H} className="sparkline" aria-label="Population spikes per bin" />
          <PlotKey>
            <span>population spikes per bin</span>
            <span>{rasterBins.length} / {RASTER_HISTORY} bins</span>
          </PlotKey>
        </>
      ) : (
        <Awaiting label="awaiting raster neurons" minHeight={200} />
      )}
    </Panel>
  );
}

/** The raster folded into a collapsible strip so the brain map can take its place as the main view. */
export function SpikeRasterDisclosure() {
  const { welcome, rasterBins } = useBrain();
  const rows = welcome?.raster_ids.length ?? 128;
  const last = rasterBins[rasterBins.length - 1];
  return (
    <details className="disclosure raster-disclosure">
      <summary>
        <span>
          <PixelIcon name="brain" /> SPIKE RASTER · {rows} SAMPLED CELLS
        </span>
        <span className="summary-end">
          <span>{last ? `${num(last.population_spikes)} spikes / ${last.window_ms.toFixed(0)} ms` : 'per-cell spikes over time'}</span>
          <PixelIcon name="plus" />
        </span>
      </summary>
      <SpikeRaster />
    </details>
  );
}

function groupRuns(groups: string[] | undefined, fallback: string[], rows: number): { name: string; rows: number }[] {
  if (groups && groups.length === rows && rows > 0) {
    const runs: { name: string; rows: number }[] = [];
    for (const name of groups) {
      const last = runs[runs.length - 1];
      if (last && last.name === name) last.rows++;
      else runs.push({ name, rows: 1 });
    }
    return runs;
  }
  if (!rows || !fallback.length) return [];
  return fallback.map((name, i) => ({
    name,
    rows: Math.round(((i + 1) * rows) / fallback.length) - Math.round((i * rows) / fallback.length),
  }));
}
