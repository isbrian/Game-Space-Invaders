/**
 * 回歸測試：鎖住歷次修掉的每一個缺陷，避免日後改動再次踩回去。
 * 執行：npm test
 *
 * T-016 起，遊戲規則已由 js/game.js 遷入 [shared/world.js](../shared/world.js)，
 * 因此規則類案例改為直接驅動 World（純 require，不需要瀏覽器沙箱）；
 * 只有真正屬於客戶端的行為（高分落盤、固定步長迴圈）才繼續走 vm 沙箱。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadGame, newPlayingGame } = require('./harness');
const { World } = require('../shared/world.js');
const { Enemy, Bullet, Bell, BombWave } = require('../shared/entities.js');

const STEP = 1 / 60;

/** fx sink 替身：規則測試不關心演出，全部吞掉 */
const nullFx = {
  sound() {}, spawnExplosion() {}, spawnFloatText() {}, spawnSmoke() {}, shake() {}
};

/**
 * 建立一個已開局、場上只有一位玩家的世界。
 * 無敵必須在 startStage() 之後才清：開關卡會讓所有玩家 respawn()，那會重新給無敵。
 */
function newWorld() {
  const world = new World();
  const player = world.addPlayer('p1', { nick: '測試員', colorIndex: 0 });
  world.startStage(1, nullFx);
  player.invulnerableTime = 0; // 測試要自己控制無敵狀態
  return { world, player };
}

// ── 規則類：直接驅動 World ────────────────────────────────

test('BUG-2 清屏炸彈會真正擊毀敵機並計分', () => {
  const { world, player } = newWorld();

  // 敵機必須放在「撞不到玩家」的距離：這個案例過去把敵機擺在玩家正上方 30px，
  // 實際上是被撞機路徑打掉的（敵機 hp 原封不動、玩家還掉一條命），
  // 衝擊波第一步只擴張到半徑 17.7，根本沒碰到它——等於整個案例都測錯了對象。
  world.enemies = [new Enemy('drone', 0, 0, player.x, 300)];
  const scoreBefore = player.score;
  const livesBefore = player.lives;

  player.bombs = 1;
  world.triggerBomb(player, nullFx);

  // 讓衝擊波有時間擴張到目標並累積傷害（10 傷害/秒，drone 只有 1 點 HP）
  for (let i = 0; i < 60; i++) world.update(STEP, nullFx);

  assert.strictEqual(world.enemies[0].alive, false, '敵機應被衝擊波擊毀');
  assert.ok(player.score > scoreBefore, '擊毀應計分');
  assert.strictEqual(player.lives, livesBefore, '這一擊應由炸彈造成，玩家不該掉命');
});

test('BUG-2 炸彈半徑涵蓋畫布對角線（底部施放也打得到頂端編隊）', () => {
  const wave = new BombWave(240, 580);
  assert.ok(wave.maxRadius >= Math.hypot(480, 640) - 1,
    `maxRadius ${wave.maxRadius} 不足以覆蓋全畫面`);
});

test('BUG-4 穿透雷射對同一目標只結算一次傷害', () => {
  const { world } = newWorld();

  const target = new Enemy('boss', 0, 0, 240, 200);
  world.enemies = [target];
  const hpBefore = target.hp;

  // 穿透彈停在敵機正中央，連續多步都維持重疊
  const laser = new Bullet(240, 200, 0, 0, 'laser', 2, true);
  world.bullets = [laser];

  for (let i = 0; i < 10; i++) world.update(STEP, nullFx);

  assert.strictEqual(hpBefore - target.hp, 2,
    '10 步重疊只應扣 1 次傷害（每次 damage=2）');
  assert.strictEqual(laser.alive, true, '穿透彈不應因命中而消失');
});

test('BUG-6 一顆非穿透子彈同一步只能命中一架敵機', () => {
  const { world } = newWorld();

  // 兩架完全重疊的敵機（俯衝/歸隊時實際會發生）
  world.enemies = [
    new Enemy('drone', 0, 0, 240, 200),
    new Enemy('drone', 1, 0, 240, 200)
  ];
  world.bullets = [new Bullet(240, 200, 0, 0, 'vulcan', 1)];

  world.update(STEP, nullFx);

  const dead = world.enemies.filter(e => !e.alive).length;
  assert.strictEqual(dead, 1, `同一步應只擊毀 1 架，實際 ${dead} 架`);
});

