import { useBrain } from '../bridge/store';
import { PixelIcon } from './PixelIcon';
import { Awaiting, Panel, Stat, num } from './shared';

const MAX_ROWS = 8;

/** Current game state (telemetry only, never fed to the brain) and finished rounds. */
export function RoundsPanel() {
  const { telemetry } = useBrain();
  const game = telemetry?.game;
  const episodes = telemetry?.episodes ?? [];
  const recent = episodes.slice(-MAX_ROWS).reverse();
  const reward = telemetry?.reward;

  return (
    <Panel
      title="06 / GAME"
      icon={<PixelIcon name="skull" />}
      caption={game ? `round ${String(game.round).padStart(2, '0')}${game.finished ? ' · over' : ''}` : 'telemetry only'}
    >
      {game ? (
        <>
          <div className="game-vitals">
            <Stat label="score" value={num(game.score)} />
            <Stat label="lives" value={'♥'.repeat(Math.max(0, Math.min(5, game.lives))) || '0'} />
            <Stat label="aliens" value={num(game.aliens)} />
            <Stat label="tick" value={num(game.tick)} />
          </div>
          {recent.length ? (
            <div className="table-scroll">
              <table className="rounds">
                <thead>
                  <tr>
                    <th>round</th>
                    <th>ticks</th>
                    <th>score</th>
                    <th>lives</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e, i) => (
                    <tr key={`${e.round}-${i}`}>
                      <td>{String(e.round).padStart(2, '0')}</td>
                      <td>{num(e.ticks)}</td>
                      <td>{num(e.score)}</td>
                      <td>{e.lives}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="note">no finished rounds yet</p>
          )}
          <p className="note">
            reward {reward?.mode ?? 'off'}
            {reward?.mode === 'sugar' ? ` · ${reward.sugar_pulses} sugar pulses${reward.active ? ' · active' : ''}` : ''}
            {' · '}plasticity {reward?.plasticity ? 'on' : 'off'} · pixels only enter the brain
          </p>
        </>
      ) : (
        <Awaiting label="awaiting game telemetry" minHeight={140} />
      )}
    </Panel>
  );
}
