/**
 * 遊戲主控制器（客戶端）
 *
 * 改造後本檔**不再模擬遊戲**：規則一律由 [shared/world.js](../shared/world.js) 執行，
 * 線上時跑在權威伺服器、單人時跑在瀏覽器內的 [js/localRoom.js](localRoom.js)。
 * 這裡只負責三件事：蒐集輸入、把權威狀態畫出來、演出事件（音效與粒子）。
 *
 * 自機移動是客戶端權威：本地先算好座標再上報，因此操作沒有 RTT 延遲。
 */

class Game {
  static STEP = 1 / 60;      // 移動模擬步長（與權威端一致）
  static INPUT_HZ = 30;      // 輸入上報頻率

  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.cw = this.canvas.width;
    this.ch = this.canvas.height;

    // HUD DOM 元素
    this.scoreEl = document.getElementById('scoreVal');
    this.highScoreEl = document.getElementById('highScoreVal');
    this.levelEl = document.getElementById('levelVal');
    this.livesEl = document.getElementById('livesVal');
    this.bombsEl = document.getElementById('bombsVal');
    this.shieldEl = document.getElementById('shieldVal');

    this.input = new InputManager(this.canvas);
    this.starfield = new Starfield(this.cw, this.ch);
    this.fx = new FXManager();

    // 自機的本地模擬：只算移動，其餘一律以權威狀態為準
    this.localShip = new Player(this.cw, this.ch);

    this.net = new NetSession((status) => this.onNetStatus(status));
    this.local = new LocalSession(this.fx);
    this.session = this.local;

    this.nick = `P${Math.floor(Math.random() * 9000) + 1000}`;
    this.inputTimer = 0;
    this.pingTimer = 0;
    this.paused = false;

    // 線上模式的視覺預測彈：開火當下先畫出來，等權威彈抵達再交棒，
    // 否則玩家會看到自己的射擊延遲一個 RTT 才出膛。不參與任何判定。
    this.ghostBullets = [];
    this.ghostCooldown = 0;

    // localStorage 內容不可信（可能被清成空字串或非數字），NaN 會讓 HUD 顯示 "NaN"
    const savedHigh = parseInt(localStorage.getItem('galaxy_hiscore'), 10);
    this.highScore = Number.isFinite(savedHigh) ? savedHigh : 10000;

    this.lastTime = 0;
    this.accumulator = 0;
    this.hudCache = {};

