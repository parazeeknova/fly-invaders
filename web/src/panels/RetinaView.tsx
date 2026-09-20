import { useEffect, useRef, useState } from 'react';
import { useBrain } from '../bridge/store';
import { PixelIcon } from './PixelIcon';
import { Awaiting, Panel, PlotKey, num } from './shared';

type Mode = 'luminance' | 'filtered_luminance' | 'drive_mv' | 'spikes_last_step';

const MODES: { key: Mode; label: string; range: string }[] = [
  { key: 'luminance', label: 'RAW', range: '0–1 frame brightness' },
  { key: 'filtered_luminance', label: 'FILTERED', range: '0–1 · 10 ms low-pass' },
  { key: 'drive_mv', label: 'DRIVE', range: 'mV into R1–R6' },
  { key: 'spikes_last_step', label: 'SPIKES', range: 'spiked in last 0.1 ms step' },
];

const W = 480;
const H = 240;
const PAD = 6;

/** "What the fly sees": strided photoreceptor sample positions shaded by the chosen signal. */
export function RetinaView() {
  const { welcome, telemetry } = useBrain();
  const [mode, setMode] = useState<Mode>('luminance');
  const ref = useRef<HTMLCanvasElement>(null);
  const retina = welcome?.retina;
  const values = telemetry?.retina?.[mode];
  const gain = welcome?.protocol_info.retinal_gain_mv ?? 30;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !retina) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    let scale = 1;
    if (mode === 'drive_mv') {
      let max = gain;
      if (values) for (const v of values) if (v > max) max = v;
      scale = 1 / Math.max(1e-6, max);
    }
    const uv = retina.uv;
    for (let i = 0; i < uv.length; i++) {
      const raw = values?.[i] ?? 0;
      let v: number;
      if (mode === 'spikes_last_step') v = raw > 0 ? 1 : 0;
      else if (mode === 'drive_mv') v = Math.max(0, raw) * scale;
      else v = Math.pow(Math.max(0, raw), 1 / 2.2);
      v = Math.min(1, v);
      const shade = 28 + Math.round(227 * v);
      const x = Math.round(PAD + uv[i][0] * (W - PAD * 2));
      const y = Math.round(PAD + uv[i][1] * (H - PAD * 2));
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
      ctx.fillRect(x - 2, y - 2, 4, 4);
      if (retina.side[i] !== 'L') {
        // Right eye: hollow square so overlapping projections stay distinguishable.
        ctx.fillStyle = '#000';
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
  }, [retina, values, mode, gain]);

  const manifest = welcome?.manifest;
  const caption = manifest
    ? `${num(manifest.retina_mapped)} / ${num(manifest.retina_total)} mapped`
    : 'live pixels';
  const current = MODES.find((m) => m.key === mode)!;

  return (
    <Panel title="01 / SENSORY INPUT" icon={<PixelIcon name="eye" />} caption={caption}>
      {retina ? (
        <>
          <canvas
            ref={ref}
            width={W}
            height={H}
            className="retina"
            aria-label="Photoreceptor sample positions shaded by the selected signal"
          />
          <div className="mode-switch" role="tablist" aria-label="Retina signal">
            {MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                role="tab"
                aria-selected={m.key === mode}
                className={m.key === mode ? 'active' : ''}
                onClick={() => setMode(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <PlotKey>
            <span>
              <i className="swatch filled" /> left eye <i className="swatch hollow" /> right eye
            </span>
            <span>
              {num(retina.full_sample_count)} R1–R6 inputs · 1 in {retina.display_stride} shown
            </span>
            <span>{current.range}</span>
          </PlotKey>
        </>
      ) : (
        <Awaiting label="awaiting retina map" minHeight={240} />
      )}
    </Panel>
  );
}
