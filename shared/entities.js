/**
 * 實體邏輯模組 (Player, Bullet, HomingMissile, Enemy, Bell, BombWave)
 *
 * 本檔只保留「遊戲規則」：移動、碰撞資料、傷害結算、狀態機。
 * 繪圖全數移至 [js/render.js](../js/render.js)，音效與粒子改為對 fx sink 送事件，
 * 因此本檔零 DOM、零 Web Audio，可被 Node 權威伺服器直接 require()。
 *
 * fx sink 介面（客戶端為 FXManager，伺服器為事件收集器）：
 *   sound(name)                              音效事件
 *   spawnExplosion(x, y, color, count, spd)  爆炸粒子
 *   spawnFloatText(x, y, text, color)        浮動文字
 *   spawnSmoke(x, y, count)                  煙霧尾跡
 *   shake(duration, intensity)               螢幕震動
 */

// Node 下把姊妹模組掛上 globalThis，本檔內的 MathUtil / VIEW 寫法與瀏覽器完全一致。
// 探測 module 而非探測 MathUtil 是否存在：後者會被呼叫端全域同名 const 的 TDZ 誤判成
// ReferenceError（`typeof` 對 TDZ 中的綁定並不安全）。
// ponytail: one-liner: 同一份檔案同時餵瀏覽器 <script> 與 Node require()
// upgrade if: 專案導入打包工具，屆時全面改 ESM import
if (typeof module !== 'undefined' && module.exports) {
  Object.assign(globalThis, require('./math.js'));
}

// 玩家戰機 (融合雷電戰機外觀與小蜜蜂機動感)
class Player {
  // 陣亡到重生的等待秒數。開放大廳不能讓人乾等，但也不能死了毫無代價
  static RESPAWN_DELAY = 3.0;

  constructor(canvasWidth, canvasHeight) {
    this.cw = canvasWidth;
    this.ch = canvasHeight;
    this.reset();
  }

  reset() {
    this.x = this.cw / 2;
    this.y = this.ch - 60;
    this.baseSpeed = 280;
    this.speed = this.baseSpeed;
    this.radius = 14;
    this.lives = 3;
    this.bombs = 2;
    this.shields = 0; // 護盾層數 (兵蜂紅鈴鐺)
    this.weaponLevel = 1; // 火力等級 1 ~ 4 (雷電主砲升級)
    this.invulnerableTime = 0; // 無敵閃爍時間
    this.respawnTimer = 0;     // 陣亡後的重生倒數；> 0 時不可操作、不參與碰撞、不渲染
    this.fireCooldown = 0;
    this.missileTimer = 0;

    // 大蜜蜂 (Galaga) 傳奇機制：雙機合體與被俘狀態
    this.isDual = false;
    this.beingCaptured = false;
    this.captureTimer = 0;
    this.captureAngle = 0;
    this.capturedBy = null;

    // 遠端玩家專用：網路送達的權威座標
    this.targetX = this.x;
    this.targetY = this.y;
  }

  // 遠端玩家：朝權威座標平滑靠攏，補齊 40ms 封包間隔之間的空檔
  interpolateTo(dt) {
    const k = Math.min(1, 14 * dt);
    this.x += (this.targetX - this.x) * k;
    this.y += (this.targetY - this.y) * k;
  }