    this.bindButtons();
    this.startSession();
    this.updateHUD();
  }

  // ── 連線與工作階段 ──────────────────────────────────────

  /** 先試線上；連不上就無聲退回本地單人房，玩家不必知道伺服器存在 */
  startSession() {
    this.local.connect(this.nick);
    this.session = this.local;
    this.syncLocalShip(true);
    this.net.connect(this.nick);
    this.setStatusText('連線中…');
  }

  onNetStatus(status) {
    if (status === 'online') {
      this.session = this.net;
      this.syncLocalShip(true);
      this.setStatusText(`已連線 ${this.net.roomId}｜你是 ${this.net.colorName}`);
      return;
    }
    if (status === 'offline') {
      // 伺服器關閉或連不上：退回本地單人房，遊戲照常進行
      if (this.session === this.net) {
        this.local.connect(this.nick);
        this.syncLocalShip(true);
      }
      this.session = this.local;
      this.setStatusText('單人模式（未連線）');
    }
  }

  setStatusText(text) {
    const el = document.getElementById('networkStatus');
    if (el) el.textContent = text;
  }

  persistHighScore() {
    localStorage.setItem('galaxy_hiscore', String(this.highScore));
  }

  /** 換暱稱重新加入：斷線再連，會重新配對房間與顏色 */
  rejoinWithNick() {
    const input = document.getElementById('nickInput');
    const typed = input ? input.value.trim() : '';
    if (typed) this.nick = typed.slice(0, 12);
    soundEngine.init(); // 這是使用者手勢，順勢喚醒 AudioContext
    this.net.disconnect();
    this.startSession();
  }

  /**
   * 玩家色票分數榜。
   * 只在內容真的變動時重繪：這段 DOM 每幀都算的話，8 人同場會白白吃掉不少主執行緒。
   */
  renderRoster(state) {
    const list = document.getElementById('rosterList');
    if (!list) return;

    const rows = state.players
      .map(p => ({
        id: p.id,
        nick: p.nick || '???',
        color: p.playerColor,
        score: p.score,
        out: p.lives <= 0,
        lives: p.lives
      }))
      .sort((a, b) => b.score - a.score);

    const signature = rows.map(r => `${r.id}:${r.nick}:${r.score}:${r.lives}`).join('|');
    if (signature === this.rosterSignature) return;
    this.rosterSignature = signature;

    list.textContent = '';
    rows.forEach(r => {
      const li = document.createElement('li');
      li.className = 'roster-item'
        + (r.id === this.session.selfId ? ' is-self' : '')
        + (r.out ? ' is-out' : '');
      li.style.color = r.color;

      const swatch = document.createElement('span');
      swatch.className = 'roster-swatch';
      li.appendChild(swatch);

      // 用 textContent 逐段組裝而非 innerHTML：暱稱是使用者輸入，不該進 HTML 解析
      const name = document.createElement('span');
      name.textContent = r.nick;
      li.appendChild(name);

      const score = document.createElement('span');
      score.className = 'roster-score';
      score.textContent = r.out ? '觀戰' : String(r.score).padStart(5, '0');
      li.appendChild(score);

      list.appendChild(li);
    });
  }

  bindButtons() {
    const btnStart = document.getElementById('btnStart');
    if (btnStart) btnStart.onclick = () => {
      soundEngine.init();
      if (!this.net.isOnline) this.startSession();
    };

    const btnPause = document.getElementById('btnPause');
    if (btnPause) btnPause.onclick = () => this.togglePause();

    const btnSound = document.getElementById('btnSound');
    if (btnSound) btnSound.onclick = (e) => {
      const on = soundEngine.toggleSound();
      e.target.textContent = '音效：' + (on ? '開' : '關');
    };

    const btnBomb = document.getElementById('btnBomb');
    if (btnBomb) btnBomb.onclick = () => { this.input.bombRequested = true; };

    const btnJoin = document.getElementById('btnJoin');
    if (btnJoin) btnJoin.onclick = () => this.rejoinWithNick();

    const nickInput = document.getElementById('nickInput');
    if (nickInput) {
      // 打字時的空白鍵與 WASD 不該同時操控戰機；keyup 也要擋，否則按鍵狀態會卡住
      nickInput.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') this.rejoinWithNick();
      };
      nickInput.onkeyup = (e) => e.stopPropagation();
    }

    const touchBomb = document.getElementById('touchBomb');
    if (touchBomb) touchBomb.onclick = () => { this.input.bombRequested = true; };
  }

  togglePause() {
    // 線上模式不可暫停：伺服器不會為了一個人停下來，假暫停只會讓畫面與權威脫節
    if (this.session.isOnline) {
      this.setStatusText('線上模式無法暫停');
      return;
    }
    this.paused = !this.paused;
  }

  // ── 自機 ────────────────────────────────────────────────

  get selfState() {
    const id = this.session.selfId;
    return this.session.getState().players.find(p => p.id === id) || null;
  }

  /** 權威狀態回寫到本地自機：能力值與（必要時）座標 */
  syncLocalShip(resetPosition = false) {
    const me = this.selfState;
    if (!me) return;
    this.localShip.speed = me.speed || this.localShip.speed;
    this.localShip.weaponLevel = me.weaponLevel;
    this.localShip.shields = me.shields;
    this.localShip.lives = me.lives;
    this.localShip.isDual = me.isDual;
    this.localShip.playerColor = me.playerColor;
    if (resetPosition) {
      this.localShip.x = me.x;
      this.localShip.y = me.y;
    }
  }

  // ── 主迴圈 ──────────────────────────────────────────────

  update(dt) {
    if (this.input.pauseRequested) {
      this.input.pauseRequested = false;
      this.togglePause();
    }

    this.starfield.update(dt);
    this.fx.update(dt);
    this.fx.applyEvents(this.session.drainEvents());

    if (this.paused && !this.session.isOnline) return;

    // 自機移動：本地先算，零延遲
    const me = this.selfState;
    const active = !!(me && me.isActive);

    // 重生完成的瞬間，權威已把座標歸位到畫面底部中央，本地自機必須跟上，
    // 否則會從陣亡的位置繼續飛，與伺服器認定的位置分家
    if (active && !this.wasActive) this.syncLocalShip(true);
    this.wasActive = active;

    if (active) {
      this.localShip.speed = me.speed || this.localShip.speed;
      this.localShip.isDual = me.isDual;
      this.localShip.update(dt, this.input);
    }

    const firing = this.input.isFiring() || this.input.fireRequested;
    const bombing = this.input.bombRequested;
    this.input.fireRequested = false;
    this.input.bombRequested = false;

    this.updateGhostBullets(dt, firing);

    // 輸入上報：30Hz 足夠，權威端以 60Hz 推進
    this.inputTimer -= dt;
    const shouldSend = this.inputTimer <= 0 || bombing;
    if (shouldSend) {
      this.inputTimer = 1 / Game.INPUT_HZ;
      this.session.sendInput({
        x: Math.round(this.localShip.x * 10) / 10,
        y: Math.round(this.localShip.y * 10) / 10,
        fire: firing,
        bomb: bombing
      });
    }

    const stateBefore = this.session.getState().state;
    this.session.advance(dt);
    this.syncLocalShip(false);

    // 過關是天然的結算點：高分在此落盤一次
    if (stateBefore !== 'STAGECLEAR' && this.session.getState().state === 'STAGECLEAR') {
      this.persistHighScore();
    }

    this.pingTimer -= dt;
    if (this.pingTimer <= 0) {
      this.pingTimer = 1;
      this.session.ping();
    }

    this.updateHUD();
  }

  /** 預測彈只是視覺：沿用權威端同樣的 0.13 秒射速，壽命短到權威彈接手為止 */
  updateGhostBullets(dt, firing) {
    this.ghostCooldown -= dt;
    if (this.session.isOnline && firing && this.ghostCooldown <= 0 && this.localShip.lives > 0) {
      this.ghostCooldown = 0.13;
      this.ghostBullets.push({
        x: this.localShip.x, y: this.localShip.y - 18,
        vx: 0, vy: -560, type: this.localShip.weaponLevel >= 4 ? 'laser' : 'vulcan',
        life: 0.12
      });
    }
    this.ghostBullets.forEach(g => {
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.life -= dt;
    });
    this.ghostBullets = this.ghostBullets.filter(g => g.life > 0);
  }

  updateHUD() {
    // 只在值真的變了才寫 DOM
    const write = (key, el, value) => {
      if (!el || this.hudCache[key] === value) return;
      this.hudCache[key] = value;
      el.textContent = value;
    };

    const state = this.session.getState();
    const me = this.selfState;
    const score = me ? me.score : 0;
    // 只更新記憶體中的紀錄；落盤延到過關或離開頁面，
    // 否則破紀錄後每一次命中都會觸發一次同步 localStorage 寫入（T-011 已修過一次的缺陷）
    if (score > this.highScore) this.highScore = score;

    write('score', this.scoreEl, String(score).padStart(6, '0'));
    write('high', this.highScoreEl, String(this.highScore).padStart(6, '0'));
    write('level', this.levelEl, String(state.level));
    write('lives', this.livesEl, String(me ? me.lives : 0));
    write('bombs', this.bombsEl, String(me ? me.bombs : 0));
    write('shield', this.shieldEl, String(me ? me.shields : 0));

    this.renderRoster(state);
  }

  // ── 渲染 ────────────────────────────────────────────────

  draw() {
    const state = this.session.getState();
    this.ctx.save();
    this.fx.applyShake(this.ctx);

    this.starfield.draw(this.ctx);

    // 快照物件與本地真實體的欄位名一致，同一套 draw 皆可繪製
    state.bells.forEach(b => Bell.prototype.draw.call(b, this.ctx));
    state.enemies.forEach(e => Enemy.prototype.draw.call(e, this.ctx));
    state.bullets.forEach(b => Bullet.prototype.draw.call(b, this.ctx));
    this.ghostBullets.forEach(g => Bullet.prototype.draw.call(g, this.ctx));
    state.missiles.forEach(m => HomingMissile.prototype.draw.call(m, this.ctx));
    state.enemyBullets.forEach(b => Bullet.prototype.draw.call(b, this.ctx));
    state.bombWaves.forEach(w => BombWave.prototype.draw.call(w, this.ctx));

    if (state.isBossStage) this.drawBossBar(state);

    // 其他玩家用權威座標，自機用本地座標（零延遲）
    state.players.forEach(p => {
      if (!p.isActive) return; // 重生倒數中與命盡觀戰者不在場上
      if (p.id === this.session.selfId) {
        this.localShip.invulnerableTime = p.invulnerableTime;
        this.localShip.shields = p.shields;
        this.localShip.playerColor = p.playerColor;
        this.localShip.draw(this.ctx);
      } else {
        Player.prototype.draw.call(p, this.ctx);
      }
      this.drawNameTag(p);
    });

    this.fx.draw(this.ctx);

    const me = this.selfState;
    if (this.paused && !this.session.isOnline) {
      this.drawOverlayText('PAUSED', '按 P 或暫停按鈕繼續');
    } else if (state.state === 'STAGECLEAR') {
      this.drawOverlayText(`STAGE ${state.level} CLEAR`, '準備迎戰下一波蜂群...');
    } else if (me && me.lives <= 0) {
      this.drawOverlayText('OBSERVING', '下一關開始時自動重返戰場');
    } else if (me && me.respawnTimer > 0) {
      this.drawOverlayText(`RESPAWN ${Math.ceil(me.respawnTimer)}`, `剩餘 ${me.lives} 命`);
    }

    this.ctx.restore();
  }

  /** 8 人同場時，名牌是辨認隊友的主要線索 */
  drawNameTag(p) {
    if (!p.nick) return;
    this.ctx.save();
    this.ctx.textAlign = 'center';
    this.ctx.font = 'bold 9px monospace';
    this.ctx.fillStyle = p.playerColor;
    this.ctx.globalAlpha = p.id === this.session.selfId ? 0.95 : 0.7;
    const x = p.id === this.session.selfId ? this.localShip.x : p.x;
    const y = (p.id === this.session.selfId ? this.localShip.y : p.y) + 30;
    this.ctx.fillText(p.nick, x, y);
    this.ctx.restore();
  }

  drawBossBar(state) {
    const boss = state.enemies.find(e => e.type === 'boss');
    if (!boss) return;
    const barW = 300;
    const barH = 12;
    const barX = (this.cw - barW) / 2;
    const barY = 22;
    this.ctx.save();
    this.ctx.fillStyle = 'rgba(5, 8, 20, 0.78)';
    this.ctx.fillRect(barX - 8, barY - 18, barW + 16, 50);
    this.ctx.textAlign = 'center';
    this.ctx.fillStyle = '#ff4757';
    this.ctx.font = '900 13px monospace';
    this.ctx.fillText('⚠ BOSS BATTLE ⚠', this.cw / 2, barY - 4);
    this.ctx.fillStyle = '#24152f';
    this.ctx.fillRect(barX, barY, barW, barH);
    this.ctx.fillStyle = '#a55eea';
    this.ctx.fillRect(barX, barY, barW * Math.max(0, boss.hp / boss.maxHp), barH);
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(barX, barY, barW, barH);
    this.ctx.restore();
  }

  drawOverlayText(title, subtitle) {
    this.ctx.save();
    this.ctx.fillStyle = 'rgba(5, 8, 20, 0.65)';
    this.ctx.fillRect(0, 0, this.cw, this.ch);

    this.ctx.textAlign = 'center';
    this.ctx.fillStyle = '#ff4757';
    this.ctx.font = '900 30px monospace';
    this.ctx.shadowColor = '#ff4757';
    this.ctx.shadowBlur = 12;
    this.ctx.fillText(title, this.cw / 2, this.ch / 2 - 15);

    this.ctx.shadowBlur = 0;
    this.ctx.fillStyle = '#d8e8ff';
    this.ctx.font = 'bold 13px monospace';
    this.ctx.fillText(subtitle, this.cw / 2, this.ch / 2 + 25);
    this.ctx.restore();
  }

  // 固定步長：以 1/60 秒為單位推進，繪製仍跟著螢幕更新率。
  // 變動步長時，每幀觸發一次的行為（尾跡粒子、射速）會隨 120/144Hz 等比放大。
  loop(timestamp) {
    if (!this.lastTime) this.lastTime = timestamp;
    // 分頁切回前景時 timestamp 會出現大跳躍，上限 0.25 秒避免一次補上百步
    const frameTime = Math.min(0.25, (timestamp - this.lastTime) / 1000);
    this.lastTime = timestamp;

    this.accumulator += frameTime;
    while (this.accumulator >= Game.STEP) {
      this.update(Game.STEP);
      this.accumulator -= Game.STEP;
    }

    this.draw();
    requestAnimationFrame(t => this.loop(t));
  }
}

// 頁面載入啟動
window.addEventListener('DOMContentLoaded', () => {
  const game = new Game();
  window.game = game; // 除錯／自動化測試接點（test/browser_check.py）
  // 離開頁面是另一個結算點：沒有它，破紀錄後直接關分頁會丟失高分
  window.addEventListener('beforeunload', () => game.persistHighScore());
  requestAnimationFrame(t => game.loop(t));
});
