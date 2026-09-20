/**
 * Lockstep driver: owns the Phaser.Game, the active scene (Environment) and the
 * frame -> action -> step cycle with the Python brain.
 *
 *   render the exact post-step state synchronously -> capture canvas (160x120 RGB)
 *   -> sendFrame(tick) -> wait for action(tick) -> env.step(action, 1/60)
 *   -> pace to 60 ticks/s -> render + capture the next frame, tick + 1 ...
 *
 * Pacing: the logical tick is always STEP_DT of game time, so gameplay stays
 * deterministic per tick. Sends are paced so ticks happen at most GAME_FPS per wall
 * second; when the brain is slower than that the game simply runs slower (game time
 * == neural time). The canvas is drawn synchronously right after step() (the same
 * calls Phaser.Game.step makes), so the brain never waits for a browser animation
 * frame. If that synchronous render fails we fall back to capturing after the next
 * requestAnimationFrame, with view extrapolation disabled.
 *
 * While the brain is not driving (disconnected, still loading, spectator, or never
 * welcomed us) the scene falls back to keyboard debug mode.
 */
import Phaser from 'phaser';
import { brainClient } from '../bridge/client';
import { store } from '../bridge/store';
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  GAME_FPS,
  type ActionMessage,
  type EnvName,
  type FrameMessage,
  type GameState,
  type HelloMessage,
  type RoundSummary,
  type WelcomeMessage,
} from '../protocol';
import { EmptyScene } from './EmptyScene';
import { InvadersScene } from './InvadersScene';
import { GameScene, SOUND_ENABLED, STEP_DT, WORLD_HEIGHT, WORLD_WIDTH, type Action, clamp } from './environment';
import { FrameCapture } from './capture';

const ACTION_TIMEOUT_MS = 10_000;
const WELCOME_WAIT_MS = 750;
/** Minimum wall time between two frame sends (realtime pacing). */
const STEP_MS = 1000 / GAME_FPS;
/** Waits shorter than this are not worth a timer; send right away. */
const PACE_SLACK_MS = 1;
/** Window over which ticks/s is measured. */
const TPS_WINDOW_MS = 1000;
/** How long the overlay keeps showing the summary of a round that just ended. */
const ROUND_SUMMARY_MS = 4000;

export interface LoopSnapshot {
  env: EnvName;
  /** Tick of the frame currently in flight (or the next one to be sent). */
  tick: number;
  /** True while the brain is driving step(); false = keyboard debug mode. */
  driving: boolean;
  /** True while a frame has been sent and its action has not arrived. */
  waiting: boolean;
  /** Achieved logical ticks per wall second over the last second (brain mode only). */
  tps: number;
  /** tps / GAME_FPS: 1 = realtime, <1 = slow motion. */
  speed: number;
  /** True when frames are rendered synchronously before capture (no RAF wait). */
  syncRender: boolean;
  game: GameState | null;
  lastAction: Action | null;
  lastReward: number;
  rounds: RoundSummary[];
  /** Summary of a round that ended within the last few seconds, for the overlay. */
  recentEnd: RoundSummary | null;
}

export class BridgeLoop {
  private game: Phaser.Game | null = null;
  private scene: GameScene | null = null;
  private env: EnvName;
  private destroyed = false;
  private switchId = 0;

  private tick = 1;
  private lastReward = 0;
  private lastEnded: RoundSummary | undefined;
  private rounds: RoundSummary[] = [];
  private recentEnd: { summary: RoundSummary; at: number } | null = null;
  private driving = false;
  private pending: FrameMessage | null = null;
  private resent = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private paceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall time (performance.now) at or after which the next frame may be sent. */
  private nextDue = 0;
  private stepTimes: number[] = [];
  private syncRender = true;
  private lastWelcome: WelcomeMessage | null = null;
  private welcomeWait: ReturnType<typeof setTimeout> | null = null;