test('BUG-3 無敵期間撞擊不會清場', () => {
  const { world, player } = newWorld();

  world.enemies = [
    new Enemy('drone', 0, 0, player.x, player.y),
    new Enemy('drone', 1, 0, player.x, player.y)
  ];
  player.invulnerableTime = 2.5; // 重生無敵
  const livesBefore = player.lives;

  world.update(STEP, nullFx);

  assert.ok(world.enemies.every(e => e.alive), '無敵期間不應撞毀敵機');
  assert.strictEqual(player.lives, livesBefore, '無敵期間不應扣命');
});

test('BUG-3 撞擊 Boss 不會繞過 HP 直接秒殺', () => {
  const { world, player } = newWorld();

  const boss = new Enemy('boss', 0, 0, player.x, player.y);
  world.enemies = [boss];
  player.invulnerableTime = 0;
  player.shields = 0;
  const livesBefore = player.lives;

  world.update(STEP, nullFx);

  assert.strictEqual(boss.alive, true, 'Boss 是固定旗艦，不應被撞毀');
  assert.strictEqual(boss.hp, boss.maxHp, 'Boss HP 不應被撞擊扣除');
  assert.strictEqual(player.lives, livesBefore - 1, '玩家應付出一條命');
});

test('BUG-3 撞毀一般敵機會正常計分', () => {
  const { world, player } = newWorld();

  world.enemies = [new Enemy('drone', 0, 0, player.x, player.y)];
  player.invulnerableTime = 0;
  player.shields = 0;
  const scoreBefore = player.score;

  world.update(STEP, nullFx);

  assert.strictEqual(world.enemies[0].alive, false, '一般敵機應同歸於盡');
  assert.ok(player.score > scoreBefore, '撞毀敵機應計分（過去完全不給分）');
});

test('BUG-7 鈴鐺反彈全程不會跑出畫布', () => {
  const bell = new Bell(470, 300);
  bell.vx = 200; // 強制往右衝

  // 必須檢查整段軌跡：只看最終位置的話，鈴鐺來回彈完剛好落在界內，
  // 會放過「中途衝出右緣 20px 才反彈」這個實際缺陷。
  let maxX = -Infinity;
  let minX = Infinity;
  for (let i = 0; i < 240; i++) {
    bell.update(STEP);
    maxX = Math.max(maxX, bell.x);
    minX = Math.min(minX, bell.x);
  }

  assert.ok(maxX <= 480 - bell.radius, `鈴鐺曾抵達 x=${maxX}，超出畫布右緣`);
  assert.ok(minX >= bell.radius, `鈴鐺曾抵達 x=${minX}，超出畫布左緣`);
});

test('BUG-8 過關倒數走遊戲時間，不推進就不會跳關', () => {
  const { world } = newWorld();

  world.enemies = [new Enemy('drone', 0, 0, 240, 200)];
  world.enemies[0].alive = false;
  world.update(STEP, nullFx); // 觸發 stageClear
  assert.strictEqual(world.state, 'STAGECLEAR');

  const levelAtClear = world.level;
  // 暫停 = 不再呼叫 update()，關卡自然不推進（倒數綁在遊戲時間上，不是 setTimeout）
  assert.strictEqual(world.level, levelAtClear, '未推進時不應跳關');

  for (let i = 0; i < 200; i++) world.update(STEP, nullFx);
  assert.strictEqual(world.level, levelAtClear + 1, '恢復推進後應進入下一關');
  assert.strictEqual(world.state, 'PLAYING');
});

test('BUG-8 過關期間重開新關不會被舊倒數改寫關卡', () => {
  const { world } = newWorld();

  world.level = 5;
  world.enemies = [new Enemy('drone', 0, 0, 240, 200)];
  world.enemies[0].alive = false;
  world.update(STEP, nullFx); // 進入 STAGECLEAR
  assert.strictEqual(world.state, 'STAGECLEAR');

  world.startStage(1, nullFx); // 重開第 1 關
  for (let i = 0; i < 300; i++) world.update(STEP, nullFx);

  assert.strictEqual(world.level, 1, '新局應停在第 1 關，不該被舊倒數 +1');
});

