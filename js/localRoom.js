/**
 * 本地單人房
 *
 * 伺服器離線時仍然可玩，而且跑的是與權威端**完全同一份** [shared/world.js](../shared/world.js)。
 * 這同時是 shared 層正確性的日常驗證手段：單人模式一有異常，代表權威邏輯也壞了。
 *
 * 介面與 [js/net.js](net.js) 的 NetSession 對齊（connect / sendInput / advance /
 * getState / drainEvents / status），game.js 因此不需要區分線上或單人。
 */
class LocalSession {
  constructor(fx) {
    this.fx = fx; // 本地直接用真的 FXManager：音效與粒子即時生效，不需要序列化
    this.world = new World();
    this.status = 'local';
    this.selfId = 'local';
    this.roomId = 'LOCAL';
    this.color = PLAYER_COLORS[0].hex;
    this.colorName = PLAYER_COLORS[0].name;
    this.roster = [];
    this.latency = 0;
    this.accumulator = 0;
  }

  get isOnline() {
    return false;
  }

  connect(nick) {
    this.world = new World();
    this.world.addPlayer(this.selfId, { nick, colorIndex: 0 });
    this.world.players.get(this.selfId).invulnerableTime = 0; // 單人開局不需要進場保護
    this.world.startStage(1, this.fx);
    this.roster = [{ id: this.selfId, nick, color: this.color, colorName: this.colorName, score: 0, lives: 3 }];
  }

  disconnect() {}

  sendInput(input) {
    this.pendingInput = input;
  }

  /**
   * 本地房自己就是權威：以與伺服器相同的固定步長推進，
   * 行為才會和線上模式一致（變動步長會讓尾跡粒子與穿透判定隨更新率浮動）。
   */
  advance(dt) {
    const STEP = 1 / 60;
    this.accumulator += Math.min(0.25, dt);
    while (this.accumulator >= STEP) {
      if (this.pendingInput) this.world.applyInput(this.selfId, this.pendingInput, STEP, this.fx);
      this.world.update(STEP, this.fx);
      this.accumulator -= STEP;
    }
    const me = this.world.players.get(this.selfId);
    if (me) this.roster[0] = { ...this.roster[0], score: me.score, lives: me.lives };
  }

  /** 直接回傳世界中的真實體：它們本身就帶 draw()，不需要任何轉換 */
  getState() {
    const w = this.world;
    return {
      tick: w.tick,
      level: w.level,
      state: w.state,
      isBossStage: w.isBossStage,
      players: [...w.players.values()],
      enemies: w.enemies.filter(e => e.alive),
      bullets: w.bullets,
      enemyBullets: w.enemyBullets,
      missiles: w.missiles,
      bells: w.bells,
      bombWaves: w.bombWaves
    };
  }

  // 本地房的 fx 已即時作用，沒有待播事件
  drainEvents() {
    return [];
  }

  ping() {}
}
