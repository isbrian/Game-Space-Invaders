/**
 * 瀏覽器環境替身：讓遊戲腳本能在 Node 下載入並被斷言。
 * 只 mock 到腳本實際會碰的 API，不追求完整 DOM 實作。
 * ponytail: yagni: 不引入 jsdom/canvas 原生模組 | upgrade if: 開始需要驗證實際繪製像素
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Canvas 2D context 替身：所有繪圖呼叫皆為 no-op，屬性可讀寫
function makeCtxStub() {
  const noop = () => {};
  return new Proxy(
    {
      canvas: null,
      fillStyle: '', strokeStyle: '', shadowColor: '', shadowBlur: 0,
      globalAlpha: 1, lineWidth: 1, font: '', textAlign: ''
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return noop; // save/restore/beginPath/fill/drawImage… 一律吞掉
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      }
    }
  );
}

function makeElementStub(extra = {}) {
  return {
    width: 480,
    height: 640,
    textContent: '',
    value: '',
    className: '',
    style: {},
    children: [],
    getContext: () => makeCtxStub(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 640 }),
    addEventListener: noopListener,
    setPointerCapture: () => {},
    // 分數榜以 createElement + appendChild 組裝，stub 需支援樹狀操作
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    ...extra
  };
}

function noopListener() {}

/**
 * 依 index.html 的順序載入 shared 邏輯層與 js 客戶端腳本到同一個沙箱，
 * 回傳沙箱全域，測試可直接取用 Game / Enemy / Bullet 等類別。
 */
function loadGame() {
  const listeners = {};
  const elements = {};

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Math,
    JSON,
    Date,
    Set,
    Map,
    Object,
    Array,
    Number,
    String,
    Proxy,
    Infinity,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    localStorage: {
      store: {},
      getItem(k) { return k in this.store ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = String(v); }
    },
    document: {
      createElement: () => makeElementStub(),
      getElementById: (id) => {
        if (!elements[id]) elements[id] = makeElementStub();
        return elements[id];
      }
    }
  };

  sandbox.window = sandbox;
  sandbox.window.addEventListener = (type, fn) => {
    (listeners[type] = listeners[type] || []).push(fn);
  };
  // 明確不提供 AudioContext → SoundEngine.ctx 維持 null，所有播放呼叫自動空轉

  vm.createContext(sandbox);

  const root = path.join(__dirname, '..');
  const files = [
    'shared/math.js', 'shared/entities.js', 'shared/world.js',
    'js/audio.js', 'js/engine.js', 'js/render.js',
    'js/net.js', 'js/localRoom.js', 'js/game.js'
  ];
  for (const file of files) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }

  // 腳本頂層的 class/const 宣告落在全域「詞法環境」，不會成為 global 物件的屬性，
  // 測試無法用 sandbox.Game 取得 → 明確搬上 globalThis。
  // 逐一 try/catch：某個符號不存在時（例如拿舊版原始碼對照跑）只跳過該項，
  // 不能讓整批匯出一起炸掉，否則所有測試都會因「載入失敗」而紅，掩蓋真正的行為差異。
  const exported = [
    'MathUtil', 'InputManager', 'Starfield', 'FXManager', 'VIEW',
    'Player', 'Bullet', 'HomingMissile', 'Enemy', 'Bell', 'BombWave', 'BELL_TYPES',
    'World', 'PLAYER_COLORS', 'MAX_PLAYERS', 'NetSession', 'LocalSession',
    'Game', 'soundEngine'
  ];
  vm.runInContext(
    exported.map(n => `try { globalThis.${n} = ${n}; } catch (e) {}`).join('\n'),
    sandbox,
    { filename: 'test/exports.js' }
  );

  sandbox.__elements = elements;
  sandbox.__listeners = listeners;
  return sandbox;
}

/**
 * 建立一個已在遊玩中的 Game 實例。
 * 沙箱沒有 WebSocket，NetSession.connect() 會安靜失敗並退回本地單人房，
 * 這正好也驗證了「伺服器不可用時仍可遊玩」這條路徑。
 */
function newPlayingGame() {
  const env = loadGame();
  const game = new env.Game();
  return { env, game };
}

module.exports = { loadGame, newPlayingGame };