test('開新關會清乾淨上一關的殘留計時器', () => {
  const { world } = newWorld();

  world.swarmTimer = 99;
  world.diveTimer = 99;

  world.startStage(2, nullFx);

  assert.strictEqual(world.swarmTimer, 0);
  assert.strictEqual(world.diveTimer, 0);
  assert.strictEqual(world.stageClearTimer, 0);
});

test('Boss 關卡造型只抽選一次且落在有效範圍', () => {
  const { world } = newWorld();

  world.startStage(3, nullFx);

  const boss = world.enemies.find(e => e.type === 'boss');
  assert.ok(boss, '第 3 關應為魔王關');
  assert.ok(Number.isInteger(boss.bossStyle) && boss.bossStyle >= 0 && boss.bossStyle <= 3);
  assert.strictEqual(world.bossStyle, undefined, 'World 不應保留重複的 bossStyle 欄位');
});

// ── Boss 戰平衡（T-013）──────────────────────────────────
//
// 這幾項鎖住的是「體感」而非某個缺陷：Boss HP 24 曾讓首領戰 2.3 秒就結束。
// 數值由 headless 模擬回推，所以驗收也用同一套模擬，改動數值時會立刻現形。

/**
 * 模擬一場魔王戰：玩家在底部橫向跟住 Boss、持續開火。
 * 得到的是「理想操作」的 TTK 下界；無敵是為了隔離火力量測，不讓中彈打斷。
 */
function simulateBossFight({ players = 1, weaponLevel = 4, spread = 0, maxSeconds = 200 } = {}) {
  const world = new World();
  for (let i = 0; i < players; i++) world.addPlayer(`p${i}`, { nick: `p${i}`, colorIndex: i });
  world.startStage(3, nullFx); // 每 3 關為魔王關

  const ps = [...world.players.values()];
  ps.forEach(p => { p.weaponLevel = weaponLevel; });
  const boss = world.enemies.find(e => e.type === 'boss');

  let steps = 0;
  const limit = Math.round(maxSeconds / STEP);
  const damageBefore = boss.maxHp;
  while (boss.alive && steps < limit) {
    ps.forEach((p, i) => {
      p.invulnerableTime = 60;
      const offset = (i - (ps.length - 1) / 2) * spread;
      world.applyInput(p.id, { x: boss.x + offset, y: 580, fire: true }, STEP, nullFx);
    });
    world.update(STEP, nullFx);
    steps++;
  }
  return { ttk: steps * STEP, killed: !boss.alive, boss, damageDealt: damageBefore - boss.hp };
}

test('T-013 單人滿火力的 Boss 戰長度落在 20~30 秒', () => {
  const { ttk, killed } = simulateBossFight({ players: 1, weaponLevel: 4 });

  assert.ok(killed, 'Boss 應在時限內被擊毀');
  assert.ok(ttk >= 20 && ttk <= 30,
    `單人 Lv4 的 TTK 應落在 20~30 秒，實測 ${ttk.toFixed(2)} 秒`);
});

test('T-013 Boss HP 隨人數線性縮放，8 人場的戰鬥長度與單人同量級', () => {
  const solo = simulateBossFight({ players: 1, weaponLevel: 4 });
  const full = simulateBossFight({ players: 8, weaponLevel: 4 });

  assert.strictEqual(full.boss.maxHp, Enemy.BOSS_BASE_HP * 8, '8 人場 HP 應為單人的 8 倍');
  assert.ok(full.killed, '8 人場的 Boss 也應被擊毀');
  assert.ok(Math.abs(full.ttk - solo.ttk) < 5,
    `8 人場 TTK ${full.ttk.toFixed(2)} 秒應與單人 ${solo.ttk.toFixed(2)} 秒同量級`);
});

