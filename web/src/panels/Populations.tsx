import { useBrain } from '../bridge/store';
import { PixelIcon } from './PixelIcon';
import { Awaiting, Panel, PlotKey, compact, num } from './shared';

/**
 * The connectome's ~27 superclasses folded into seven anatomical groups. Bars are log-scaled
 * mean rate per cell; a group with zero spikes in the window is marked SILENT explicitly,
 * because in this model most of the brain outside the optic lobe really is quiet.
 */
const GROUPS: { key: string; label: string; match: (name: string) => boolean }[] = [
  { key: 'ol', label: 'OPTIC LOBE', match: (n) => n.startsWith('ol_') },
  { key: 'vp', label: 'VISUAL PROJ', match: (n) => n.startsWith('visual_') || n === 'vpn' },
  { key: 'cb', label: 'CENTRAL BRAIN', match: (n) => n.startsWith('cb_') || n === 'central_brain' },
  { key: 'dn', label: 'DESCENDING', match: (n) => n.includes('descending') },
  { key: 'an', label: 'ASCENDING', match: (n) => n.includes('ascending') },
  { key: 'vnc', label: 'VNC / MOTOR', match: (n) => n.startsWith('vnc_') || n === 'motor' },
  { key: 'other', label: 'OTHER', match: () => true },
];
const FLOOR_HZ = 0.01;
const CEIL_HZ = 100;
const logBar = (hz: number) => (hz <= 0 ? 0 : Math.min(1, Math.log1p(hz / FLOOR_HZ) / Math.log1p(CEIL_HZ / FLOOR_HZ)));

export function Populations() {
  const { telemetry } = useBrain();
  const windowS = telemetry ? Math.max(1e-3, telemetry.window_ms / 1000) : 1;
  const rows = GROUPS.map((g) => ({ ...g, neurons: 0, spikes: 0, classes: 0 }));
  for (const p of telemetry?.populations ?? []) {
    const row = rows.find((g) => g.match(p.name))!;
    row.neurons += p.neurons;
    row.spikes += p.spikes;
    row.classes += 1;
  }
  const shown = rows.filter((r) => r.neurons > 0);

  return (
    <Panel
      title="05 / POPULATIONS"
      icon={<PixelIcon name="signal" />}
      caption={telemetry ? `${num(telemetry.window_spikes)} spikes / ${telemetry.window_ms.toFixed(0)} ms` : 'mean rate'}
    >
      {shown.length ? (
        <>
          <ul className="pop-list">
            {shown.map((r) => {
              const hz = r.spikes / r.neurons / windowS;
              const silent = r.spikes === 0;
              return (
                <li key={r.key} className={silent ? 'is-silent' : ''} title={`${r.classes} superclasses`}>
                  <span className="label">{r.label}</span>
                  <div className="pop-bar">
                    <span style={{ width: `${(logBar(hz) * 100).toFixed(1)}%` }} />
                  </div>
                  <strong>{silent ? 'SILENT' : `${hz >= 10 ? hz.toFixed(1) : hz.toFixed(2)} Hz`}</strong>
                  <small>
                    {compact(r.neurons)} cells · {num(r.spikes)} spk
                  </small>
                </li>
              );
            })}
          </ul>
          <PlotKey>
            <span>mean spikes/s per cell, log scale</span>
            <span>{FLOOR_HZ}–{CEIL_HZ} Hz</span>
          </PlotKey>
        </>
      ) : (
        <Awaiting label="awaiting population rates" minHeight={140} />
      )}
    </Panel>
  );
}
