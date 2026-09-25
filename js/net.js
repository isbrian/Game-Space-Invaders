/**
 * 線上連線（取代舊的 WebRTC 手動連線碼）
 *
 * 舊版要玩家互相複製貼上 SDP 才連得起來，與「開網址就能玩」互相矛盾，已整份廢除。
 * 現在只做三件事：連上伺服器、把輸入送出去、把快照收進來並補平 20Hz 的空檔。
 *
 * 與 [js/localRoom.js](localRoom.js) 共用同一組介面（connect / sendInput / advance /
 * getState / status），game.js 因此不需要區分自己在線上還是單人。
 */
class NetSession {
  constructor(onStatus = () => {}) {
    this.ws = null;
    this.onStatus = onStatus;
    this.status = 'offline'; // 'offline' | 'connecting' | 'online'
    this.selfId = null;
    this.roomId = null;
    this.color = null;
    this.colorName = null;
    this.roster = [];
    this.pendingEvents = [];
    this.latency = 0;

    // 渲染狀態：快照到達時更新目標，advance() 逐幀補平
    this.view = this.emptyState();
    this.enemyView = new Map(); // eid -> 內插中的敵機
    this.bellView = new Map();  // eid -> 內插中的鈴鐺
    this.playerView = new Map();// id  -> 內插中的玩家
  }

  emptyState() {
    return {
      tick: 0, level: 1, state: 'PLAYING', isBossStage: false,
      players: [], enemies: [], bullets: [], enemyBullets: [],
      missiles: [], bells: [], bombWaves: []
    };
  }

  get isOnline() {
    return this.status === 'online';
  }

  connect(nick) {
    this.setStatus('connecting');

    // 整段保護：在沒有 WebSocket／location 的環境（測試沙箱、file:// 直開）
    // 應該安靜退回單人模式，而不是讓整個遊戲在啟動時就炸掉
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${location.host}`);
    } catch {
      this.setStatus('offline');
      return;
    }

    this.ws.onopen = () => this.send({ type: 'join', nick });
    this.ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
    this.ws.onclose = () => {
      this.selfId = null;
      this.setStatus('offline');
    };
    // 連不上時 onerror 先於 onclose；狀態統一在 onclose 收斂，這裡不重複切換
    this.ws.onerror = () => {};
  }

  disconnect() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status, this);
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  sendInput(input) {
    this.send({ type: 'input', ...input });
  }

  handle(msg) {
    if (msg.type === 'welcome') {
      this.selfId = msg.playerId;
      this.roomId = msg.roomId;
      this.color = msg.color;
      this.colorName = msg.colorName;
      this.applySnapshot(msg.snapshot);
      this.setStatus('online');
      return;
    }
    if (msg.type === 'snapshot') {
      this.applySnapshot(msg.snapshot);
      if (msg.events && msg.events.length) this.pendingEvents.push(...msg.events);
      return;
    }
    if (msg.type === 'roster') {
      this.roster = msg.players;
      return;
    }
    if (msg.type === 'pong') {
      this.latency = Math.round(performance.now() - msg.t);
    }
  }

  /** 收下權威狀態：位置存成內插目標，其餘欄位直接覆蓋 */
  applySnapshot(snap) {
    if (!snap) return;
    this.view.tick = snap.tick;
    this.view.level = snap.level;
    this.view.state = snap.state;
    this.view.isBossStage = snap.isBossStage;

    this.view.players = this.syncById(this.playerView, snap.players, p => p.id);
    this.view.enemies = this.syncById(this.enemyView, snap.enemies, e => e.eid);
    this.view.bells = this.syncById(this.bellView, snap.bells, b => b.eid);

    // 子彈／飛彈／衝擊波生命短、數量大，直接換新並靠速度外推，不做身分對應
    this.view.bullets = snap.bullets;
    this.view.enemyBullets = snap.enemyBullets;
    this.view.missiles = snap.missiles;
    this.view.bombWaves = snap.bombWaves;
  }

  /**
   * 以 id 對應新舊狀態：既有者保留目前顯示座標並設定新目標，新進者直接就位。
   * 沒有這層對應，每次快照都是一批全新座標，內插無從做起。
   */
  syncById(store, incoming, keyOf) {
    const seen = new Set();
    const result = incoming.map(item => {
      const key = keyOf(item);
      seen.add(key);
      let node = store.get(key);
      if (!node) {
        node = { ...item, targetX: item.x, targetY: item.y };
        store.set(key, node);
      } else {
        Object.assign(node, item, { x: node.x, y: node.y });
        node.targetX = item.x;
        node.targetY = item.y;
      }
      return node;
    });
    [...store.keys()].forEach(key => { if (!seen.has(key)) store.delete(key); });
    return result;
  }

  /** 兩次快照之間把畫面補平：位置內插 + 子彈外推 */
  advance(dt) {
    const k = Math.min(1, 18 * dt); // 內插速率：夠快不拖影，夠慢不抖動
    const lerp = (node) => {
      node.x += (node.targetX - node.x) * k;
      node.y += (node.targetY - node.y) * k;
    };
    this.view.players.forEach(lerp);
    this.view.enemies.forEach(lerp);
    this.view.bells.forEach(lerp);

    const extrapolate = (e) => {
      e.x += (e.vx || 0) * dt;
      e.y += (e.vy || 0) * dt;
    };
    this.view.bullets.forEach(extrapolate);
    this.view.enemyBullets.forEach(extrapolate);
    this.view.missiles.forEach(extrapolate);
    // 衝擊波擴張速度是常數（見 shared/entities.js 的 BombWave.speed）
    this.view.bombWaves.forEach(w => { w.currentRadius += 460 * dt; });

    this.view.bells.forEach(b => { b.age += dt; }); // 晃動相位靠自身壽命推進
  }

  getState() {
    return this.view;
  }

  /** 取出並清空待播事件（音效／粒子），由 game.js 交給 FXManager 演出 */
  drainEvents() {
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  ping() {
    this.send({ type: 'ping', t: performance.now() });
  }
}