test('T-013 火力等級越高，對 Boss 的輸出單調不減', () => {
  // 固定 15 秒視窗內對 Boss 造成的傷害；比跑到擊毀便宜，且直接表達這條性質。
  // Lv3 曾因「單發集中彈對擺盪目標命中率低於兩發並排彈」而弱於 Lv2，
  // 吃白鈴鐺升級反而降低對 Boss 的輸出。
  const damage = [1, 2, 3, 4].map(weaponLevel =>
    simulateBossFight({ weaponLevel, maxSeconds: 15 }).damageDealt);

  damage.forEach((d, i) => {
    if (i === 0) return;
    assert.ok(d >= damage[i - 1],
      `Lv${i + 1} 的輸出 ${d.toFixed(1)} 不應低於 Lv${i} 的 ${damage[i - 1].toFixed(1)}`);
  });
});

test('T-013 Boss 彈幕依剩餘血量切換三個階段', () => {
  const boss = new Enemy('boss', 0, 0, 240, 105);
  const phases = [0.9, 0.5, 0.1].map(ratio => {
    boss.hp = boss.maxHp * ratio;
    return boss.bossPhase();
  });

  assert.strictEqual(new Set(phases).size, 3, '三段血量應對應三個相異階段');
  phases.forEach((p, i) => {
    if (i === 0) return;
    assert.ok(p.spread.length >= phases[i - 1].spread.length, '彈數不應隨血量下降而減少');
    assert.ok(p.interval < phases[i - 1].interval, '間隔應隨血量下降而縮短');
    assert.ok(p.speed > phases[i - 1].speed, '彈速應隨血量下降而提升');
  });

  boss.hp = 0;
  assert.strictEqual(boss.bossPhase(), phases[2], '血量歸零應落在最後一階，不可回傳 undefined');
});

test('快照欄位與實體屬性同名，可直接餵給 render 層', () => {
  const { world, player } = newWorld();
  world.playerFire(player, nullFx);
  world.update(STEP, nullFx);

  const snap = world.snapshot();
  const enemy = snap.enemies[0];

  ['type', 'x', 'y', 'angle', 'bossStyle', 'alive'].forEach(key => {
    assert.ok(key in enemy, `敵機快照缺少 render 需要的欄位：${key}`);
  });
  ['id', 'nick', 'playerColor', 'x', 'y', 'lives', 'score', 'invulnerableTime'].forEach(key => {
    assert.ok(key in snap.players[0], `玩家快照缺少欄位：${key}`);
  });
  assert.ok(snap.bullets.every(b => 'vx' in b && 'vy' in b), '子彈需帶速度供客戶端外推');
  assert.ok(snap.enemies.every(e => Number.isInteger(e.eid)), '敵機需帶 eid 供客戶端內插對應');
});

// ── 多人玩法規則（T-017）──────────────────────────────────

test('陣亡後進入 3 秒重生倒數，期間不可操作也不被擊中', () => {
  const { world, player } = newWorld();
  world.enemies = [];

  player.shields = 0;
  player.hit(nullFx);

  assert.strictEqual(player.lives, 2, '應扣一條命');
  assert.ok(Math.abs(player.respawnTimer - 3) < 0.001, '應進入 3 秒重生倒數');
  assert.strictEqual(player.isActive, false, '倒數期間不算在場上');

  // 倒數中的輸入一律不生效
  const xBefore = player.x;
  world.applyInput('p1', { x: xBefore + 50, y: player.y, fire: true }, STEP, nullFx);
  assert.strictEqual(player.x, xBefore, '倒數期間不吃移動輸入');
  assert.strictEqual(world.bullets.length, 0, '倒數期間不能開火');

  // 倒數中不被敵彈擊中
  world.enemyBullets = [new Bullet(player.x, player.y, 0, 0, 'enemy')];
  world.update(STEP, nullFx);
  assert.strictEqual(player.lives, 2, '倒數期間不應再被扣命');
});

test('重生倒數結束後歸位並獲得無敵', () => {
  const { world, player } = newWorld();
  world.enemies = [];
  player.shields = 0;
  player.x = 400;
  player.hit(nullFx);

  for (let i = 0; i < Math.ceil(3 / STEP) + 2; i++) world.update(STEP, nullFx);

  assert.strictEqual(player.respawnTimer, 0, '倒數應歸零');
  assert.strictEqual(player.isActive, true, '應重新上場');
  assert.strictEqual(player.x, 240, '應歸位到畫面底部中央');
  assert.ok(player.invulnerableTime > 0, '重生應給無敵時間');
});

