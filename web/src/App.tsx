import { useState } from 'react';
import { BrainDashboard } from './components/BrainDashboard';
import { GameStage } from './components/GameStage';
import { Populations } from './panels/Populations';
import { RoundsPanel } from './panels/RoundsPanel';
import type { EnvName } from './protocol';

export function App() {
  const [env, setEnv] = useState<EnvName>('invaders');
  return (
    <div className="app">
      <header className="site-header">
        <h1>FLY BRAIN / INVADERS</h1>
        <nav className="env-switch">
          {(['empty', 'invaders'] as EnvName[]).map((name) => (
            <button
              key={name}
              type="button"
              className={name === env ? 'active' : ''}
              onClick={() => setEnv(name)}
            >
              {name}
            </button>
          ))}
        </nav>
      </header>
      <main className="layout">
        <section className="stage-column">
          <GameStage env={env} />
          <div className="stage-extras">
            <Populations />
            <RoundsPanel />
          </div>
        </section>
        <section className="brain-column">
          <BrainDashboard />
        </section>
      </main>
    </div>
  );
}
