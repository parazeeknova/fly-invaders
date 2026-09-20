import { useEffect, useRef } from 'react';
import { useBrain } from '../bridge/store';
import { PixelIcon } from './PixelIcon';
import { Awaiting, Panel, PlotKey } from './shared';

const W = 400;
const H = 96;
const TICKS = 50;
const FIRE_H = 8;
const MOVE_H = 28;

/** Last 50 ticks: spikes per tick (bars), decoded move (line) and fire markers. */
export function Timeline() {
  const { telemetry } = useBrain();
  const ref = useRef<HTMLCanvasElement>(null);
  const entries = telemetry?.timeline ?? [];

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const slot = W / TICKS;
    const offset = TICKS - Math.min(TICKS, entries.length);
    const view = entries.slice(-TICKS);
    const spikeTop = FIRE_H + 2;
    const spikeH = H - spikeTop - MOVE_H - 4;
    const moveMid = H - MOVE_H / 2;
    let max = 1;
    for (const e of view) if (e.spikes > max) max = e.spikes;
    // Move baseline and band.
    ctx.fillStyle = '#333';
    ctx.fillRect(0, H - MOVE_H - 2, W, 1);
    ctx.fillRect(0, moveMid, W, 1);
    for (let i = 0; i < view.length; i++) {
      const e = view[i];
      const x = Math.floor((offset + i) * slot);
      const w = Math.max(1, Math.floor(slot) - 1);
      // spikes
      const h = Math.max(1, Math.round((e.spikes / max) * spikeH));
      ctx.fillStyle = '#bbb';
      ctx.fillRect(x, spikeTop + spikeH - h, w, h);
      // move: bar from the midline, up = right, down = left
      const mh = Math.round(Math.max(-1, Math.min(1, e.move)) * (MOVE_H / 2 - 2));
      ctx.fillStyle = '#fff';
      if (mh >= 0) ctx.fillRect(x, moveMid - mh, w, Math.max(1, mh));
      else ctx.fillRect(x, moveMid, w, -mh);
      // fire marker
      if (e.fire) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(x, 0, w, FIRE_H);
      }
    }
  }, [entries]);

  const last = entries[entries.length - 1];
  const fires = entries.reduce((n, e) => n + (e.fire ? 1 : 0), 0);

  return (
    <Panel
      title="04 / LAST 50 TICKS"
      icon={<PixelIcon name="screen" />}
      caption={last ? `tick ${last.tick}` : 'per-tick trace'}
    >
      {entries.length ? (
        <>
          <canvas ref={ref} width={W} height={H} className="timeline" aria-label="Spikes, move and fire per game tick" />
          <PlotKey>
            <span>▔ fire ({fires}) · ▮ spikes / tick · ▲▼ move R/L</span>
            <span>{entries.length} ticks →</span>
          </PlotKey>
        </>
      ) : (
        <Awaiting label="awaiting ticks" minHeight={96} />
      )}
    </Panel>
  );
}