test('命盡轉為觀戰，下一關自動復歸', () => {
  const { world, player } = newWorld();
  world.enemies = [];
  player.shields = 0;

  // 連續打光三條命
  for (let i = 0; i < 3; i++) {
    player.respawnTimer = 0;
    player.invulnerableTime = 0;
    player.hit(nullFx);
  }

  assert.strictEqual(player.lives, 0);
  assert.strictEqual(player.isActive, false, '命盡者不在場上');
  assert.strictEqual(world.spectators().length, 1, '應計入觀戰者');

  // 命盡者不該被重生倒數救回來
  for (let i = 0; i < 300; i++) world.update(STEP, nullFx);
  assert.strictEqual(player.lives, 0, '命盡後不應自行重生');

  world.startStage(2, nullFx);

  assert.strictEqual(player.lives, 3, '下一關應補滿生命復歸');
  assert.strictEqual(player.isActive, true, '應重返戰場');
  assert.strictEqual(world.spectators().length, 0);
});

test('中途加入者立刻可操作並帶進場保護', () => {
  const { world } = newWorld();
  const late = world.addPlayer('late', { nick: '遲到的人', colorIndex: 1 });

  assert.strictEqual(late.isActive, true, '中途加入者應立即在場上');
  assert.ok(late.invulnerableTime > 0, '應給進場保護');

  world.applyInput('late', { x: late.x + 10, y: late.y, fire: true }, STEP, nullFx);
  assert.ok(world.bullets.length > 0, '中途加入者應能立刻開火');
});

test('8 人同場各拿相異顏色且都在場上', () => {
  const world = new World();
  for (let i = 0; i < 8; i++) world.addPlayer(`p${i}`, { nick: `玩家${i}`, colorIndex: i });
  world.startStage(1, nullFx);

  const colors = [...world.players.values()].map(p => p.playerColor);
  assert.strictEqual(new Set(colors).size, 8, '8 人顏色必須完全不重複');
  assert.strictEqual(world.alivePlayers().length, 8, '8 人都應在場上');

  const snap = world.snapshot();
  assert.strictEqual(snap.players.length, 8);
  assert.ok(snap.players.every(p => p.playerColor && 'isActive' in p && 'respawnTimer' in p),
    '快照需帶顏色與在場狀態供客戶端渲染分數榜');
});

// ── 客戶端類：走 vm 沙箱 ──────────────────────────────────

test('高分紀錄：localStorage 被污染時不會顯示 NaN', () => {
  const env = loadGame();
  env.localStorage.setItem('galaxy_hiscore', 'corrupted');

  const game = new env.Game();

  assert.strictEqual(game.highScore, 10000, '污染值應回退為預設 10000');
  assert.ok(!env.__elements.highScoreVal.textContent.includes('NaN'));
});

test('高分只在結算時落盤，不在每次命中時寫入', () => {
  const { env, game } = newPlayingGame();

  let writes = 0;
  const origSet = env.localStorage.setItem.bind(env.localStorage);
  env.localStorage.setItem = (k, v) => { writes++; origSet(k, v); };

  // 一路刷新高分：HUD 每幀都會讀到新分數，但不該每次都落盤
  const me = game.session.world.players.get('local');
  for (let i = 0; i < 50; i++) {
    me.score += 1000;
    game.updateHUD();
  }

  assert.strictEqual(writes, 0, '遊玩期間不應寫 localStorage');
  assert.strictEqual(game.highScore, 50000, '記憶體中的高分仍應即時更新');

  game.persistHighScore();
  assert.strictEqual(writes, 1, '結算應落盤一次');
  assert.strictEqual(env.localStorage.getItem('galaxy_hiscore'), '50000');
});

test('固定步長：模擬推進量與螢幕更新率無關', () => {
  const { game: g60 } = newPlayingGame();
  const { game: g144 } = newPlayingGame();

  // 同樣的 1 秒牆鐘時間，分別以 60Hz 與 144Hz 的節奏餵給 loop()
  for (let i = 1; i <= 60; i++) g60.loop(i * (1000 / 60));
  for (let i = 1; i <= 144; i++) g144.loop(i * (1000 / 144));

  assert.strictEqual(
    g60.session.world.swarmTimer.toFixed(4),
    g144.session.world.swarmTimer.toFixed(4),
    '不同更新率下蜂群相位應一致'
  );
});

