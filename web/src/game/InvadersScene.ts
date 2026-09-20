/**
 * Space Invaders, ported from ref/space-invaders-phaser-3 but stepped manually.
 *
 * Everything that affects gameplay lives in plain numbers updated inside step():
 * ship x, bullets, alien grid offset/direction, seeded enemy fire. Sprites are just
 * a view of that state; even the alien "fly" animation and the kaboom explosion
 * frames are advanced by tick so the rendered pixels are a pure function of the
 * action history.
 *
 * Between brain ticks the view extrapolates sprite positions from the per-entity
 * velocities (ship, alien grid, both bullet kinds) by the wall time elapsed since the
 * last step(), capped at one tick. That is purely cosmetic: step() and settleView()
 * always put sprites at the exact model positions before a frame is captured.
 */
import Phaser from 'phaser';
import type { GameState, RoundSummary } from '../protocol';
import {
  GameScene,
  Prng,
  SOUND_ENABLED,
  STEP_DT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  clamp,
  type Action,
  type StepResult,
} from './environment';

const TEX = {
  bullet: 'bullet',
  enemyBullet: 'enemyBullet',
  alien: 'alien',
  ship: 'ship',
  kaboom: 'kaboom',
} as const;

const SFX = { shoot: 'shoot', kaboom: 'kaboom', invaderKilled: 'invaderKilled' } as const;

// Ship
const SHIP_Y = 500;
const SHIP_SPEED = 200; // px/s at |move| = 1
const SHIP_TAU = 0.06; // s; velocity time constant, smooths per-tick sign flips of the decoder
const SHIP_DEAD_ZONE = 0.03; // |move| below this is treated as 0
const SHIP_HALF_W = 14;
const SHIP_HALF_H = 10;
const SHIP_MIN_X = SHIP_HALF_W;
const SHIP_MAX_X = WORLD_WIDTH - SHIP_HALF_W;
const HIT_INVULN_TICKS = 90;

// Player bullets (6x36, origin bottom-centre)
const BULLET_SPEED = 400;
const BULLET_W = 6;
const BULLET_H = 36;
const FIRE_COOLDOWN_TICKS = 12; // 200 ms

// Enemy bullets (9x9)
const ENEMY_BULLET_SPEED = 150;
const ENEMY_BULLET_SIZE = 9;
const ENEMY_FIRE_TICKS = 120; // 2 s

// Alien grid
const ALIEN_COLS = 10;
const ALIEN_ROWS = 4;
const ALIEN_TOTAL = ALIEN_COLS * ALIEN_ROWS;
const GRID_ORIGIN_X = 100;
const GRID_ORIGIN_Y = 100;
const GRID_DX = 48;
const GRID_DY = 50;
const ALIEN_HALF = 16;
const ALIEN_MIN_X = ALIEN_HALF + 8;
const ALIEN_MAX_X = WORLD_WIDTH - ALIEN_HALF - 8;
const ALIEN_BASE_SPEED = 40; // px/s with a full grid
const ALIEN_MAX_SPEED = 220; // px/s with one alien left
const ALIEN_DROP = 24; // px per edge bounce
const ALIEN_INVASION_Y = SHIP_Y - SHIP_HALF_H - ALIEN_HALF; // reaching this loses the round
const FLY_TICKS_PER_FRAME = 3; // 20 fps at 60 Hz

// Explosion (16 frames at 24 fps)
const KABOOM_FRAMES = 16;
const KABOOM_TICKS_PER_FRAME = 2.5;
const KABOOM_TICKS = KABOOM_FRAMES * KABOOM_TICKS_PER_FRAME;

// Scoring / reward
const SCORE_PER_ALIEN = 20;
const REWARD_KILL = 1;
const REWARD_LIFE_LOST = -1;
const REWARD_CLEAR = 5;
const START_LIVES = 3;
const END_DELAY_TICKS = 90; // 1.5 s of GAME OVER / WAVE CLEARED text before the next round

const SEED = 41027;

interface Alien {
  col: number;
  row: number;
  alive: boolean;
  sprite: Phaser.GameObjects.Sprite;
}
interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  sprite: Phaser.GameObjects.Sprite;
}
interface Explosion {
  age: number;
  sprite: Phaser.GameObjects.Sprite;
}

