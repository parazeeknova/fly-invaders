import { useEffect, useState } from 'react';
import { useBrain } from '../bridge/store';
import type { Readout, ReadoutInfo } from '../protocol';
import { PixelIcon } from './PixelIcon';
import { Awaiting, Panel, fixed } from './shared';

/** Which readout type drives which button, per decoder. */
function role(decoder: string | undefined, type: string): { text: string; decoder: boolean } {
  if (decoder === 'biological') {
    if (type === 'DNa02') return { text: 'R−L → move', decoder: true };
    if (type === 'MN9') return { text: 'spike → fire', decoder: true };
    return { text: 'bci cmp', decoder: false };
  }
  if (type === 'DNp20') return { text: 'R−L → move', decoder: true };
  if (type === 'DNpe017') return { text: 'spike → fire', decoder: true };
  return { text: 'bio cmp', decoder: false };
}

function MotorOutput({ move, fire, live }: { move: number | null; fire: boolean; live: boolean }) {
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!fire) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 180);
    return () => clearTimeout(t);
  }, [fire]);
  const m = move ?? 0;
  const pct = Math.min(1, Math.abs(m)) * 50;
  return (
    <div className={live ? 'motor is-live' : 'motor'} aria-label="Decoded motor output">
      <div className="motor-move">
        <span className="label">
          <PixelIcon name="turn" /> move
        </span>
        <div className="move-bar" role="img" aria-label={`move ${fixed(move, 2)}`}>
          <i className="move-zero" />
          <i className={m < 0 ? 'move-fill left' : 'move-fill right'} style={{ width: `${pct}%` }} />
        </div>
        <div className="move-scale">
          <span>◀ LEFT</span>
          <strong>{move == null ? '—' : (m > 0 ? '+' : '') + m.toFixed(2)}</strong>
          <span>RIGHT ▶</span>
        </div>
      </div>
      <div className={flash ? 'fire is-firing' : 'fire'} role="img" aria-label={flash ? 'fire' : 'not firing'}>
        <PixelIcon name="target" />
        <span>FIRE</span>
      </div>
    </div>
  );
}

/** Readout neurons, their rates and voltages, and the decoded buttons. */
export function Readouts() {
  const { welcome, lastAction, telemetry } = useBrain();
  const decoder = welcome?.decoder;
  const rows: (ReadoutInfo & Partial<Readout>)[] =
    lastAction?.readouts ?? telemetry?.readouts ?? welcome?.readouts ?? [];
  const voltages = telemetry?.neuron_voltage_mv ?? {};
  const sorted = rows
    .map((r, i) => ({ r, i, role: role(decoder, r.type) }))
    .sort((a, b) => Number(b.role.decoder) - Number(a.role.decoder) || a.i - b.i);
  const live = !!lastAction;

  return (
    <Panel
      title="03 / NEURON → BUTTON"
      icon={<PixelIcon name="target" />}
      caption={lastAction ? `tick ${lastAction.tick} · ${lastAction.steps} steps` : 'fixed decoder'}
    >
      <MotorOutput move={lastAction?.move ?? null} fire={!!lastAction?.fire} live={live} />
      {sorted.length ? (
        <div className="table-scroll">
          <table className="readouts">
            <thead>
              <tr>
                <th>cell</th>
                <th>side</th>
                <th>spk</th>
                <th>rate</th>
                <th>Vm</th>
                <th>role</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(({ r, role: ro }) => (
                <tr key={r.id} className={ro.decoder ? 'is-decoder' : ''} title={`neuron ${r.id}`}>
                  <td>{r.type}</td>
                  <td>{r.side}</td>
                  <td className={r.spikes ? 'spiking' : ''}>{r.spikes ?? '—'}</td>
                  <td>
                    <div className="rate">
                      <span style={{ width: `${Math.min(100, r.rate_hz ?? 0)}%` }} />
                      <code>{r.rate_hz == null ? '—' : `${r.rate_hz.toFixed(1)} Hz`}</code>
                    </div>
                  </td>
                  <td>{fixed(voltages[r.id])}</td>
                  <td className="role">{ro.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Awaiting label="awaiting readouts" minHeight={120} />
      )}
    </Panel>
  );
}
