/**
 * 核心引擎模組 (Input, Particles, Starfield) — 瀏覽器專屬
 * 遵循 Ponytail-ZH 原生極簡原則：純原生 JS，無第三方函式庫。
 *
 * 數學與視界常數已移至 [shared/math.js](../shared/math.js)，
 * 精靈烘焙與實體繪圖已移至 [js/render.js](render.js)，本檔只留客戶端專屬能力。
 */

// 輸入管理器
class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = {};
    this.pointer = { x: 0, y: 0, isDown: false };
    this.fireRequested = false;
    this.bombRequested = false;
    this.pauseRequested = false;
    this.setupListeners();
  }

  setupListeners() {
    // 鍵盤監聽（按鍵即喚醒 Web Audio API）
    window.addEventListener('keydown', (e) => {
      soundEngine.init();
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyP', 'KeyJ', 'KeyK'].includes(e.code)) {
        e.preventDefault();
      }
      this.keys[e.code] = true;

      if (e.code === 'KeyP' && !e.repeat) {
        this.pauseRequested = true;
      }
      if ((e.code === 'Space' || e.code === 'KeyJ') && !e.repeat) {
        this.fireRequested = true;
      }
      if ((e.code === 'KeyB' || e.code === 'KeyK') && !e.repeat) {
        this.bombRequested = true;
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
    });

    // 指標 / 觸控控制
    const getPos = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      const pos = getPos(e);
      this.pointer.x = pos.x;
      this.pointer.y = pos.y;
      this.pointer.isDown = true;
      this.fireRequested = true;
      soundEngine.init();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.pointer.isDown) {
        const pos = getPos(e);
        this.pointer.x = pos.x;
        this.pointer.y = pos.y;
      }
    });

    const endPointer = () => {
      this.pointer.isDown = false;
    };
    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', endPointer);
  }

  isLeft() {
    return !!(this.keys['ArrowLeft'] || this.keys['KeyA']);
  }
  isRight() {
    return !!(this.keys['ArrowRight'] || this.keys['KeyD']);
  }
  isUp() {
    return !!(this.keys['ArrowUp'] || this.keys['KeyW']);
  }
  isDown() {
    return !!(this.keys['ArrowDown'] || this.keys['KeyS']);
  }
  isFiring() {
    return !!(this.keys['Space'] || this.keys['KeyJ'] || this.pointer.isDown);
  }
}

// 視差星空背景
class Starfield {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.layers = [
      { speed: 25, count: 35, size: 1, color: '#384d75', stars: [] },
      { speed: 60, count: 25, size: 1.5, color: '#7799cc', stars: [] },
      { speed: 120, count: 15, size: 2, color: '#dbeaff', stars: [] }
    ];
    this.init();
  }

  init() {
    this.layers.forEach((layer) => {
      layer.stars = [];
      for (let i = 0; i < layer.count; i++) {
        layer.stars.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          brightness: 0.5 + Math.random() * 0.5
        });
      }
    });
  }

  update(dt) {
    this.layers.forEach((layer) => {
      const dy = layer.speed * dt;
      layer.stars.forEach((star) => {
        star.y += dy;
        if (star.y > this.height) {
          star.y = 0;
          star.x = Math.random() * this.width;
        }
      });
    });
  }

  draw(ctx) {
    ctx.fillStyle = '#03050c';
    ctx.fillRect(0, 0, this.width, this.height);

    this.layers.forEach((layer) => {
      layer.stars.forEach((star) => {
        ctx.fillStyle = layer.color;
        ctx.globalAlpha = star.brightness;
        ctx.fillRect(star.x, star.y, layer.size, layer.size);
      });
    });
    ctx.globalAlpha = 1.0;
  }
}