export class InvadersScene extends GameScene {
  static readonly KEY = 'invaders';

  // Model
  private round = 1;
  private tick = 0;
  private score = 0;
  private lives = START_LIVES;
  private finished = false;
  private endTimer = 0;
  private shipX = WORLD_WIDTH / 2;
  private shipVx = 0; // px/s, smoothed toward move * SHIP_SPEED
  private fireCooldown = 0;
  private hitCooldown = 0;
  private enemyFireTimer = ENEMY_FIRE_TICKS;
  private gridX = GRID_ORIGIN_X;
  private gridY = GRID_ORIGIN_Y;
  private gridDir = 1;
  private gridVx = 0; // px/s, post-bounce, for view extrapolation only
  private rng = new Prng(SEED);
  private aliens: Alien[] = [];
  private bullets: Projectile[] = [];
  private enemyBullets: Projectile[] = [];
  private explosions: Explosion[] = [];
  /** Wall-clock time (performance.now) of the last step(); drives view extrapolation. */
  private lastStepAt = 0;

  // View
  private ship!: Phaser.GameObjects.Sprite;
  private scoreText!: Phaser.GameObjects.Text;
  private lifeIcons: Phaser.GameObjects.Sprite[] = [];
  private bigText!: Phaser.GameObjects.Text;
  private subText!: Phaser.GameObjects.Text;
  private modeText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: InvadersScene.KEY });
  }

  preload() {
    this.load.image(TEX.bullet, '/assets/images/bullet.png');
    this.load.image(TEX.enemyBullet, '/assets/images/enemy-bullet.png');
    this.load.spritesheet(TEX.alien, '/assets/images/invader.png', { frameWidth: 32, frameHeight: 32 });
    this.load.image(TEX.ship, '/assets/images/player.png');
    this.load.spritesheet(TEX.kaboom, '/assets/images/explode.png', { frameWidth: 128, frameHeight: 128 });
    if (SOUND_ENABLED) {
      this.load.audio(SFX.shoot, '/assets/audio/shoot.wav');
      this.load.audio(SFX.kaboom, '/assets/audio/explosion.wav');
      this.load.audio(SFX.invaderKilled, '/assets/audio/invaderkilled.wav');
    }
  }

  create() {
    this.cameras.main.setBackgroundColor('#000000');
    const font = { fontFamily: 'Arial, sans-serif', color: '#ffffff' };
    this.add.text(16, 16, 'SCORE', { ...font, fontSize: '16px' });
    this.scoreText = this.add.text(22, 32, '0000', { ...font, fontSize: '16px' });
    this.add.text(WORLD_WIDTH - 100, 16, 'LIVES', { ...font, fontSize: '16px' });
    this.lifeIcons = [];
    for (let i = 0; i < START_LIVES; i++) {
      const icon = this.add.sprite(WORLD_WIDTH - 100 + 30 * i, 60, TEX.ship).setAngle(90).setAlpha(0.6);
      this.lifeIcons.push(icon);
    }
    this.bigText = this.add.text(WORLD_WIDTH / 2, 320, '', { ...font, fontSize: '36px' }).setOrigin(0.5);
    this.subText = this.add.text(WORLD_WIDTH / 2, 400, '', { ...font, fontSize: '36px' }).setOrigin(0.5);
    this.modeText = this.add
      .text(WORLD_WIDTH / 2, WORLD_HEIGHT - 18, 'NO BRAIN — keyboard: arrows move, space fires', {
        ...font,
        fontSize: '14px',
        color: '#888888',
      })
      .setOrigin(0.5);
    this.ship = this.add.sprite(this.shipX, SHIP_Y, TEX.ship);
    this.setupKeyboard();

    this.aliens = [];
    this.bullets = [];
    this.enemyBullets = [];
    this.explosions = [];
    this.round = 0;
    this.startRound();
    this.onControlModeChanged();
  }

  protected onControlModeChanged() {
    this.modeText.setVisible(!this.brainDriven);
  }

  // ---- Environment -------------------------------------------------------

  reset() {
    this.round = 0;
    this.rng = new Prng(SEED);
    this.startRound();
  }

  state(): GameState {
    return {
      round: this.round,
      tick: this.tick,
      score: this.score,
      lives: this.lives,
      aliens: this.aliveCount(),
      finished: this.finished,
      ship_x: this.shipX / WORLD_WIDTH,
    };
  }

  step(action: Action, dt: number): StepResult {
    this.lastAction = action;
    this.tick += 1;
    this.lastStepAt = performance.now();

    if (this.finished) {
      // Hold the end-of-round text, then start the next round.
      this.endTimer -= 1;
      if (this.endTimer <= 0) this.startRound();
      return { reward: 0 };
    }

    let reward = 0;

    // Ship: velocity relaxes toward the commanded speed so a noisy neural signal that
    // flips sign every tick produces a gentle drift instead of shaking.
    let move = clamp(action.move, -1, 1);
    if (Math.abs(move) < SHIP_DEAD_ZONE) move = 0;
    this.shipVx += (move * SHIP_SPEED - this.shipVx) * (1 - Math.exp(-dt / SHIP_TAU));
    const shipNext = this.shipX + this.shipVx * dt;
    this.shipX = clamp(shipNext, SHIP_MIN_X, SHIP_MAX_X);
    if (this.shipX !== shipNext) this.shipVx = 0; // hit a wall
    if (this.fireCooldown > 0) this.fireCooldown -= 1;
    if (this.hitCooldown > 0) this.hitCooldown -= 1;
    // Classic rule: one player bullet on screen at a time (plus a short cooldown).
    if (action.fire && this.fireCooldown === 0 && this.bullets.length === 0) {
      this.bullets.push({
        x: this.shipX,
        y: SHIP_Y - 18,
        vx: 0,
        vy: -BULLET_SPEED,
        sprite: this.add.sprite(this.shipX, SHIP_Y - 18, TEX.bullet).setOrigin(0.5, 1),
      });
      this.fireCooldown = FIRE_COOLDOWN_TICKS;
      this.play(SFX.shoot);
    }

    // Bullets
    for (const b of this.bullets) b.y += b.vy * dt;
    for (const b of this.enemyBullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }

    // Alien march: side to side, drop a row at the edge, faster as they die.
    const alive = this.aliens.filter((a) => a.alive);
    if (alive.length > 0) {
      let minCol = ALIEN_COLS;
      let maxCol = -1;
      let maxRow = -1;
      for (const a of alive) {
        if (a.col < minCol) minCol = a.col;
        if (a.col > maxCol) maxCol = a.col;
        if (a.row > maxRow) maxRow = a.row;
      }
      const killed = ALIEN_TOTAL - alive.length;
      const speed = ALIEN_BASE_SPEED + (ALIEN_MAX_SPEED - ALIEN_BASE_SPEED) * (killed / (ALIEN_TOTAL - 1));
      this.gridX += this.gridDir * speed * dt;
      const left = this.gridX + minCol * GRID_DX;
      const right = this.gridX + maxCol * GRID_DX;
      if (this.gridDir > 0 && right > ALIEN_MAX_X) {
        this.gridX -= right - ALIEN_MAX_X;
        this.gridDir = -1;
        this.gridY += ALIEN_DROP;
      } else if (this.gridDir < 0 && left < ALIEN_MIN_X) {
        this.gridX += ALIEN_MIN_X - left;
        this.gridDir = 1;
        this.gridY += ALIEN_DROP;
      }
      this.gridVx = this.gridDir * speed;
      if (this.gridY + maxRow * GRID_DY >= ALIEN_INVASION_Y) {
        // Invaded: lose every remaining life.
        reward += REWARD_LIFE_LOST * this.lives;
        this.lives = 0;
      }
    } else {
      this.gridVx = 0;
    }

    // Enemy fire from a random bottom-row alien (seeded), aimed at the ship like the reference.
    this.enemyFireTimer -= 1;
    if (this.enemyFireTimer <= 0 && alive.length > 0) {
      const bottom: Alien[] = [];
      for (let col = 0; col < ALIEN_COLS; col++) {
        let lowest: Alien | null = null;
        for (const a of alive) if (a.col === col && (!lowest || a.row > lowest.row)) lowest = a;
        if (lowest) bottom.push(lowest);
      }
      const shooter = bottom[this.rng.int(0, bottom.length - 1)];
      const x = this.alienX(shooter);
      const y = this.alienY(shooter) + ALIEN_HALF;
      const dx = this.shipX - x;
      const dy = SHIP_Y - y;
      const len = Math.hypot(dx, dy) || 1;
      this.enemyBullets.push({
        x,
        y,
        vx: (dx / len) * ENEMY_BULLET_SPEED,
        vy: (dy / len) * ENEMY_BULLET_SPEED,
        sprite: this.add.sprite(x, y, TEX.enemyBullet),
      });
      this.enemyFireTimer = ENEMY_FIRE_TICKS;
    }

    // Player bullets vs aliens
    const alienRect = new Phaser.Geom.Rectangle();
    const bulletRect = new Phaser.Geom.Rectangle();
    for (const b of this.bullets) {
      bulletRect.setTo(b.x - BULLET_W / 2, b.y - BULLET_H, BULLET_W, BULLET_H);
      for (const a of this.aliens) {
        if (!a.alive) continue;
        alienRect.setTo(this.alienX(a) - ALIEN_HALF, this.alienY(a) - ALIEN_HALF, ALIEN_HALF * 2, ALIEN_HALF * 2);
        if (Phaser.Geom.Intersects.RectangleToRectangle(bulletRect, alienRect)) {
          a.alive = false;
          a.sprite.setVisible(false);
          this.spawnExplosion(alienRect.centerX, alienRect.centerY);
          this.play(SFX.invaderKilled);
          this.score += SCORE_PER_ALIEN;
          reward += REWARD_KILL;
          b.y = -1000; // consumed; culled below
          break;
        }
      }
    }

    // Enemy bullets vs ship
    if (this.hitCooldown === 0 && this.lives > 0) {
      const shipRect = new Phaser.Geom.Rectangle(
        this.shipX - SHIP_HALF_W,
        SHIP_Y - SHIP_HALF_H,
        SHIP_HALF_W * 2,
        SHIP_HALF_H * 2,
      );
      for (const eb of this.enemyBullets) {
        bulletRect.setTo(
          eb.x - ENEMY_BULLET_SIZE / 2,
          eb.y - ENEMY_BULLET_SIZE / 2,
          ENEMY_BULLET_SIZE,
          ENEMY_BULLET_SIZE,
        );
        if (Phaser.Geom.Intersects.RectangleToRectangle(bulletRect, shipRect)) {
          this.lives -= 1;
          reward += REWARD_LIFE_LOST;
          this.hitCooldown = HIT_INVULN_TICKS;
          this.spawnExplosion(this.shipX, SHIP_Y);
          this.play(SFX.kaboom);
          for (const other of this.enemyBullets) other.y = WORLD_HEIGHT + 1000; // clear the volley
          break;
        }
      }
    }

    // Cull projectiles, age explosions
    this.bullets = this.cull(this.bullets, (b) => b.y - BULLET_H > WORLD_HEIGHT || b.y < 0);
    this.enemyBullets = this.cull(
      this.enemyBullets,
      (b) => b.y - ENEMY_BULLET_SIZE > WORLD_HEIGHT || b.y < -50 || b.x < -50 || b.x > WORLD_WIDTH + 50,
    );
    for (const e of this.explosions) e.age += 1;
    this.explosions = this.cull(this.explosions, (e) => e.age >= KABOOM_TICKS);

    // Round end
    let ended: RoundSummary | undefined;
    const remaining = this.aliveCount();
    if (this.lives <= 0) {
      this.lives = 0;
      ended = this.endRound('GAME OVER');
    } else if (remaining === 0) {
      reward += REWARD_CLEAR;
      ended = this.endRound('WAVE CLEARED');
    }

    this.syncView(0);
    return ended ? { reward, ended } : { reward };
  }

  // ---- View ----------------------------------------------------------------

  /** Phaser render frame. Keyboard mode steps here; brain mode only extrapolates the view. */
  update(time: number, delta: number) {
    super.update(time, delta);
    if (!this.brainDriven || !this.viewExtrapolation || this.finished) return;
    const elapsed = (performance.now() - this.lastStepAt) / 1000;
    this.syncView(clamp(elapsed, 0, STEP_DT));
  }

  settleView() {
    this.syncView(0);
  }

  // ---- Internals ---------------------------------------------------------

  private startRound() {
    this.round += 1;
    this.tick = 0;
    this.score = 0;
    this.lives = START_LIVES;
    this.finished = false;
    this.endTimer = 0;
    this.shipX = WORLD_WIDTH / 2;
    this.shipVx = 0;
    this.fireCooldown = 0;
    this.hitCooldown = 0;
    this.enemyFireTimer = ENEMY_FIRE_TICKS;
    this.gridX = GRID_ORIGIN_X;
    this.gridY = GRID_ORIGIN_Y;
    this.gridDir = 1;
    this.gridVx = 0;

    for (const a of this.aliens) a.sprite.destroy();
    for (const b of this.bullets) b.sprite.destroy();
    for (const b of this.enemyBullets) b.sprite.destroy();
    for (const e of this.explosions) e.sprite.destroy();
    this.aliens = [];
    this.bullets = [];
    this.enemyBullets = [];
    this.explosions = [];
    for (let row = 0; row < ALIEN_ROWS; row++) {
      for (let col = 0; col < ALIEN_COLS; col++) {
        const sprite = this.add.sprite(0, 0, TEX.alien, 0);
        this.aliens.push({ col, row, alive: true, sprite });
      }
    }
    this.bigText.setText('');
    this.subText.setText('');
    this.ship.setVisible(true);
    this.syncView(0);
  }

  private endRound(title: string): RoundSummary {
    const summary: RoundSummary = { round: this.round, ticks: this.tick, score: this.score, lives: this.lives };
    this.finished = true;
    this.endTimer = END_DELAY_TICKS;
    this.shipVx = 0;
    this.gridVx = 0;
    this.bigText.setText(title);
    this.subText.setText(`ROUND ${this.round}  SCORE ${this.score}`);
    for (const b of this.bullets) b.sprite.destroy();
    for (const b of this.enemyBullets) b.sprite.destroy();
    this.bullets = [];
    this.enemyBullets = [];
    return summary;
  }

  /**
   * Put every sprite at model position + velocity * ahead. `ahead` is 0 after a step
   * (exact state, what the brain sees) and up to one tick on intermediate render frames.
   */
  private syncView(ahead: number) {
    this.ship.setPosition(clamp(this.shipX + this.shipVx * ahead, SHIP_MIN_X, SHIP_MAX_X), SHIP_Y);
    this.ship.setAlpha(this.hitCooldown > 0 && Math.floor(this.tick / 4) % 2 === 0 ? 0.25 : 1);
    this.ship.setVisible(this.lives > 0 || !this.finished);
    const flyFrame = Math.floor(this.tick / FLY_TICKS_PER_FRAME) % 4;
    for (const a of this.aliens) {
      if (!a.alive) continue;
      a.sprite.setPosition(this.alienX(a) + this.gridVx * ahead, this.alienY(a));
      a.sprite.setFrame(flyFrame);
    }
    for (const b of this.bullets) b.sprite.setPosition(b.x, b.y + b.vy * ahead);
    for (const b of this.enemyBullets) b.sprite.setPosition(b.x + b.vx * ahead, b.y + b.vy * ahead);
    for (const e of this.explosions) {
      const frame = Math.min(KABOOM_FRAMES - 1, Math.floor(e.age / KABOOM_TICKS_PER_FRAME));
      e.sprite.setFrame(frame);
    }
    this.scoreText.setText(String(this.score).padStart(4, '0'));
    this.lifeIcons.forEach((icon, i) => icon.setVisible(i < this.lives));
  }

  private spawnExplosion(x: number, y: number) {
    this.explosions.push({ age: 0, sprite: this.add.sprite(x, y, TEX.kaboom, 0) });
  }

  private cull<T extends { sprite: Phaser.GameObjects.Sprite }>(items: T[], dead: (item: T) => boolean): T[] {
    const keep: T[] = [];
    for (const item of items) {
      if (dead(item)) item.sprite.destroy();
      else keep.push(item);
    }
    return keep;
  }

  private alienX(a: Alien) {
    return this.gridX + a.col * GRID_DX;
  }
  private alienY(a: Alien) {
    return this.gridY + a.row * GRID_DY;
  }
  private aliveCount() {
    let n = 0;
    for (const a of this.aliens) if (a.alive) n++;
    return n;
  }
  private play(key: string) {
    if (SOUND_ENABLED) this.sound.play(key);
  }
}
