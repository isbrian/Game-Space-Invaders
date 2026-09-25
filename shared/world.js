/**
 * 世界模擬（權威邏輯層）
 *
 * 承載一個房間內的完整遊戲規則：關卡生成、敵群 AI、六組碰撞、計分、過關推進。
 * 與 [shared/entities.js](entities.js) 同樣零 DOM、零 Web Audio，
 * 由 Node 權威伺服器以 60Hz 驅動，客戶端本地單人房亦可驅動同一份規則。
 *
 * 移植自改造前 js/game.js 的 update() 迴圈，差異只有三點：
 *   1. 單一 player 改為 players Map，支援最多 8 人同場
 *   2. 音效與粒子改為對 fx sink 送事件（見 shared/entities.js 檔頭）
 *   3. 移動採客戶端權威：不跑 Player.update()，改由 applyInput() 校驗後直接採用座標
 */

// 探測環境而非探測符號：見 shared/entities.js 同段註解
if (typeof module !== 'undefined' && module.exports) {
  Object.assign(globalThis, require('./math.js'), require('./entities.js'));
}

// 伺服器配發的戰機顏色池：同一房間內絕不重複
const PLAYER_COLORS = [
  { name: '青藍', hex: '#3fe2ff' },
  { name: '粉紅', hex: '#ff5fa2' },
  { name: '黃',   hex: '#ffd32a' },
  { name: '綠',   hex: '#2ed573' },
  { name: '紫',   hex: '#a55eea' },
  { name: '橘',   hex: '#ff7f50' },
  { name: '紅',   hex: '#ff4757' },
  { name: '白',   hex: '#ffffff' }
];

const MAX_PLAYERS = PLAYER_COLORS.length;

class World {
  constructor() {
    this.level = 1;
    this.state = 'PLAYING'; // 'PLAYING' | 'STAGECLEAR'
    this.players = new Map(); // id -> Player（附掛 score / color / nick / input）

    this.bullets = [];
    this.enemyBullets = [];
    this.enemies = [];
    this.bells = [];
    this.bombWaves = [];
    this.missiles = [];

    // 蜂群編隊擺動參數 (小蜜蜂特色)
    this.swarmOffset = { x: 0, y: 0 };
    this.swarmTimer = 0;
    this.diveTimer = 0;
    this.diveInterval = 2.0;

    this.isBossStage = false;
    this.stageClearTimer = 0;

    // 每關開場結算一次的人數，關內不再重算（避免 Boss 血條中途跳動）
    this.stageScale = 1;

    this.tick = 0;
    // 實體流水號：客戶端靠它在 20Hz 快照之間認出「同一架敵機」才能做內插，
    // 否則每次快照都是一批無從對應的新座標，畫面會抖。
    this.entitySeq = 0;
  }

  nextEntityId() {
    return ++this.entitySeq;
  }

  // ── 玩家進出 ────────────────────────────────────────────