// 粒子與特效管理
// 同時擔任 shared/entities.js 的 fx sink：邏輯層只送事件名，由此處轉譯成實際播放呼叫，
// 伺服器端改注入自己的收集器即可，邏輯層因此完全不認識 soundEngine。
class FXManager {
  // 邏輯層送出的事件名 → soundEngine 方法名
  static SOUNDS = {
    shoot: 'playShoot',
    heavyLaser: 'playHeavyLaser',
    missileLaunch: 'playMissileLaunch',
    playerHit: 'playPlayerHit',
    shieldBreak: 'playShieldBreak',
    bellHit: 'playBellHit',
    bellCollect: 'playBellCollect',
    bomb: 'playBomb',
    explosion: 'playExplosion',
    stageClear: 'playStageClear',
    gameOver: 'playGameOver',
    warning: 'playWarning',
    bossMusicStart: 'startBossMusic',
    bossMusicStop: 'stopBossMusic'
  };

  constructor() {
    this.particles = [];
    this.floatingTexts = [];
    this.shakeTime = 0;
    this.shakeIntensity = 0;
  }

  sound(name) {
    // Boss 爆炸沿用同一支 playExplosion，靠 isLarge 參數區分音色
    if (name === 'explosionBoss') return soundEngine.playExplosion(true);
    const method = FXManager.SOUNDS[name];
    if (method) soundEngine[method]();
  }

  /** 套用伺服器送來的事件序列（線上模式）；本地模式的 fx 已即時作用，不會走這裡 */
  applyEvents(events) {
    events.forEach(ev => {
      if (ev.e === 'sound') this.sound(ev.n);
      else if (ev.e === 'boom') this.spawnExplosion(ev.x, ev.y, ev.c, ev.n, ev.s);
      else if (ev.e === 'text') this.spawnFloatText(ev.x, ev.y, ev.t, ev.c);
      else if (ev.e === 'smoke') this.spawnSmoke(ev.x, ev.y, ev.n);
      else if (ev.e === 'shake') this.shake(ev.d, ev.i);
    });
  }

  shake(duration = 0.25, intensity = 8) {
    this.shakeTime = duration;
    this.shakeIntensity = intensity;
  }

  // 爆炸火花
  spawnExplosion(x, y, color = '#ff9f43', count = 16, speed = 140) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        color,
        size: 2 + Math.random() * 3,
        life: 0.35 + Math.random() * 0.25,
        maxLife: 0.6
      });
    }
  }

  // 浮動分數提示
  spawnFloatText(x, y, text, color = '#ffd32a') {
    this.floatingTexts.push({
      x,
      y,
      text,
      color,
      vy: -50,
      life: 0.7,
      maxLife: 0.7
    });
  }

  // 飛彈推進煙霧尾跡 (雷電特色)
  spawnSmoke(x, y, count = 2) {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * 4,
        y: y + (Math.random() - 0.5) * 4,
        vx: (Math.random() - 0.5) * 15,
        vy: 20 + Math.random() * 20,
        color: Math.random() > 0.5 ? '#e0eafc' : '#a1b2c9',
        size: 2 + Math.random() * 2.5,
        life: 0.22 + Math.random() * 0.15,
        maxLife: 0.37
      });
    }
  }

  update(dt) {
    // 螢幕震動
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
    }

    // 更新粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 40 * dt; // 微重力
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }

    // 更新浮動文字
    for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
      const ft = this.floatingTexts[i];
      ft.y += ft.vy * dt;
      ft.life -= dt;
      if (ft.life <= 0) {
        this.floatingTexts.splice(i, 1);
      }
    }
  }

  draw(ctx) {
    // 繪製粒子
    this.particles.forEach((p) => {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });

    // 繪製浮動文字
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    this.floatingTexts.forEach((ft) => {
      ctx.fillStyle = ft.color;
      ctx.globalAlpha = Math.max(0, ft.life / ft.maxLife);
      ctx.fillText(ft.text, ft.x, ft.y);
    });

    ctx.globalAlpha = 1.0;
  }

  applyShake(ctx) {
    if (this.shakeTime > 0) {
      const ox = (Math.random() * 2 - 1) * this.shakeIntensity;
      const oy = (Math.random() * 2 - 1) * this.shakeIntensity;
      ctx.translate(ox, oy);
    }
  }
}