  update(dt, input) {
    // 若處於被母艦光束牽引吸取狀態，自旋並向上被吸入
    if (this.beingCaptured) {
      this.captureTimer += dt;
      this.captureAngle += dt * 14;
      if (this.capturedBy && this.capturedBy.alive) {
        const targetX = this.capturedBy.x;
        const targetY = this.capturedBy.y + 15;
        this.x += (targetX - this.x) * 4.2 * dt;
        this.y += (targetY - this.y) * 4.2 * dt;
      }
      return;
    }

    // 無敵倒數
    if (this.invulnerableTime > 0) {
      this.invulnerableTime -= dt;
    }

    // 冷卻計時
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    // 鍵盤移動
    let dx = 0;
    let dy = 0;
    if (input.isLeft()) dx -= 1;
    if (input.isRight()) dx += 1;
    if (input.isUp()) dy -= 1;
    if (input.isDown()) dy += 1;

    if (dx !== 0 && dy !== 0) {
      dx *= 0.7071;
      dy *= 0.7071;
    }

    this.x += dx * this.speed * dt;
    this.y += dy * this.speed * dt;

    // 觸控 / 滑鼠直接跟隨 (保留直覺操作)
    // 遠端玩家以合成 input 驅動、不帶 pointer，故此處必須容忍缺席
    // ponytail: native: optional chaining | upgrade if: 需區分「無 pointer」與「pointer 閒置」再拆型別
    if (input.pointer?.isDown) {
      const targetX = input.pointer.x;
      const targetY = input.pointer.y - 40; // 稍微在手指上方避免遮擋
      this.x += (targetX - this.x) * 12 * dt;
      this.y += (targetY - this.y) * 12 * dt;
    }

    // 螢幕邊界限制 (若雙機合體則寬度略增)
    const boundMargin = this.isDual ? 32 : 22;
    this.x = MathUtil.clamp(this.x, boundMargin, this.cw - boundMargin);
    this.y = MathUtil.clamp(this.y, 40, this.ch - 30);
  }

  // 發射主武器 (雙機合體時產生雙倍彈幕面寬)
  fire(bulletList, fx) {
    if (this.beingCaptured) return;
    if (this.fireCooldown > 0) return;
    this.fireCooldown = 0.13; // 高射速

    const spawnFire = (cx) => {
      const bx = cx;
      const by = this.y - 18;

      if (this.weaponLevel === 1) {
        // 單發強力雷射
        bulletList.push(new Bullet(bx, by, 0, -560, 'vulcan', 1));
      } else if (this.weaponLevel === 2) {
        // 雙聯平射砲
        bulletList.push(new Bullet(bx - 8, by, 0, -580, 'vulcan', 1));
        bulletList.push(new Bullet(bx + 8, by, 0, -580, 'vulcan', 1));
      } else if (this.weaponLevel === 3) {
        // 雙聯砲 + 兩側扇形散射 (雷電風格)
        //
        // 前兩發刻意與 Lv2 完全相同：Lv3 的彈幕是 Lv2 的超集，升級不可能變弱。
        // 原本是「單發 damage 1.2 + 兩發側彈」，但側彈打遠距離的單一大型目標（Boss）
        // 會從兩側飛過，只有中央彈命中；而單發集中彈對擺盪中的目標命中率又低於
        // 兩發並排彈（Boss 以 ±35px 擺盪，子彈飛行約 0.8 秒期間已移開約 50px）。
        // 結果是吃白鈴鐺從 Lv2 升 Lv3，對 Boss 的實際輸出反而下降。
        bulletList.push(new Bullet(bx - 8, by, 0, -600, 'vulcan', 1));
        bulletList.push(new Bullet(bx + 8, by, 0, -600, 'vulcan', 1));
        bulletList.push(new Bullet(bx - 10, by, -110, -580, 'vulcan', 1));
        bulletList.push(new Bullet(bx + 10, by, 110, -580, 'vulcan', 1));
      } else {
        // 5 向全裝備重火力 (雷電最高階擴散 + 穿透)
        bulletList.push(new Bullet(bx, by, 0, -640, 'laser', 2, true));
        bulletList.push(new Bullet(bx - 8, by, -90, -600, 'vulcan', 1));
        bulletList.push(new Bullet(bx + 8, by, 90, -600, 'vulcan', 1));
        bulletList.push(new Bullet(bx - 16, by, -180, -550, 'vulcan', 1));
        bulletList.push(new Bullet(bx + 16, by, 180, -550, 'vulcan', 1));
      }
    };

    if (this.isDual) {
      spawnFire(this.x - 16);
      spawnFire(this.x + 16);
    } else {
      spawnFire(this.x);
    }

    fx.sound(this.weaponLevel >= 4 ? 'heavyLaser' : 'shoot');
  }

