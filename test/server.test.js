/**
 * 權威伺服器回歸測試（T-015）
 *
 * 鎖住房間／顏色池／配對器三者的契約：顏色不重複、滿房另開、離線歸還、空房銷毀。
 * 以真實 WebSocket 連線驗證，不做 mock——這幾條規則的價值全在真實連線行為上。
 * 執行：npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const { WebSocket } = require('ws');

const { ColorPool } = require('../server/colorPool.js');
const { Matchmaker } = require('../server/matchmaker.js');
const { World, PLAYER_COLORS, MAX_PLAYERS } = require('../shared/world.js');
const { Enemy } = require('../shared/entities.js');
const { EventCollector } = require('../server/room.js');

// ── 純單元：顏色池 ────────────────────────────────────────

test('顏色池配發 8 個相異顏色後即枯竭', () => {
  const pool = new ColorPool();
  const taken = [];
  for (let i = 0; i < MAX_PLAYERS; i++) taken.push(pool.take());

  assert.strictEqual(new Set(taken).size, MAX_PLAYERS, '配發的顏色索引必須互不重複');
  assert.strictEqual(pool.take(), null, '池空時必須回傳 null 而非重複配發');
  assert.ok(pool.isEmpty);
});

test('顏色歸還後可再配發，且拒絕重複歸還', () => {
  const pool = new ColorPool();
  const first = pool.take();
  assert.strictEqual(pool.release(first), true);
  assert.strictEqual(pool.release(first), false, '重複歸還必須被拒絕，否則池會長出幽靈顏色');
  assert.strictEqual(pool.size, MAX_PLAYERS);
  assert.strictEqual(pool.take(), first, '歸還的顏色應可再次配發');
});

// ── 純單元：世界難度縮放 ──────────────────────────────────

test('Boss HP 依開場人數結算，關內不再變動', () => {
  const fx = new EventCollector();
  const world = new World();
  for (let i = 0; i < 4; i++) world.addPlayer(`p${i}`, { colorIndex: i });

  world.startStage(3, fx); // 每 3 關為魔王關
  const boss = world.enemies.find(e => e.type === 'boss');
  assert.ok(boss, '第 3 關應生成 Boss');
  // 對照具名常數而非硬編碼數值：T-013 調平衡時改的就是這個常數
  assert.strictEqual(boss.maxHp, Enemy.BOSS_BASE_HP * 4, '4 人場的 Boss HP 應為單人的 4 倍');

  // 關內有人離開也不重算，避免血條中途跳動
  world.removePlayer('p3');
  world.update(1 / 60, fx);
  assert.strictEqual(boss.maxHp, Enemy.BOSS_BASE_HP * 4, '關卡進行中不得重算 Boss HP');
});

test('擊殺計分歸於子彈主人', () => {
  const fx = new EventCollector();
  const world = new World();
  world.addPlayer('shooter', { colorIndex: 0 });
  world.addPlayer('bystander', { colorIndex: 1 });
  world.startStage(1, fx);

  const enemy = world.enemies[0];
  world.resolveKill(enemy, 'shooter', fx);

  assert.strictEqual(world.players.get('shooter').score, enemy.scoreValue);
  assert.strictEqual(world.players.get('bystander').score, 0, '旁觀者不得因他人擊殺得分');
});

test('移動採客戶端權威但夾住瞬移', () => {
  const fx = new EventCollector();
  const world = new World();
  const p = world.addPlayer('p1', { colorIndex: 0 });
  const startX = p.x;

  world.applyInput('p1', { x: startX + 5000, y: p.y }, 1 / 60, fx);
  assert.ok(p.x - startX < 30, '單步位移必須被速度上限夾住，不可瞬移到畫面另一端');
  assert.ok(p.x <= 480 - 22, '座標必須仍在畫布邊界內');
});

// ── 整合：真實 WebSocket 連線 ─────────────────────────────

/** 起一台臨時伺服器，回傳 { port, close } */
function startServer() {
  delete require.cache[require.resolve('../server/server.js')];
  process.env.PORT = '0'; // 交給 OS 配一個空閒埠
  const mod = require('../server/server.js');
  return new Promise((resolve) => {
    const done = () => resolve({
      port: mod.server.address().port,
      matchmaker: mod.matchmaker,
      // 用伺服器自己的 shutdown：它會一併停掉房間的 60Hz 計時器，
      // 否則 event loop 被撐住，測試行程跑完也不會退出
      close: () => mod.shutdown()
    });
    if (mod.server.listening) done();
    else mod.server.once('listening', done);
  });
}

