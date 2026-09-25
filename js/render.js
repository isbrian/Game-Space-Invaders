/**
 * 實體渲染模組（瀏覽器專屬）
 *
 * [shared/entities.js](../shared/entities.js) 只保留遊戲規則，一切繪圖集中於此。
 * 繪圖能力以 prototype 掛回各實體類別，呼叫端維持 `entity.draw(ctx)` 的既有寫法，
 * shared 層因此得以完全零 DOM，而 game.js 不需為了抽層改動任何一行繪製程式碼。
 *
 * ponytail: one-liner: prototype 掛載取代「把 draw 全改成 Render.drawX(ctx, e)」
 * upgrade if: 實體種類多到需要獨立的 renderer registry，再改註冊表
 */

/**
 * 離屏精靈快取：把帶 shadowBlur 光暈的向量圖預先烘焙成小 canvas，
 * 熱路徑（子彈／敵機／鈴鐺，同幀可達數百個）只做 drawImage。
 * ponytail: native: OffscreenCanvas 語意用 <canvas> 元素即可 | upgrade if: 需 Worker 中繪製再換 OffscreenCanvas
 */
function makeSprite(width, height, drawFn) {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const c = cv.getContext('2d');
  c.translate(width / 2, height / 2); // 原點置中，呼叫端以中心座標貼圖
  drawFn(c);
  return cv;
}

// 將預烘焙精靈以中心點貼至目標座標
function drawSprite(ctx, sprite, x, y) {
  ctx.drawImage(sprite, x - sprite.width / 2, y - sprite.height / 2);
}

// 子彈外觀只有 3 種且永不變化 → 啟動時烘焙一次，熱路徑省下每顆每幀的 shadowBlur
const BULLET_SPRITES = {
  laser: makeSprite(30, 54, (c) => {
    c.fillStyle = '#3fe2ff';
    c.shadowColor = '#3fe2ff';
    c.shadowBlur = 10;
    c.fillRect(-3, -14, 6, 28);
  }),
  enemy: makeSprite(24, 24, (c) => {
    c.fillStyle = '#ff4757';
    c.shadowColor = '#ff4757';
    c.shadowBlur = 6;
    c.beginPath();
    c.arc(0, 0, 3.5, 0, Math.PI * 2);
    c.fill();
  }),
  vulcan: makeSprite(20, 32, (c) => {
    c.fillStyle = '#ffd32a';
    c.shadowColor = '#ffd32a';
    c.shadowBlur = 6;
    c.fillRect(-2, -8, 4, 14);
  })
};

const MISSILE_SPRITE = makeSprite(28, 44, (c) => {
  c.fillStyle = '#ffffff';
  c.shadowColor = '#3fe2ff';
  c.shadowBlur = 9;
  c.fillRect(-3, -9, 6, 18);
  c.shadowBlur = 0;
  c.fillStyle = '#3fe2ff';
  c.fillRect(-2, -12, 4, 6);
});

// 一般敵機共用同一組昆蟲輪廓，只有主色不同 → 依型別各烘焙一張
const ENEMY_SPRITES = (() => {
  const palette = { drone: '#ffd32a', guard: '#ff4757', carrier: '#ff78ae', default: '#2ed573' };
  const bake = (color) => makeSprite(42, 42, (c) => {
    c.fillStyle = color;
    c.shadowColor = color;
    c.shadowBlur = 6;
    c.beginPath();
    c.moveTo(0, -12);
    c.lineTo(-13, -2);
    c.lineTo(-6, 8);
    c.lineTo(0, 13);
    c.lineTo(6, 8);
    c.lineTo(13, -2);
    c.closePath();
    c.fill();

    // 觸角與複眼
    c.shadowBlur = 0;
    c.fillStyle = '#060a14';
    c.fillRect(-6, -4, 4, 4);
    c.fillRect(2, -4, 4, 4);
  });
  return Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, bake(v)]));
})();