  // 雷電副武器：追蹤飛彈自動定時發射
  updateMissiles(dt, missileList, fx) {
    if (this.beingCaptured || this.weaponLevel < 2) return;
    this.missileTimer += dt;
    if (this.missileTimer >= 0.85) {
      this.missileTimer = 0;
      if (this.isDual) {
        missileList.push(new HomingMissile(this.x - 26, this.y - 4, -Math.PI * 0.65));
        missileList.push(new HomingMissile(this.x - 8, this.y - 4, -Math.PI * 0.55));
        missileList.push(new HomingMissile(this.x + 8, this.y - 4, -Math.PI * 0.45));
        missileList.push(new HomingMissile(this.x + 26, this.y - 4, -Math.PI * 0.35));
      } else {
        missileList.push(new HomingMissile(this.x - 14, this.y - 4, -Math.PI * 0.62));
        missileList.push(new HomingMissile(this.x + 14, this.y - 4, -Math.PI * 0.38));
      }
      fx.sound('missileLaunch');
    }
  }

  // 受傷判定 (雙機中彈抵擋一次致命傷)
  hit(fx) {
    if (this.invulnerableTime > 0 || this.beingCaptured) return false;

    // 護盾吸收 (兵蜂特色)
    if (this.shields > 0) {
      this.shields--;
      this.invulnerableTime = 1.2;
      // 護盾一律使用 HUD 的 SHIELD 綠 (--accent-green)，與光環／HUD 同語意
      fx.spawnExplosion(this.x, this.y, '#2ed573', 20, 180);
      fx.sound('shieldBreak');
      fx.spawnFloatText(this.x, this.y - 20, 'SHIELD LOST', '#2ed573');
      return false;
    }

    // 雙機合體防禦破壞 (一側戰機爆毀，退回單機狀態)
    if (this.isDual) {
      this.isDual = false;
      this.invulnerableTime = 1.8;
      fx.spawnExplosion(this.x + 16, this.y, '#ff4757', 25, 200);
      fx.shake(0.3, 11);
      fx.sound('playerHit');
      fx.spawnFloatText(this.x, this.y - 25, 'DUAL LOST!', '#ff4757');
      return false; // 戰機仍存活，未扣除生命
    }

    this.lives--;
    this.weaponLevel = Math.max(1, this.weaponLevel - 1);
    this.speed = this.baseSpeed;
    // 陣亡後先進入重生倒數；歸位與無敵時間等倒數結束才給（見 World.update）
    this.respawnTimer = Player.RESPAWN_DELAY;
    this.invulnerableTime = 0;

    fx.spawnExplosion(this.x, this.y, '#ff4757', 35, 240);
    fx.shake(0.35, 10);
    fx.sound('playerHit');

    return true;
  }

  /** 是否在場上：陣亡倒數中與命盡觀戰者都不算 */
  get isActive() {
    return this.lives > 0 && this.respawnTimer <= 0;
  }

  /** 重生倒數結束：歸位、給無敵 */
  respawn() {
    this.respawnTimer = 0;
    this.invulnerableTime = 2.5;
    this.x = this.targetX = this.cw / 2;
    this.y = this.targetY = this.ch - 60;
  }
}

// 子彈實體
class Bullet {
  constructor(x, y, vx, vy, type = 'vulcan', damage = 1, piercing = false) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.type = type;
    this.damage = damage;
    this.piercing = piercing;
    this.radius = type === 'laser' ? 6 : 4;
    this.alive = true;
    // 穿透彈會連續數十幀重疊同一目標，需記錄已命中者避免每步重複扣血
    this.hitTargets = piercing ? new Set() : null;
  }

  // 同一目標只結算一次；非穿透彈由呼叫端在命中後標記 alive = false
  canHit(target) {
    if (!this.hitTargets) return true;
    if (this.hitTargets.has(target)) return false;
    this.hitTargets.add(target);
    return true;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.y < -VIEW.margin || this.y > VIEW.height + VIEW.margin ||
        this.x < -VIEW.margin || this.x > VIEW.width + VIEW.margin) {
      this.alive = false;
    }
  }
}