test('伺服器不可用時自動退回本地單人房', () => {
  const { game } = newPlayingGame(); // 沙箱無 WebSocket，連線必然失敗

  assert.strictEqual(game.net.status, 'offline', '連不上時 NetSession 應為 offline');
  assert.strictEqual(game.session, game.local, '應改用本地單人房');
  assert.ok(game.session.getState().enemies.length > 0, '本地房仍應正常生成敵群');

  for (let i = 0; i < 60; i++) game.update(STEP);
  assert.ok(game.session.world.tick > 0, '本地房必須持續推進模擬');
});

// ── 客戶端內插：NetSession 純邏輯 ─────────────────────────

test('快照之間以 eid 對應敵機，內插不會跳位', () => {
  const env = loadGame();
  const net = new env.NetSession();

  net.applySnapshot({
    tick: 1, level: 1, state: 'PLAYING', isBossStage: false,
    players: [], enemies: [{ eid: 7, type: 'drone', x: 100, y: 100, angle: 0, bossStyle: 0, hp: 1, maxHp: 1, alive: true }],
    bullets: [], enemyBullets: [], missiles: [], bells: [], bombWaves: []
  });
  const first = net.getState().enemies[0];
  assert.strictEqual(first.x, 100);

  // 同一架敵機（eid 相同）移動到新位置：顯示座標應留在原地，只更新目標
  net.applySnapshot({
    tick: 2, level: 1, state: 'PLAYING', isBossStage: false,
    players: [], enemies: [{ eid: 7, type: 'drone', x: 200, y: 100, angle: 0, bossStyle: 0, hp: 1, maxHp: 1, alive: true }],
    bullets: [], enemyBullets: [], missiles: [], bells: [], bombWaves: []
  });
  const same = net.getState().enemies[0];
  assert.strictEqual(same, first, 'eid 相同應復用同一個顯示物件');
  assert.strictEqual(same.x, 100, '收到快照當下不應瞬移');
  assert.strictEqual(same.targetX, 200, '應設定新的內插目標');

  net.advance(1 / 60);
  assert.ok(same.x > 100 && same.x < 200, `應朝目標靠攏，實際 x=${same.x}`);
});

test('消失的敵機會從內插表移除，不會留下幽靈', () => {
  const env = loadGame();
  const net = new env.NetSession();
  const snap = (enemies) => ({
    tick: 1, level: 1, state: 'PLAYING', isBossStage: false,
    players: [], enemies, bullets: [], enemyBullets: [], missiles: [], bells: [], bombWaves: []
  });

  net.applySnapshot(snap([
    { eid: 1, type: 'drone', x: 10, y: 10, angle: 0, bossStyle: 0, hp: 1, maxHp: 1, alive: true },
    { eid: 2, type: 'drone', x: 20, y: 20, angle: 0, bossStyle: 0, hp: 1, maxHp: 1, alive: true }
  ]));
  assert.strictEqual(net.enemyView.size, 2);

  net.applySnapshot(snap([
    { eid: 1, type: 'drone', x: 10, y: 10, angle: 0, bossStyle: 0, hp: 1, maxHp: 1, alive: true }
  ]));
  assert.strictEqual(net.enemyView.size, 1, '被擊毀的敵機必須從內插表移除');
  assert.strictEqual(net.getState().enemies.length, 1);
});

test('子彈以速度外推，補平 20Hz 快照之間的空檔', () => {
  const env = loadGame();
  const net = new env.NetSession();

  net.applySnapshot({
    tick: 1, level: 1, state: 'PLAYING', isBossStage: false,
    players: [], enemies: [],
    bullets: [{ x: 240, y: 400, vx: 0, vy: -560, type: 'vulcan' }],
    enemyBullets: [], missiles: [], bells: [], bombWaves: []
  });

  net.advance(1 / 60);
  const bullet = net.getState().bullets[0];
  assert.ok(Math.abs(bullet.y - (400 - 560 / 60)) < 0.01,
    `子彈應沿速度外推，實際 y=${bullet.y}`);
});