// 鈴鐺 5 種顏色各烘焙一張；顏色只在 juggle() 時切換，形狀恆定
const BELL_SPRITES = BELL_TYPES.map(({ color }) => makeSprite(46, 46, (c) => {
  // 鈴鐺本體
  c.fillStyle = color;
  c.shadowColor = color;
  c.shadowBlur = 9;
  c.beginPath();
  c.arc(0, -2, 10, Math.PI, 0, false);
  c.lineTo(11, 8);
  c.lineTo(-11, 8);
  c.closePath();
  c.fill();

  // 鈴鐺頂部提把
  c.strokeStyle = color;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(0, -11, 3, 0, Math.PI * 2);
  c.stroke();

  // 底部撞錘
  c.shadowBlur = 0;
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.arc(0, 8, 3, 0, Math.PI * 2);
  c.fill();
}));

// ── 玩家戰機 ──────────────────────────────────────────────

/**
 * 機身繪製。
 * 刻意寫成獨立函式而非 prototype 方法：draw() 會被 `Player.prototype.draw.call(快照物件)`
 * 用來繪製其他玩家，而快照是沒有任何方法的 plain object，
 * 呼叫 this.drawShipBody() 會直接炸掉。改吃參數就兩邊通用。
 */
function drawShipBody(ctx, ship) {
  // 尾焰特效
  const flameH = 8 + Math.random() * 8;
  ctx.fillStyle = '#ff9f43';
  ctx.beginPath();
  ctx.moveTo(-4, 14);
  ctx.lineTo(4, 14);
  ctx.lineTo(0, 14 + flameH);
  ctx.closePath();
  ctx.fill();

  // 機身主體 (雷電/小蜜蜂風格三角機翼)
  const shipColor = ship.playerColor || '#3fe2ff';
  ctx.fillStyle = shipColor;
  ctx.shadowColor = shipColor;
  ctx.shadowBlur = 8;

  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.lineTo(-15, 12);
  ctx.lineTo(-5, 8);
  ctx.lineTo(0, 14);
  ctx.lineTo(5, 8);
  ctx.lineTo(15, 12);
  ctx.closePath();
  ctx.fill();

  // 駕駛艙機首高光
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, -14);
  ctx.lineTo(-3, -2);
  ctx.lineTo(3, -2);
  ctx.closePath();
  ctx.fill();

  // 雙側砲管 (依武器等級顯現)
  if (ship.weaponLevel >= 2) {
    ctx.fillStyle = '#ffd32a';
    ctx.fillRect(-14, -4, 3, 10);
    ctx.fillRect(11, -4, 3, 10);
  }
}