// 雷電追蹤飛彈：自動搜尋最近的存活敵機並修正航向
class HomingMissile {
  constructor(x, y, angle = -Math.PI / 2) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * 260;
    this.vy = Math.sin(angle) * 260;
    this.speed = 260;
    this.turnRate = 4.8;
    this.radius = 5;
    this.damage = 2;
    this.alive = true;
    this.life = 4.0;
    this.target = null;
    this.retargetTimer = 0;
    this.smokeTimer = 0;
  }

  update(dt, enemies, fx) {
    if (!this.alive) return;
    this.life -= dt;
    if (this.life <= 0) {
      this.alive = false;
      return;
    }

    // 每 0.12 秒才重選目標：省下每幀掃全場，也避免最近目標跳動導致航跡抖動
    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0 || !this.target || !this.target.alive) {
      this.retargetTimer = 0.12;
      let bestDist = Infinity;
      let found = null;
      enemies.forEach((enemy) => {
        if (!enemy.alive) return;
        const dist = MathUtil.dist(this.x, this.y, enemy.x, enemy.y);
        if (dist < bestDist) {
          bestDist = dist;
          found = enemy;
        }
      });
      this.target = found;
    }

    if (this.target && this.target.alive) {
      const desired = Math.atan2(this.target.y - this.y, this.target.x - this.x);
      const current = Math.atan2(this.vy, this.vx);
      let delta = desired - current;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const next = current + MathUtil.clamp(delta, -this.turnRate * dt, this.turnRate * dt);
      this.vx = Math.cos(next) * this.speed;
      this.vy = Math.sin(next) * this.speed;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // 尾跡改為時間驅動，粒子量不再隨螢幕更新率浮動
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0) {
      this.smokeTimer = 0.03;
      fx.spawnSmoke(this.x, this.y + 5, 1);
    }

    if (this.x < -VIEW.margin || this.x > VIEW.width + VIEW.margin ||
        this.y < -VIEW.margin || this.y > VIEW.height + VIEW.margin) {
      this.alive = false;
    }
  }
}

// 小蜜蜂敵機 (支援隊形編隊與貝茲曲線俯衝 AI)
class Enemy {
  /**
   * Boss 基礎 HP（再乘上開場人數）。
   *
   * 由 headless TTK 量測回推而非憑感覺填：單人 Lv4 的穩態輸出只有約 15 dps
   * （Boss 半徑 34、距離 475px，5 向散彈的側彈全數飛過兩側，實際命中的僅中央
   * 穿透雷射；飛彈開場先被 2 架 guard 吃掉），要打到 20~30 秒就需要這個量級。
   * 舊值 24 會在 2.3 秒內蒸發，首領戰形同不存在。
   */
  static BOSS_BASE_HP = 520;

  /**
   * Boss 彈幕階段表：剩餘血量越低，彈數越多、間隔越短、彈速越快。
   *
   * 二十多秒的首領戰若全程同一套 3 向散射會很單調，分階段讓壓力隨戰局爬升。
   * 沿用既有的「朝玩家扇形散射」機制，不引入新彈種——環形彈幕、可破壞砲塔、
   * 核心爆破是 T-010 的未完項，不在平衡調校的範圍內。
   * 查表以「剩餘血量比大於門檻」命中，故需由高門檻往低排列。
   */
  static BOSS_PHASES = [
    { hpRatio: 0.66, spread: [-0.16, 0, 0.16],                     interval: 0.75, speed: 250 },
    { hpRatio: 0.33, spread: [-0.32, -0.16, 0, 0.16, 0.32],        interval: 0.60, speed: 275 },
    { hpRatio: 0,    spread: [-0.32, -0.16, 0, 0.16, 0.32],        interval: 0.45, speed: 300 }
  ];

  constructor(type, col, row, baseX, baseY) {
    this.type = type; // 'drone' | 'guard' | 'boss' | 'carrier'
    this.col = col;
    this.row = row;
    this.formationX = baseX;
    this.formationY = baseY;
    this.x = baseX;
    this.y = baseY;
    this.radius = type === 'boss' ? 34 : (type === 'carrier' ? 15 : 12);
    this.alive = true;

    // 魔王外觀隨機化：每次進入魔王關重新抽選一種造型
    this.bossStyle = type === 'boss' ? Math.floor(Math.random() * 4) : 0;

    // 屬性設定
    this.maxHp = type === 'boss' ? Enemy.BOSS_BASE_HP : (type === 'carrier' ? 2 : 1);
    this.hp = this.maxHp;
    this.scoreValue = type === 'boss' ? 3000 : (type === 'guard' ? 180 : 100);

    // AI 狀態機: 'FORMATION' | 'DIVING' | 'RETURNING'
    this.state = 'FORMATION';
    this.diveTime = 0;
    this.diveDuration = 2.4;
    this.divePath = null;
    this.angle = 0;
    this.fireTimer = Math.random() * 2;
  }