  private readonly capture = new FrameCapture(FRAME_WIDTH, FRAME_HEIGHT);
  private readonly cleanups: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly parent: HTMLElement,
    env: EnvName,
  ) {
    this.env = env;
  }

  /** Create the Phaser game and start the lockstep. Safe under StrictMode double-mount. */
  start() {
    // Defer one tick so a synchronous mount -> unmount -> mount never creates two games.
    setTimeout(() => {
      if (this.destroyed || this.game) return;
      this.boot();
    }, 0);
  }

  private boot() {
    const game = new Phaser.Game({
      type: Phaser.CANVAS,
      parent: this.parent,
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      backgroundColor: '#000000',
      banner: false,
      render: { pixelArt: true },
      audio: { noAudio: !SOUND_ENABLED },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [],
    });
    this.game = game;

    game.events.once(Phaser.Core.Events.READY, () => {
      if (this.destroyed) return;
      game.scene.add(EmptyScene.KEY, EmptyScene, false);
      game.scene.add(InvadersScene.KEY, InvadersScene, false);
      void this.switchScene(this.env);
    });

    this.cleanups.push(brainClient.onAction((action) => this.onAction(action)));
    this.cleanups.push(store.subscribe(() => this.onStoreChange()));
  }

  /** Switch environments: restart the scene, re-hello the brain, restart from tick 1. */
  setEnv(env: EnvName) {
    if (env === this.env) return;
    this.env = env;
    if (this.game && this.game.isBooted) void this.switchScene(env);
  }

  private async switchScene(env: EnvName) {
    const game = this.game;
    if (!game) return;
    const id = ++this.switchId;
    this.stopDriving();
    if (this.scene) {
      game.scene.stop(this.scene.scene.key);
      this.scene = null;
    }
    const scene = game.scene.getScene(env) as GameScene;
    const created = new Promise<void>((resolve) => scene.events.once(Phaser.Scenes.Events.CREATE, () => resolve()));
    game.scene.start(env);
    await created;
    if (id !== this.switchId || this.destroyed) return;

    this.scene = scene;
    scene.viewExtrapolation = this.syncRender;
    this.resetRun();
    this.emit();

    brainClient.connect(this.hello());
    // The server normally answers the new hello with a fresh welcome (-> beginRun via
    // onStoreChange). If the socket is already open and no welcome shows up shortly,
    // start anyway so a server that does not re-welcome cannot stall the loop.
    this.clearWelcomeWait();
    if (store.get().connection === 'open') {
      this.welcomeWait = setTimeout(() => {
        this.welcomeWait = null;
        const brain = store.get();
        if (brain.connection === 'open' && brain.welcome && brain.role !== 'spectator' && !this.driving) {
          this.lastWelcome = brain.welcome;
          this.beginRun();
        }
      }, WELCOME_WAIT_MS);
    }
  }

  private clearWelcomeWait() {
    if (this.welcomeWait) clearTimeout(this.welcomeWait);
    this.welcomeWait = null;
  }

  private hello(): HelloMessage {
    return {
      type: 'hello',
      protocol: 1,
      role: 'env',
      env: this.env,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      fps: GAME_FPS,
    };
  }

  private onStoreChange() {
    const brain = store.get();
    if (brain.connection !== 'open') {
      this.lastWelcome = null;
      if (this.driving) this.stopDriving();
      return;
    }
    if (brain.role === 'spectator') {
      // Another tab took over the brain; fall back to keyboard mode until we are promoted.
      this.lastWelcome = brain.welcome;
      this.clearWelcomeWait();
      if (this.driving) this.stopDriving();
      return;
    }
    if (brain.welcome && brain.welcome !== this.lastWelcome) {
      // New run (first connect, reconnect or promotion): fresh environment, tick 1.
      this.lastWelcome = brain.welcome;
      this.clearWelcomeWait();
      if (this.scene) this.beginRun();
    }
  }

  private resetRun() {
    this.tick = 1;
    this.lastReward = 0;
    this.lastEnded = undefined;
    this.rounds = [];
    this.recentEnd = null;
    this.stepTimes = [];
    this.nextDue = 0;
  }

  private beginRun() {
    if (!this.scene) return;
    this.cancelPending();
    this.scene.reset();
    this.resetRun();
    this.driving = true;
    this.scene.setBrainDriven(true);
    this.emit();
    this.scheduleCapture();
  }

  private stopDriving() {
    this.cancelPending();
    this.driving = false;
    this.stepTimes = [];
    this.scene?.setBrainDriven(false);
    this.emit();
  }

  // ---- Frame cycle -------------------------------------------------------

  /**
   * Send the next frame as soon as realtime pacing allows: never sooner than STEP_MS
   * after the previous send. The due time advances by STEP_MS per tick (so timer
   * lateness does not accumulate) but never lags behind "now" when the brain is slow.
   */
  private scheduleCapture() {
    this.clearScheduled();
    const now = performance.now();
    this.nextDue = Math.max(this.nextDue + STEP_MS, now);
    const wait = this.nextDue - now;
    if (wait <= PACE_SLACK_MS) {
      this.captureAndSend();
      return;
    }
    this.paceTimer = setTimeout(() => {
      this.paceTimer = null;
      this.captureAndSend();
    }, wait);
  }

  private captureAndSend() {
    if (!this.driving || !this.scene || !this.game || this.destroyed) return;
    if (!this.renderNow()) {
      // Synchronous render unavailable: let Phaser's own loop draw the exact state
      // (extrapolation is off in this mode), then capture after its frame.
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.sendFrame();
      });
      return;
    }
    this.sendFrame();
  }

  /**
   * Draw the exact post-step state into game.canvas right now, the same way
   * Phaser.Game.step does it (see phaser/src/core/Game.js). Returns false and switches
   * to the RAF fallback for the rest of the session if the renderer refuses.
   */
  private renderNow(): boolean {
    const game = this.game;
    const scene = this.scene;
    if (!game || !scene) return false;
    if (!this.syncRender) return false;
    try {
      scene.settleView();
      const renderer = game.renderer;
      renderer.preRender();
      game.scene.render(renderer);
      renderer.postRender();
      return true;
    } catch (error) {
      console.warn('[bridge] synchronous render failed; falling back to requestAnimationFrame', error);
      this.syncRender = false;
      scene.viewExtrapolation = false;
      scene.settleView();
      this.emit();
      return false;
    }
  }

  private sendFrame() {
    if (!this.driving || !this.scene || !this.game || this.destroyed) return;
    const frame: FrameMessage = {
      type: 'frame',
      tick: this.tick,
      pixels: this.capture.encodeBytes(this.game.canvas),
      game: this.scene.state(),
      reward: this.lastReward,
    };
    if (this.lastEnded) frame.ended = this.lastEnded;
    this.pending = frame;
    this.resent = false;
    brainClient.sendFrame(frame);
    this.armTimeout();
  }

  private armTimeout() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.timeout = null;
      if (!this.pending || !this.driving) return;
      if (!this.resent) {
        this.resent = true;
        console.warn(`[bridge] no action for tick ${this.pending.tick} after 10 s; re-sending frame`);
        brainClient.sendFrame(this.pending);
        this.armTimeout();
      } else {
        console.warn(`[bridge] still no action for tick ${this.pending.tick}; waiting for the brain`);
      }
    }, ACTION_TIMEOUT_MS);
  }

  private clearScheduled() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.paceTimer) clearTimeout(this.paceTimer);
    this.paceTimer = null;
  }

  private cancelPending() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.clearScheduled();
    this.pending = null;
    this.resent = false;
  }

  private onAction(action: ActionMessage) {
    if (!this.driving || !this.scene || !this.pending) return;
    if (action.tick !== this.pending.tick) return; // stale or duplicate
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.pending = null;

    const result = this.scene.step(
      { move: clamp(Number(action.move) || 0, -1, 1), fire: Boolean(action.fire) },
      STEP_DT,
    );
    const now = performance.now();
    this.lastReward = result.reward;
    this.lastEnded = result.ended; // attached to exactly one frame: the next one
    if (result.ended) {
      this.rounds = [...this.rounds, result.ended].slice(-20);
      this.recentEnd = { summary: result.ended, at: now };
    }
    this.tick += 1;
    this.stepTimes.push(now);
    this.emit();
    this.scheduleCapture();
  }

  // ---- Overlay support ---------------------------------------------------

  /** Ticks per wall second over the last TPS_WINDOW_MS. */
  private tps(now: number): number {
    const times = this.stepTimes;
    const cutoff = now - TPS_WINDOW_MS;
    let drop = 0;
    while (drop < times.length && times[drop] < cutoff) drop++;
    if (drop > 0) times.splice(0, drop);
    if (times.length === 0) return 0;
    // Scale up while the window is still filling so the readout settles quickly.
    const span = Math.min(TPS_WINDOW_MS, Math.max(now - times[0], STEP_MS));
    return (times.length * 1000) / span;
  }

  snapshot(): LoopSnapshot {
    const now = performance.now();
    const tps = this.driving ? this.tps(now) : 0;
    const recent = this.recentEnd && now - this.recentEnd.at < ROUND_SUMMARY_MS ? this.recentEnd.summary : null;
    return {
      env: this.env,
      tick: this.tick,
      driving: this.driving,
      waiting: this.pending !== null,
      tps,
      speed: tps / GAME_FPS,
      syncRender: this.syncRender,
      game: this.scene?.sys.isActive() ? this.scene.state() : null,
      lastAction: this.scene ? this.scene.lastAction : null,
      lastReward: this.lastReward,
      rounds: this.rounds,
      recentEnd: recent,
    };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  destroy() {
    this.destroyed = true;
    this.cancelPending();
    this.clearWelcomeWait();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.listeners.clear();
    this.scene = null;
    if (this.game) {
      this.game.destroy(true);
      this.game = null;
    }
  }
}