Player.prototype.draw = function (ctx) {
  // 無敵閃爍：相位綁定剩餘無敵時間，暫停時一併凍結（原本用 Date.now() 會繼續閃）
  if (this.invulnerableTime > 0 && Math.floor(this.invulnerableTime * 12.5) % 2 === 0) {
    return;
  }

  ctx.save();
  ctx.translate(this.x, this.y);

  if (this.isDual) {
    // 雙機合體連動橫桿
    ctx.fillStyle = '#24355a';
    ctx.fillRect(-18, 2, 36, 4);

    ctx.save();
    ctx.translate(-16, 0);
    drawShipBody(ctx, this);
    ctx.restore();

    ctx.save();
    ctx.translate(16, 0);
    drawShipBody(ctx, this);
    ctx.restore();
  } else {
    if (this.beingCaptured) {
      ctx.rotate(this.captureAngle);
    }
    drawShipBody(ctx, this);
  }

  // 護盾光環 (兵蜂紅鈴能量罩)
  if (this.shields > 0) {
    ctx.strokeStyle = '#2ed573';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#2ed573';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(0, 0, (this.isDual ? 26 : this.radius) + 8, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
};

// ── 子彈與飛彈 ────────────────────────────────────────────

Bullet.prototype.draw = function (ctx) {
  drawSprite(ctx, BULLET_SPRITES[this.type] || BULLET_SPRITES.vulcan, this.x, this.y);
};

HomingMissile.prototype.draw = function (ctx) {
  if (!this.alive) return;
  ctx.save();
  ctx.translate(this.x, this.y);
  ctx.rotate(Math.atan2(this.vy, this.vx) + Math.PI / 2);
  drawSprite(ctx, MISSILE_SPRITE, 0, 0);
  ctx.restore();
};

// ── 敵機 ──────────────────────────────────────────────────

Enemy.prototype.draw = function (ctx) {
  if (!this.alive) return;
  ctx.save();
  ctx.translate(this.x, this.y);
  ctx.rotate(this.angle);

  let color = '#2ed573';
  if (this.type === 'boss') {
    // 四種 Boss 使用完全不同的主色與輪廓，讓隨機形象一眼可辨
    color = ['#a55eea', '#ff4757', '#3fe2ff', '#ffd32a'][this.bossStyle];
  } else if (this.type === 'guard') color = '#ff4757';
  else if (this.type === 'drone') color = '#ffd32a';
  else if (this.type === 'carrier') color = '#ff78ae';

  if (this.type === 'boss') {
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.scale(2.35, 2.35);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;

    // 四種差異明確的魔王：蟲王、骷髏蜂、機械蜂、王冠蜂
    ctx.beginPath();
    if (this.bossStyle === 0) {
      // 蟲王：巨大甲殼 + 左右尖角
      ctx.moveTo(0, -25); ctx.lineTo(-25, -12); ctx.lineTo(-31, 8);
      ctx.lineTo(-17, 24); ctx.lineTo(0, 17); ctx.lineTo(17, 24);
      ctx.lineTo(31, 8); ctx.lineTo(25, -12); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffd32a';
      ctx.fillRect(-27, -2, 9, 5); ctx.fillRect(18, -2, 9, 5);
    } else if (this.bossStyle === 1) {
      // 骷髏蜂：圓形頭骨 + 巨大眼窩 + 下顎
      ctx.arc(0, -2, 25, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#060a14';
      ctx.beginPath(); ctx.arc(-10, -6, 8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(10, -6, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(-11, 11, 22, 9);
    } else if (this.bossStyle === 2) {
      // 機械蜂：寬體機甲 + 四支砲塔 + 中央核心
      ctx.moveTo(-27, -18); ctx.lineTo(27, -18); ctx.lineTo(31, 14);
      ctx.lineTo(18, 25); ctx.lineTo(-18, 25); ctx.lineTo(-31, 14); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#060a14';
      ctx.fillRect(-35, -5, 8, 20); ctx.fillRect(27, -5, 8, 20);
      ctx.fillRect(-7, -12, 14, 28);
      ctx.fillStyle = '#ff4757';
      ctx.fillRect(-5, -5, 10, 10);
    } else {
      // 王冠蜂：皇冠 + 寬大披風式翼甲
      ctx.moveTo(-31, -5); ctx.lineTo(-22, -27); ctx.lineTo(-8, -16);
      ctx.lineTo(0, -31); ctx.lineTo(8, -16); ctx.lineTo(22, -27);
      ctx.lineTo(31, -5); ctx.lineTo(24, 20); ctx.lineTo(0, 28);
      ctx.lineTo(-24, 20); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff3a3';
      ctx.fillRect(-18, -20, 36, 5);
      ctx.fillStyle = '#060a14';
      ctx.fillRect(-12, -2, 7, 7); ctx.fillRect(5, -2, 7, 7);
      ctx.fillRect(-7, 12, 14, 5);
    }
  } else {
    // 小蜜蜂經典翅膀與昆蟲腹部造型（預烘焙，免除每機每幀的 shadowBlur）
    drawSprite(ctx, ENEMY_SPRITES[this.type] || ENEMY_SPRITES.default, 0, 0);
  }

  ctx.restore();
};

// ── 鈴鐺與衝擊波 ──────────────────────────────────────────

Bell.prototype.draw = function (ctx) {
  ctx.save();
  ctx.translate(this.x, this.y);
  ctx.rotate(Math.sin(this.age * 8.3) * 0.15); // 左右微微晃動
  drawSprite(ctx, BELL_SPRITES[this.typeIndex], 0, 0);
  ctx.restore();
};

BombWave.prototype.draw = function (ctx) {
  ctx.save();
  const alpha = Math.max(0, 1 - this.currentRadius / this.maxRadius);

  // 衝擊波外環
  ctx.strokeStyle = '#a55eea';
  ctx.lineWidth = 6;
  ctx.globalAlpha = alpha;
  ctx.shadowColor = '#d980fa';
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.arc(this.x, this.y, this.currentRadius, 0, Math.PI * 2);
  ctx.stroke();

  // 內層高溫光暈
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(this.x, this.y, Math.max(0, this.currentRadius - 12), 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
};