  // 啟動貝茲曲線俯衝軌跡
  startDive(playerX, playerY, cw, ch) {
    if (this.state !== 'FORMATION') return;
    this.state = 'DIVING';
    this.diveTime = 0;
    this.diveDuration = 2.2 + Math.random() * 0.6;

    // 起點
    const p0 = { x: this.x, y: this.y };
    // 向上環繞控制點
    const loopDir = (this.col % 2 === 0 ? 1 : -1);
    const p1 = { x: this.x + loopDir * 90, y: Math.max(20, this.y - 60) };
    // 鎖定玩家位置衝鋒控制點
    const p2 = { x: playerX + (Math.random() - 0.5) * 60, y: playerY - 120 };
    // 貫穿螢幕下方終點
    const p3 = { x: playerX + loopDir * 80, y: ch + 50 };

    this.divePath = { p0, p1, p2, p3 };
  }

  update(dt, swarmOffset, player, enemyBullets, cw, ch) {
    if (!this.alive) return;

    if (this.state === 'FORMATION') {
      // 跟隨蜂群整體擺動 (Breathing & Sway)
      this.x = this.formationX + swarmOffset.x;
      this.y = this.formationY + swarmOffset.y;
      this.angle = 0;

      // 魔王關 Boss 固定在場中央附近，並持續向玩家發射彈幕
      if (this.type === 'boss') {
        this.fireTimer -= dt;
        if (this.fireTimer <= 0) {
          const phase = this.bossPhase();
          this.fireTimer = phase.interval;
          const angleToPlayer = Math.atan2(player.y - this.y, player.x - this.x);
          phase.spread.forEach(offset => {
            const angle = angleToPlayer + offset;
            enemyBullets.push(new Bullet(
              this.x,
              this.y + 22,
              Math.cos(angle) * phase.speed,
              Math.sin(angle) * phase.speed,
              'enemy'
            ));
          });
        }
      }
    } else if (this.state === 'DIVING') {
      this.diveTime += dt;
      const t = this.diveTime / this.diveDuration;

      if (t <= 1.0 && this.divePath) {
        const prevPos = { x: this.x, y: this.y };
        const pos = MathUtil.cubicBezier(
          this.divePath.p0,
          this.divePath.p1,
          this.divePath.p2,
          this.divePath.p3,
          t
        );
        this.x = pos.x;
        this.y = pos.y;

        // 計算朝向旋轉角度
        const dx = this.x - prevPos.x;
        const dy = this.y - prevPos.y;
        if (Math.hypot(dx, dy) > 0.1) {
          this.angle = Math.atan2(dy, dx) - Math.PI / 2;
        }

        // 俯衝途中朝玩家開火
        this.fireTimer -= dt;
        if (this.fireTimer <= 0 && this.y < player.y - 50) {
          this.fireTimer = 1.0;
          const angleToPlayer = Math.atan2(player.y - this.y, player.x - this.x);
          const bspd = 220;
          enemyBullets.push(new Bullet(
            this.x,
            this.y + 10,
            Math.cos(angleToPlayer) * bspd,
            Math.sin(angleToPlayer) * bspd,
            'enemy'
          ));
        }
      } else {
        // 飛出螢幕底端後，轉入歸隊狀態（從螢幕頂部落下）
        this.state = 'RETURNING';
        this.x = this.formationX + swarmOffset.x;
        this.y = -30;
      }
    } else if (this.state === 'RETURNING') {
      // 緩慢返回編隊目標點
      const targetX = this.formationX + swarmOffset.x;
      const targetY = this.formationY + swarmOffset.y;
      this.x += (targetX - this.x) * 4 * dt;
      this.y += (targetY - this.y) * 4 * dt;
      this.angle = 0;

      if (Math.hypot(targetX - this.x, targetY - this.y) < 5) {
        this.state = 'FORMATION';
      }
    }
  }

  /** 依剩餘血量比選出當前彈幕階段（血量歸零時落在最後一階） */
  bossPhase() {
    const ratio = this.hp / this.maxHp;
    return Enemy.BOSS_PHASES.find(p => ratio > p.hpRatio)
      || Enemy.BOSS_PHASES[Enemy.BOSS_PHASES.length - 1];
  }

