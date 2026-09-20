/**
 * Environment contract shared by the game scenes and the lockstep bridge.
 *
 * Game logic is stepped manually with a fixed dt (1/60 s) by whoever drives the
 * environment (the brain via bridge-loop.ts, or the keyboard debug mode inside the
 * scene's own update()). Phaser's render loop only draws whatever positions the last
 * step() left behind; no arcade physics, tweens or timers take part in gameplay.
 *
 * Rendering between ticks: when the brain is slower than 60 ticks/s a scene may
 * extrapolate sprite positions on each render frame from the per-entity velocities
 * (view only, never touches game state). settleView() snaps the view back to the
 * exact post-step state so a capture always shows what the brain acted on.
 */
import Phaser from 'phaser';
import { GAME_FPS, type GameState, type RoundSummary } from '../protocol';

export interface Action {
  /** [-1, 1]; negative = left, positive = right */
  move: number;
  fire: boolean;
}

export interface StepResult {
  reward: number;
  /** Present on the tick a round ended (lives exhausted or wave cleared). */
  ended?: RoundSummary;
}

export interface Environment {
  step(action: Action, dt: number): StepResult;
  state(): GameState;
  reset(): void;
}

export const WORLD_WIDTH = 800;
export const WORLD_HEIGHT = 600;
export const STEP_DT = 1 / GAME_FPS;

/** Sounds are off by default: the brain fires on every DNpe017 spike. */
export const SOUND_ENABLED = false;

/** Small deterministic PRNG (mulberry32). */
export class Prng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Base scene: implements the keyboard debug mode. When `brainDriven` is false the
 * scene steps itself at 60 Hz from Phaser's update() using arrow keys + space.
 * When true, only the bridge loop calls step().
 */
export abstract class GameScene extends Phaser.Scene implements Environment {
  brainDriven = false;
  /**
   * Allow view-only extrapolation of sprite positions between brain ticks. The bridge
   * turns this off when it cannot render synchronously (RAF fallback), because then
   * the frame it captures is whatever Phaser's own render loop drew.
   */
  viewExtrapolation = true;
  /** Last action applied by step(), for the overlay. */
  lastAction: Action = { move: 0, fire: false };

  private accumulator = 0;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  private fireKey: Phaser.Input.Keyboard.Key | null = null;

  abstract step(action: Action, dt: number): StepResult;
  abstract state(): GameState;
  abstract reset(): void;

  /** Called when control switches between the brain and the keyboard. */
  protected onControlModeChanged(): void {}

  /** Snap sprites to the exact state left by the last step() (undo any extrapolation). */
  settleView(): void {}

  setBrainDriven(value: boolean) {
    if (this.brainDriven === value) return;
    this.brainDriven = value;
    this.accumulator = 0;
    if (this.sys.isActive()) this.onControlModeChanged();
  }

  protected setupKeyboard() {
    const keyboard = this.input.keyboard;
    if (!keyboard) return;
    this.cursors = keyboard.createCursorKeys();
    this.fireKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
  }

  protected keyboardAction(): Action {
    let move = 0;
    if (this.cursors?.left.isDown) move -= 1;
    if (this.cursors?.right.isDown) move += 1;
    return { move, fire: !!this.fireKey?.isDown };
  }

  update(_time: number, delta: number) {
    if (this.brainDriven) return;
    this.accumulator = Math.min(this.accumulator + delta / 1000, 0.25);
    while (this.accumulator >= STEP_DT) {
      this.step(this.keyboardAction(), STEP_DT);
      this.accumulator -= STEP_DT;
    }
  }
}
