/**
 * React host for the Phaser game + lockstep bridge (src/game/bridge-loop.ts).
 * Shows a compact status bar above the canvas:
 *   INVADERS · BRAIN · tick 1234 · 58 tps 0.97x · move ▮▮▮ · FIRE · round 2 score 140 lives 2 aliens 31
 */
import { useEffect, useRef, useState } from 'react';
import { useBrain } from '../bridge/store';
import { BridgeLoop, type LoopSnapshot } from '../game/bridge-loop';
import type { EnvName } from '../protocol';

export function GameStage({ env }: { env: EnvName }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const loopRef = useRef<BridgeLoop | null>(null);
  const [snap, setSnap] = useState<LoopSnapshot | null>(null);
  const brain = useBrain();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const loop = new BridgeLoop(host, env);
    loopRef.current = loop;
    loop.start();
    // The loop emits once per tick (up to 60/s); coalesce to one React update per frame.
    let raf = 0;
    const refresh = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setSnap(loop.snapshot());
      });
    };
    const unsubscribe = loop.subscribe(refresh);
    // Keyboard mode steps inside Phaser without notifying us, and tps / the round
    // summary decay with wall time; poll for those.
    const interval = setInterval(refresh, 200);
    return () => {
      clearInterval(interval);
      if (raf) cancelAnimationFrame(raf);
      unsubscribe();
      loop.destroy();
      if (loopRef.current === loop) loopRef.current = null;
    };
    // The loop owns env switching after mount (see the effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loopRef.current?.setEnv(env);
  }, [env]);

  const driving = !!snap?.driving;
  const action = snap?.lastAction ?? null;
  const move = action ? Math.max(-1, Math.min(1, action.move)) : 0;
  const barLeft = move < 0 ? 50 + move * 50 : 50;
  const barWidth = Math.abs(move) * 50;
  const raw = driving && typeof brain.lastAction?.move_raw === 'number' ? brain.lastAction.move_raw : null;
  const game = snap?.game ?? null;
  const mode = driving ? 'BRAIN' : brain.role === 'spectator' ? 'SPECTATOR — another tab is driving' : 'NO BRAIN — keyboard';
  const recent = snap?.recentEnd ?? null;

  return (
    <div className="game-stage game-stage--live">
      <div className="game-stage-bar">
        <span className="game-stage-env">{env}</span>
        {brain.connection !== 'open' ? (
          <span className={`game-stage-conn game-stage-conn--${brain.connection}`}>{brain.connection}</span>
        ) : null}
        <span className={driving ? 'game-stage-mode game-stage-mode--brain' : 'game-stage-mode'}>{mode}</span>
        <span className="game-stage-tick">
          tick {snap?.tick ?? 0}
          {snap?.waiting ? ' …' : ''}
        </span>
        {driving && snap ? (
          <span className="game-stage-tps" title={snap.syncRender ? 'synchronous render' : 'RAF fallback'}>
            {Math.round(snap.tps)} tps {snap.speed.toFixed(2)}x
          </span>
        ) : null}
        <span className="game-stage-move-wrap" title={`move ${move.toFixed(2)}`}>
          <span className="game-stage-move">
            <span className="game-stage-move-fill" style={{ left: `${barLeft}%`, width: `${barWidth}%` }} />
          </span>
          {raw !== null ? <small className="game-stage-move-raw">raw {raw.toFixed(2)}</small> : null}
        </span>
        <span className={action?.fire ? 'game-stage-fire game-stage-fire--on' : 'game-stage-fire'}>FIRE</span>
        {env === 'invaders' && game ? (
          <span className="game-stage-score">
            round {game.round} score {game.score} lives {game.lives} aliens {game.aliens}
            {snap && snap.lastReward !== 0 ? ` reward ${snap.lastReward > 0 ? '+' : ''}${snap.lastReward}` : ''}
          </span>
        ) : null}
        {env === 'invaders' && recent ? (
          <span className="game-stage-ended">
            round {recent.round} ended · score {recent.score} · {recent.ticks} ticks
          </span>
        ) : null}
      </div>
      <div ref={hostRef} className="game-stage-canvas" />
      {env === 'empty' ? (
        <p className="game-stage-hint">empty canvas: the fly sees darkness. switch to INVADERS to let it play.</p>
      ) : null}
    </div>
  );
}
