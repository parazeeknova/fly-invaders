import { useBrain } from '../bridge/store';
import { PixelIcon } from './PixelIcon';
import { Stat, compact, fixed, num } from './shared';

/** Connection, brain status, run identity and the three clocks. */
export function StatusBar() {
  const { connection, status, welcome, telemetry } = useBrain();
  const clocks = telemetry?.clocks;
  const manifest = welcome?.manifest;
  const phase = status?.status ?? (connection === 'open' ? 'waiting' : 'offline');
  const loading = status?.status === 'loading';
  const progress = loading && status?.progress != null ? Math.round(status.progress * 100) : null;

  return (
    <section className="status-bar" aria-label="Brain status">
      <div className="status-row">
        <span className={`conn is-${connection}`} title={`websocket ${connection}`}>
          <i className="status-pixel" />
          {connection}
        </span>
        <span className={`brain-state is-${phase}`}>
          <PixelIcon name="signal" />
          {phase}
        </span>
        {status?.message ? <span className="status-msg">{status.message}</span> : null}
        {progress != null ? (
          <span className="progress" role="progressbar" aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
            <em>{progress}%</em>
          </span>
        ) : null}
        <span className="status-spacer" />
        <span className="tag" title={welcome?.run_id ?? ''}>
          run <b>{welcome ? welcome.run_id.slice(0, 8) : '—'}</b>
        </span>
        <span className="tag">
          dataset <b>{manifest?.dataset ?? '—'}</b>
        </span>
        {manifest?.synthetic ? <span className="tag badge">synthetic</span> : null}
        <span className="tag">
          decoder <b>{welcome?.decoder ?? '—'}</b>
        </span>
        <span className="tag">
          phase <b>{welcome?.phase ?? '—'}</b>
        </span>
      </div>
      <div className="clocks">
        <Stat label="wall" value={fixed(clocks?.wall_seconds)} unit="s" />
        <Stat label="neural" value={fixed(clocks?.neural_seconds)} unit="s" />
        <Stat label="game" value={fixed(clocks?.game_seconds)} unit="s" />
        <Stat label="speed × realtime" value={clocks ? `${clocks.speed.toFixed(2)}×` : '—'} />
        <Stat label="brain step" value={fixed(clocks?.brain_step_ms)} unit="ms" />
        <Stat label="neurons" value={manifest ? num(manifest.neurons) : '—'} />
        <Stat label="connections" value={manifest ? compact(manifest.edges) : '—'} />
        <Stat label="total spikes" value={telemetry ? compact(telemetry.total_spikes) : '—'} />
      </div>
    </section>
  );
}
