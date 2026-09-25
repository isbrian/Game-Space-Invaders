/**
 * 房間：一個 World + 一組連線 + 一條 60Hz 模擬迴圈
 *
 * 模擬固定 60Hz（與單機版同一步長，行為才一致），廣播降為 20Hz。
 * 邏輯層產生的音效／粒子事件由本檔的收集器攔下，隨快照一併送出，
 * 伺服器因此完全不需要 Web Audio，客戶端收到後才決定怎麼演。
 */

const { World, PLAYER_COLORS, MAX_PLAYERS } = require('../shared/world.js');
const { ColorPool } = require('./colorPool.js');

const STEP = 1 / 60;        // 模擬步長，與單機版一致
const BROADCAST_HZ = 20;    // 快照廣播頻率
const EVENT_CAP = 120;      // 單次廣播的事件上限，防止爆炸幀灌爆封包

/**
 * fx sink 的伺服器實作：把邏輯層的副作用收集成可序列化事件。
 * 形狀與客戶端 FXManager 一致，因此 shared/ 完全不需要知道自己跑在哪一端。
 */
class EventCollector {
  constructor() {
    this.events = [];
  }

  push(event) {
    if (this.events.length < EVENT_CAP) this.events.push(event);
  }

  sound(name) {
    this.push({ e: 'sound', n: name });
  }

  spawnExplosion(x, y, color = '#ff9f43', count = 16, speed = 140) {
    this.push({ e: 'boom', x: Math.round(x), y: Math.round(y), c: color, n: count, s: speed });
  }

  spawnFloatText(x, y, text, color = '#ffd32a') {
    this.push({ e: 'text', x: Math.round(x), y: Math.round(y), t: text, c: color });
  }

  spawnSmoke(x, y, count = 2) {
    this.push({ e: 'smoke', x: Math.round(x), y: Math.round(y), n: count });
  }

  shake(duration = 0.25, intensity = 8) {
    this.push({ e: 'shake', d: duration, i: intensity });
  }

  drain() {
    const out = this.events;
    this.events = [];
    return out;
  }
}

let nextRoomId = 1;

class Room {
  constructor(onEmpty) {
    this.id = `R${nextRoomId++}`;
    this.world = new World();
    this.colors = new ColorPool();
    this.clients = new Map(); // playerId -> { socket, nick, colorIndex }
    this.fx = new EventCollector();
    this.onEmpty = onEmpty;
    this.timer = null;
    this.accumulator = 0;
    this.lastTime = process.hrtime.bigint();
    this.broadcastTimer = 0;

    this.world.startStage(1, this.fx);
    this.fx.drain(); // 開房當下沒有聽眾，開場音效不必留著
  }

  get playerCount() {
    return this.clients.size;
  }

  get isFull() {
    return this.colors.isEmpty;
  }

  // ── 連線進出 ────────────────────────────────────────────

  join(playerId, socket, nick) {
    const colorIndex = this.colors.take();
    if (colorIndex === null) return null; // 房滿，交由配對器另尋

    this.clients.set(playerId, { socket, nick, colorIndex });
    const player = this.world.addPlayer(playerId, { nick, colorIndex });

    if (!this.timer) this.start();

    this.broadcast({
      type: 'roster',
      roomId: this.id,
      players: this.rosterPayload()
    });

    return {
      playerId,
      roomId: this.id,
      color: player.playerColor,
      colorName: PLAYER_COLORS[colorIndex].name,
      capacity: MAX_PLAYERS,
      snapshot: this.world.snapshot()
    };
  }

  leave(playerId) {
    const client = this.clients.get(playerId);
    if (!client) return;

    this.colors.release(client.colorIndex); // 顏色立即回池，下一位進來即可取用
    this.clients.delete(playerId);
    this.world.removePlayer(playerId);

    if (this.clients.size === 0) {
      this.stop();
      if (this.onEmpty) this.onEmpty(this);
      return;
    }

    this.broadcast({ type: 'roster', roomId: this.id, players: this.rosterPayload() });
  }

  rosterPayload() {
    return [...this.clients.entries()].map(([id, c]) => {
      const p = this.world.players.get(id);
      return {
        id,
        nick: c.nick,
        color: PLAYER_COLORS[c.colorIndex].hex,
        colorName: PLAYER_COLORS[c.colorIndex].name,
        score: p ? p.score : 0,
        lives: p ? p.lives : 0
      };
    });
  }

  handleInput(playerId, input) {
    this.world.applyInput(playerId, input, STEP, this.fx);
  }

  // ── 模擬迴圈 ────────────────────────────────────────────

  start() {
    this.lastTime = process.hrtime.bigint();
    // ponytail: stdlib: setInterval 驅動固定步長累加器 | upgrade if: 需要 sub-ms 精度再換 busy-wait + hrtime
    this.timer = setInterval(() => this.tick(), 1000 / 60);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = process.hrtime.bigint();
    // 上限 0.25 秒：行程被 GC 或系統排程卡住時，不要一次補上百步
    const frameTime = Math.min(0.25, Number(now - this.lastTime) / 1e9);
    this.lastTime = now;

    this.accumulator += frameTime;
    while (this.accumulator >= STEP) {
      this.world.update(STEP, this.fx);
      this.accumulator -= STEP;
    }

    this.broadcastTimer += frameTime;
    if (this.broadcastTimer >= 1 / BROADCAST_HZ) {
      this.broadcastTimer = 0;
      this.broadcast({
        type: 'snapshot',
        snapshot: this.world.snapshot(),
        events: this.fx.drain()
      });
    }
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    this.clients.forEach(({ socket }) => {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    });
  }
}

module.exports = { Room, EventCollector, STEP, BROADCAST_HZ };
