/** Phase-1 default: a black canvas where nothing moves. */
import type { GameState } from '../protocol';
import { GameScene, type Action, type StepResult } from './environment';

export class EmptyScene extends GameScene {
  static readonly KEY = 'empty';
  private tick = 0;

  constructor() {
    super({ key: EmptyScene.KEY });
  }

  create() {
    this.tick = 0;
    this.cameras.main.setBackgroundColor('#000000');
    this.setupKeyboard();
  }

  step(action: Action, _dt: number): StepResult {
    this.tick += 1;
    this.lastAction = action;
    return { reward: 0 };
  }

  state(): GameState {
    return { round: 1, tick: this.tick, score: 0, lives: 3, aliens: 0, finished: false };
  }

  reset() {
    this.tick = 0;
  }
}