  takeDamage(amount) {
    this.hp -= amount;
    return this.hp <= 0;
  }
}

// 鈴鐺顏色與屬性狀態機（單一事實來源：實體邏輯與精靈快取共用）
// 0: 黃 (加分) / 1: 藍 (加速) / 2: 白 (火力升級) / 3: 紅 (防護罩) / 4: 綠 (補給炸彈)
const BELL_TYPES = [
  { name: 'YELLOW', color: '#ffd32a', label: '1000 PTS' },
  { name: 'BLUE',   color: '#3fe2ff', label: 'SPEED UP' },
  { name: 'WHITE',  color: '#ffffff', label: 'WEAPON UP' },
  { name: 'RED',    color: '#ff4757', label: 'SHIELD' },
  { name: 'GREEN',  color: '#2ed573', label: 'BOMB +1' }
];

// 兵蜂 (TwinBee) 特色浮空鈴鐺
class Bell {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.vx = (Math.random() - 0.5) * 40;
    this.vy = -70; // 初始拋起
    this.radius = 13;
    this.alive = true;

    this.typeIndex = 0;
    this.types = BELL_TYPES;
    this.hitCount = 0;
    this.age = 0; // 晃動相位來源；用自身壽命而非 Date.now()，暫停時才會一起凍結
  }

  // 被玩家子彈射擊：向上彈跳並切換顏色
  juggle(fx) {
    this.vy = -200; // 向上反彈
    this.hitCount++;
    this.typeIndex = (this.typeIndex + 1) % this.types.length;
    fx.sound('bellHit');
  }

  update(dt) {
    this.age += dt;
    this.vy += 120 * dt; // 輕重力緩緩下落
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // 以自身半徑貼齊畫布左右緣反彈，不再讓鈴鐺跑出右側 20px
    if (this.x < this.radius) {
      this.x = this.radius;
      this.vx = Math.abs(this.vx);
    } else if (this.x > VIEW.width - this.radius) {
      this.x = VIEW.width - this.radius;
      this.vx = -Math.abs(this.vx);
    }
    if (this.y > VIEW.height + VIEW.margin) this.alive = false;
  }
}

// 雷電 (Raiden) 全螢幕清屏爆風炸彈
class BombWave {
  // 預設半徑需涵蓋畫布對角線，否則從底部施放時打不到頂端編隊，「全螢幕」名不副實
  // 發射音效由呼叫端負責：建構子保持無副作用，伺服器端才能安靜地生成衝擊波
  constructor(x, y, maxRadius = Math.hypot(VIEW.width, VIEW.height)) {
    this.x = x;
    this.y = y;
    this.currentRadius = 10;
    this.maxRadius = maxRadius;
    this.speed = 460;
    this.alive = true;
  }

  // 回傳「本次衝擊打死的敵機」，由呼叫端統一結算加分／掉落／Boss 判定
  update(dt, enemies, enemyBullets, fx) {
    this.currentRadius += this.speed * dt;
    const killed = [];

    // 清除覆蓋範圍內的所有敵方子彈 (雷電護命核心)
    for (let i = enemyBullets.length - 1; i >= 0; i--) {
      const eb = enemyBullets[i];
      if (MathUtil.dist(this.x, this.y, eb.x, eb.y) <= this.currentRadius + 15) {
        fx.spawnExplosion(eb.x, eb.y, '#ffd32a', 6, 80);
        enemyBullets.splice(i, 1);
      }
    }

    // 對衝擊波範圍內的敵機造成持續重創；先前此處丟棄了 takeDamage 的回傳值，
    // 導致 HP 歸零的敵機仍維持 alive = true，炸彈實際上殺不死任何東西。
    enemies.forEach((enemy) => {
      if (enemy.alive && MathUtil.dist(this.x, this.y, enemy.x, enemy.y) <= this.currentRadius) {
        if (enemy.takeDamage(10 * dt)) killed.push(enemy);
      }
    });

    if (this.currentRadius >= this.maxRadius) {
      this.alive = false;
    }
    return killed;
  }
}

// ponytail: one-liner: 同一份檔案同時餵瀏覽器 <script> 與 Node require()
// upgrade if: 專案導入打包工具，屆時全面改 ESM export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Player, Bullet, HomingMissile, Enemy, Bell, BombWave, BELL_TYPES };
}