  addPlayer(id, { nick = '', colorIndex = 0 } = {}) {
    const player = new Player(VIEW.width, VIEW.height);
    player.id = id;
    player.nick = nick;
    player.colorIndex = colorIndex;
    player.playerColor = PLAYER_COLORS[colorIndex].hex;
    player.score = 0;
    player.invulnerableTime = 3.0; // 中途加入者的進場保護
    // 多人同場時錯開初始站位，避免 8 台戰機完全重疊
    player.x = player.targetX = VIEW.width / 2 + (this.players.size - 3.5) * 40;
    player.y = player.targetY = VIEW.height - 60;
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  /** 場上可被瞄準、可被擊中的玩家（不含重生倒數中與命盡觀戰者） */
  alivePlayers() {
    return [...this.players.values()].filter(p => p.isActive);
  }

  /** 命盡的觀戰者 */
  spectators() {
    return [...this.players.values()].filter(p => p.lives <= 0);
  }

  // ── 關卡生成 ────────────────────────────────────────────

  clearEntities() {
    this.bullets = [];
    this.enemyBullets = [];
    this.bells = [];
    this.bombWaves = [];
    this.missiles = [];
  }

  /**
   * 小蜜蜂經典蜂群排陣生成。
   * 難度依「開場當下的人數」結算一次：Boss HP 等比放大，一般關卡加排。
   */
  initEnemies(fx) {
    this.enemies = [];
    this.diveTimer = 0; // 不歸零的話過關瞬間可能立刻觸發俯衝
    this.isBossStage = this.level % 3 === 0;
    this.stageScale = Math.max(1, this.players.size);

    if (this.isBossStage) {
      const boss = new Enemy('boss', 3, 0, VIEW.width / 2, 105);
      boss.eid = this.nextEntityId();
      // 人數縮放：8 人的火力是單人的 8 倍，Boss HP 不放大會瞬間蒸發
      boss.maxHp *= this.stageScale;
      boss.hp = boss.maxHp;
      this.enemies.push(boss);
      [[2, 170], [5, 310]].forEach(([col, x]) => {
        const guard = new Enemy('guard', col, 1, x, 175);
        guard.eid = this.nextEntityId();
        this.enemies.push(guard);
      });
      this.diveInterval = 999;
      fx.sound('warning');
      fx.sound('bossMusicStart');
      return;
    }

    // 每 2 人多一排蜂群，上限 8 排（再多會塞滿畫布上半）
    const rows = Math.min(8, 4 + Math.floor((this.stageScale - 1) / 2));
    const cols = 8;
    const startX = 60;
    const startY = 80;
    const spacingX = 48;
    const spacingY = 36;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let type = 'drone'; // 雄蜂 (黃)
        if (r === 1) type = 'guard'; // 衛兵 (紅)
        if (r === 0) {
          // 一般關卡只使用補給運輸機；真正的 Boss 僅在每 3 關的魔王關出現
          type = 'carrier';
        }
        const enemy = new Enemy(type, c, r, startX + c * spacingX, startY + r * spacingY);
        enemy.eid = this.nextEntityId();
        this.enemies.push(enemy);
      }
    }
    this.diveInterval = Math.max(0.8, 2.2 - this.level * 0.2);
  }

  startStage(level, fx) {
    this.level = level;
    this.clearEntities();
    this.stageClearTimer = 0;
    this.swarmTimer = 0;

    // 命盡的觀戰者在新關卡自動復歸：開放大廳裡沒有「投幣續關」，
    // 讓人永久出局等於把他趕出房間
    this.players.forEach(p => {
      if (p.lives <= 0) {
        p.lives = 3;
        p.weaponLevel = 1;
        p.shields = 0;
        p.bombs = 2;
        fx.spawnFloatText(VIEW.width / 2, VIEW.height / 2 + 40, `${p.nick} 重返戰場`, p.playerColor);
      }
      p.respawn();
    });

    this.initEnemies(fx);
    this.state = 'PLAYING';
  }

  // ── 輸入套用（移動為客戶端權威）────────────────────────

  /**
   * 採用客戶端回報的座標，但校驗位移量與邊界：
   * 沒有 PvP，移動作弊只影響自己，因此不做回放，只擋住明顯離譜的瞬移。
   */
  applyInput(id, input, dt, fx) {
    const player = this.players.get(id);
    // 重生倒數中與命盡觀戰者都不吃輸入
    if (!player || !player.isActive) return;

    if (typeof input.x === 'number' && typeof input.y === 'number') {
      // 容許 2.5 倍速度上限的誤差（封包抖動、掉包補償），超過則夾回
      const maxStep = player.speed * dt * 2.5 + 8;
      const dx = MathUtil.clamp(input.x - player.x, -maxStep, maxStep);
      const dy = MathUtil.clamp(input.y - player.y, -maxStep, maxStep);
      const boundMargin = player.isDual ? 32 : 22;
      player.x = MathUtil.clamp(player.x + dx, boundMargin, VIEW.width - boundMargin);
      player.y = MathUtil.clamp(player.y + dy, 40, VIEW.height - 30);
    }

    if (input.fire) this.playerFire(player, fx);
    if (input.bomb) this.triggerBomb(player, fx);
  }

  // 子彈需記名主人，擊殺才知道該給誰加分
  playerFire(player, fx) {
    const before = this.bullets.length;
    player.fire(this.bullets, fx);
    for (let i = before; i < this.bullets.length; i++) {
      this.bullets[i].ownerId = player.id;
    }
  }

  triggerBomb(player, fx) {
    if (player.bombs <= 0) return;
    player.bombs--;
    const wave = new BombWave(player.x, player.y);
    wave.ownerId = player.id;
    this.bombWaves.push(wave);
    fx.sound('bomb');
    fx.shake(0.5, 14);
    fx.spawnFloatText(player.x, player.y - 30, 'BOMB BLAST!', '#a55eea');
  }

  // ── 結算 ────────────────────────────────────────────────

  addScore(player, pts, x, y, fx) {
    if (player) player.score += pts;
    fx.spawnFloatText(x, y, `+${pts}`, '#ffd32a');
  }

  /**
   * 敵機擊毀的單一結算入口：音效、爆炸、計分、Boss 判定、鈴鐺掉落。
   * 子彈命中、飛彈命中、炸彈衝擊、撞機四條路徑共用，避免各自漏掉某一步。
   */
  resolveKill(enemy, killerId, fx) {
    if (!enemy.alive) return;
    enemy.alive = false;

    const isBoss = enemy.type === 'boss';
    fx.sound(isBoss ? 'explosionBoss' : 'explosion');
    fx.spawnExplosion(enemy.x, enemy.y, '#ff4757', isBoss ? 28 : 16, 160);
    this.addScore(this.players.get(killerId), enemy.scoreValue, enemy.x, enemy.y, fx);

    if (isBoss) {
      fx.sound('bossMusicStop');
      fx.spawnFloatText(VIEW.width / 2, VIEW.height / 2 - 70, 'BOSS DEFEATED!', '#ffd32a');
    }

    // 掉落鈴鐺機制 (兵蜂)：補給運輸機 100% 掉落，其他 15% 機率掉落
    if (enemy.type === 'carrier' || Math.random() < 0.15) {
      const bell = new Bell(enemy.x, enemy.y);
      bell.eid = this.nextEntityId();
      this.bells.push(bell);
    }
  }

  // ── 主模擬迴圈 ──────────────────────────────────────────

  update(dt, fx) {
    this.tick++;

    if (this.state === 'STAGECLEAR') {
      this.stageClearTimer -= dt;
      if (this.stageClearTimer <= 0) this.startStage(this.level + 1, fx);
      return;
    }

    // 沒有活人時不推進戰鬥，避免空房間空轉演算
    if (this.players.size === 0) return;

    // 敵群整體搖擺 (小蜜蜂特色)
    this.swarmTimer += dt * 1.8;
    this.swarmOffset.x = Math.sin(this.swarmTimer) * 35;
    this.swarmOffset.y = Math.cos(this.swarmTimer * 0.5) * 8;

    // 俯衝目標：隨機挑一位存活玩家，讓 8 人場的壓力平均分攤
    const targets = this.alivePlayers();
    const focus = targets.length ? targets[Math.floor(Math.random() * targets.length)] : null;

    this.diveTimer += dt;
    if (!this.isBossStage && focus && this.diveTimer >= this.diveInterval) {
      this.diveTimer = 0;
      const formation = this.enemies.filter(e => e.alive && e.state === 'FORMATION');
      if (formation.length > 0) {
        const picked = formation[Math.floor(Math.random() * formation.length)];
        picked.startDive(focus.x, focus.y, VIEW.width, VIEW.height);
      }
    }

    // 敵機 AI：瞄準最近的存活玩家
    this.enemies.forEach(e => {
      const aim = this.nearestPlayer(e) || focus;
      if (aim) e.update(dt, this.swarmOffset, aim, this.enemyBullets, VIEW.width, VIEW.height);
    });

    // 玩家副武器與冷卻：不跑 Player.update()（移動已由 applyInput 決定），
    // 但冷卻與無敵時間仍須由權威端推進
    this.players.forEach(p => {
      if (p.fireCooldown > 0) p.fireCooldown -= dt;
      if (p.invulnerableTime > 0) p.invulnerableTime -= dt;

      // 重生倒數：歸零即歸位並給無敵
      if (p.respawnTimer > 0 && p.lives > 0) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) p.respawn();
      }

      if (p.isActive) {
        const before = this.missiles.length;
        p.updateMissiles(dt, this.missiles, fx);
        for (let i = before; i < this.missiles.length; i++) this.missiles[i].ownerId = p.id;
      }
    });

    this.bullets.forEach(b => b.update(dt));
    this.bullets = this.bullets.filter(b => b.alive);

    this.missiles.forEach(m => m.update(dt, this.enemies, fx));
    this.missiles = this.missiles.filter(m => m.alive);

    this.enemyBullets.forEach(eb => eb.update(dt));
    this.enemyBullets = this.enemyBullets.filter(eb => eb.alive);

    this.bells.forEach(bell => bell.update(dt));
    this.bells = this.bells.filter(bell => bell.alive);

    this.bombWaves.forEach(bw => {
      bw.update(dt, this.enemies, this.enemyBullets, fx)
        .forEach(e => this.resolveKill(e, bw.ownerId, fx));
    });
    this.bombWaves = this.bombWaves.filter(bw => bw.alive);

    this.resolveCollisions(fx);

    // 勝利條件：所有敵機消滅
    if (this.enemies.length > 0 && this.enemies.every(e => !e.alive)) {
      this.stageClear(fx);
    }
  }

  nearestPlayer(entity) {
    let best = null;
    let bestDist = Infinity;
    this.players.forEach(p => {
      if (p.lives <= 0) return;
      const d = MathUtil.dist(entity.x, entity.y, p.x, p.y);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    });
    return best;
  }

  resolveCollisions(fx) {
    // 1：玩家子彈 vs 敵機
    // 內層每輪都要重檢 b.alive，否則一顆非穿透彈會在同一步命中多架重疊敵機；
    // 穿透彈則以 canHit() 確保同一目標只結算一次。
    this.bullets.forEach(b => {
      this.enemies.forEach(e => {
        if (!b.alive || !e.alive) return;
        if (!MathUtil.circleIntersect(b, e)) return;
        if (!b.canHit(e)) return;

        if (!b.piercing) b.alive = false;
        fx.spawnExplosion(e.x, e.y, '#ffd32a', 8, 90);
        if (e.takeDamage(b.damage)) this.resolveKill(e, b.ownerId, fx);
      });
    });

    // 2：追蹤飛彈 vs 敵機
    this.missiles.forEach(m => {
      this.enemies.forEach(e => {
        if (!m.alive || !e.alive) return;
        if (!MathUtil.circleIntersect(m, e)) return;

        m.alive = false;
        fx.spawnExplosion(e.x, e.y, '#3fe2ff', 10, 100);
        if (e.takeDamage(m.damage)) this.resolveKill(e, m.ownerId, fx);
      });
    });

    // 3：玩家子彈 vs 浮空鈴鐺 (兵蜂玩球：向上反彈並切換顏色)
    this.bullets.forEach(b => {
      this.bells.forEach(bell => {
        if (!b.alive || !bell.alive) return;
        if (!MathUtil.circleIntersect(b, bell)) return;

        b.alive = false;
        bell.juggle(fx);
        const kind = bell.types[bell.typeIndex];
        fx.spawnExplosion(bell.x, bell.y, kind.color, 8, 80);
        fx.spawnFloatText(bell.x, bell.y - 14, kind.label, kind.color);
      });
    });

    this.players.forEach(player => {
      // 重生倒數中與觀戰者不在場上，一律不參與任何判定
      if (!player.isActive) return;

      // 4：玩家戰機 vs 浮空鈴鐺 (吃道具升級)
      this.bells.forEach(bell => {
        if (!bell.alive) return;
        if (!MathUtil.circleIntersect(player, bell)) return;
        bell.alive = false;
        this.collectBell(player, bell, fx);
      });

      // 5：敵方子彈 vs 玩家戰機
      this.enemyBullets.forEach(eb => {
        if (!eb.alive || !player.isActive) return;
        if (!MathUtil.circleIntersect(player, eb)) return;
        eb.alive = false;
        player.hit(fx);
      });

      // 6：俯衝敵機 vs 玩家戰機
      // 無敵／被俘期間直接略過整段判定，否則重生無敵可以無傷輾平整個蜂群。
      if (player.invulnerableTime <= 0 && !player.beingCaptured) {
        this.enemies.forEach(e => {
          if (!e.alive || !player.isActive) return;
          if (!MathUtil.circleIntersect(player, e)) return;

          player.hit(fx);
          // Boss 是固定旗艦，撞擊只傷玩家；一般敵機則同歸於盡並正常計分
          if (e.type !== 'boss') {
            fx.spawnExplosion(e.x, e.y, '#ff4757', 20, 160);
            this.resolveKill(e, player.id, fx);
          }
        });
      }
    });
  }

  collectBell(player, bell, fx) {
    fx.sound('bellCollect');
    const type = bell.types[bell.typeIndex];

    if (type.name === 'YELLOW') {
      this.addScore(player, 1000 * Math.pow(2, Math.min(3, bell.hitCount)), bell.x, bell.y, fx);
    } else if (type.name === 'BLUE') {
      player.speed = Math.min(420, player.speed + 40);
      fx.spawnFloatText(player.x, player.y - 25, 'SPEED UP!', '#3fe2ff');
    } else if (type.name === 'WHITE') {
      player.weaponLevel = Math.min(4, player.weaponLevel + 1);
      fx.spawnFloatText(player.x, player.y - 25, `WEAPON LV ${player.weaponLevel}!`, '#ffffff');
    } else if (type.name === 'RED') {
      // 提示文字用「能力」的 HUD 色，而非鈴鐺本身的顏色（SHIELD 綠／BOMB 紫）
      player.shields = Math.min(3, player.shields + 1);
      fx.spawnFloatText(player.x, player.y - 25, 'SHIELD ON!', '#2ed573');
    } else if (type.name === 'GREEN') {
      player.bombs = Math.min(5, player.bombs + 1);
      fx.spawnFloatText(player.x, player.y - 25, 'BOMB +1!', '#a55eea');
    }
  }

  stageClear(fx) {
    if (this.state === 'STAGECLEAR') return;
    this.state = 'STAGECLEAR';
    this.clearEntities();
    this.stageClearTimer = 2.2;
    fx.sound('bossMusicStop');
    fx.sound('stageClear');
    fx.spawnFloatText(VIEW.width / 2, VIEW.height / 2, `STAGE ${this.level} CLEAR!`, '#3fe2ff');
  }

  // ── 快照 ────────────────────────────────────────────────

  /**
   * 廣播用的完整世界狀態。
   *
   * 欄位名刻意與實體屬性同名：客戶端把快照物件直接餵給 js/render.js 的 draw 即可，
   * 不必維護一份「壓縮欄位 → 屬性名」的對應表（那是最容易長 bug 的地方）。
   * ponytail: 最小可行：全量 JSON + 完整欄位名 | upgrade if: 實測 8 人頻寬成為瓶頸，
   * 再上 permessage-deflate 或差分快照
   */
  snapshot() {
    const round = (n) => Math.round(n * 10) / 10; // 小數點後一位足夠繪圖，封包省一半
    return {
      tick: this.tick,
      level: this.level,
      state: this.state,
      isBossStage: this.isBossStage,
      players: [...this.players.values()].map(p => ({
        id: p.id,
        nick: p.nick,
        playerColor: p.playerColor,
        x: round(p.x),
        y: round(p.y),
        radius: p.radius,
        lives: p.lives,
        score: p.score,
        bombs: p.bombs,
        shields: p.shields,
        weaponLevel: p.weaponLevel,
        isDual: p.isDual,
        beingCaptured: p.beingCaptured,
        captureAngle: round(p.captureAngle),
        invulnerableTime: round(p.invulnerableTime),
        respawnTimer: round(p.respawnTimer),
        isActive: p.isActive
      })),
      enemies: this.enemies.filter(e => e.alive).map(e => ({
        eid: e.eid,
        type: e.type,
        x: round(e.x),
        y: round(e.y),
        angle: round(e.angle),
        // Boss 造型由伺服器抽選，不進快照的話 8 個客戶端會各畫各的
        bossStyle: e.bossStyle,
        hp: e.hp,
        maxHp: e.maxHp,
        alive: true
      })),
      // 子彈帶速度：客戶端在兩次快照之間自行外推，否則 20Hz 下高速彈會一格一格跳
      bullets: this.bullets.map(b => ({
        x: round(b.x), y: round(b.y), vx: round(b.vx), vy: round(b.vy), type: b.type
      })),
      enemyBullets: this.enemyBullets.map(b => ({
        x: round(b.x), y: round(b.y), vx: round(b.vx), vy: round(b.vy), type: b.type
      })),
      missiles: this.missiles.map(m => ({
        x: round(m.x), y: round(m.y), vx: round(m.vx), vy: round(m.vy), alive: true
      })),
      bells: this.bells.map(b => ({
        eid: b.eid, x: round(b.x), y: round(b.y), typeIndex: b.typeIndex, age: round(b.age)
      })),
      bombWaves: this.bombWaves.map(w => ({
        x: round(w.x), y: round(w.y), currentRadius: round(w.currentRadius), maxRadius: round(w.maxRadius)
      }))
    };
  }
}

// ponytail: one-liner: 同一份檔案同時餵瀏覽器 <script> 與 Node require()
// upgrade if: 專案導入打包工具，屆時全面改 ESM export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { World, PLAYER_COLORS, MAX_PLAYERS };
}