/** 連一個玩家並等到 welcome */
function connect(port, nick) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => reject(new Error(`${nick} 等待 welcome 逾時`)), 4000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', nick })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'welcome') {
        clearTimeout(timer);
        resolve({ ws, welcome: msg });
      }
    });
    ws.on('error', reject);
  });
}

test('8 人進同一房各拿相異顏色，第 9 人另開新房', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const clients = [];
  for (let i = 0; i < MAX_PLAYERS; i++) clients.push(await connect(srv.port, `玩家${i + 1}`));

  const rooms = new Set(clients.map(c => c.welcome.roomId));
  const colors = clients.map(c => c.welcome.color);

  assert.strictEqual(rooms.size, 1, '前 8 人應全部落在同一房');
  assert.strictEqual(new Set(colors).size, MAX_PLAYERS, '8 位玩家的顏色必須完全不重複');
  assert.deepStrictEqual(
    [...colors].sort(),
    PLAYER_COLORS.map(c => c.hex).sort(),
    '配發的顏色應正好覆蓋整個色池'
  );

  const ninth = await connect(srv.port, '第九人');
  assert.notStrictEqual(ninth.welcome.roomId, clients[0].welcome.roomId, '第 9 人必須被分到新房間');
  assert.strictEqual(srv.matchmaker.roomCount, 2);

  [...clients, ninth].forEach(c => c.ws.close());
});

test('玩家離線後顏色歸還，且空房自動銷毀', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const a = await connect(srv.port, '甲');
  const b = await connect(srv.port, '乙');
  const roomId = a.welcome.roomId;
  const room = srv.matchmaker.rooms.get(roomId);

  assert.strictEqual(room.playerCount, 2);
  assert.strictEqual(room.colors.size, MAX_PLAYERS - 2);

  const releasedColor = a.welcome.color;
  a.ws.close();
  await waitFor(() => room.playerCount === 1, '等待甲離線');
  assert.strictEqual(room.colors.size, MAX_PLAYERS - 1, '離線者的顏色必須回到池中');

  const c = await connect(srv.port, '丙');
  assert.strictEqual(c.welcome.color, releasedColor, '新玩家應取得剛歸還的顏色');

  b.ws.close();
  c.ws.close();
  await waitFor(() => srv.matchmaker.roomCount === 0, '等待空房銷毀');
  assert.strictEqual(room.timer, null, '空房的模擬計時器必須停止，否則行程不會退出');
});

test('世界會在連線驅動下持續推進', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const a = await connect(srv.port, '推進測試');
  const room = srv.matchmaker.rooms.get(a.welcome.roomId);
  const startTick = room.world.tick;

  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('未收到 snapshot')), 4000);
    a.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'snapshot') {
        clearTimeout(timer);
        resolve(msg.snapshot);
      }
    });
  });

  assert.ok(snapshot.tick > startTick, '伺服器必須持續推進模擬');
  assert.ok(snapshot.enemies.length > 0, '快照應含敵群');
  assert.strictEqual(snapshot.players.length, 1);
  // 欄位名刻意與實體屬性一致（playerColor 而非 color），客戶端才能直接餵給 render 層
  assert.ok(snapshot.players[0].playerColor, '快照玩家必須帶顏色');

  a.ws.close();
});

/** 輪詢等待條件成立 */
function waitFor(predicate, label, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`${label} 逾時`));
      setTimeout(poll, 20);
    };
    poll();
  });
}
