/**
 * 戰機顏色池
 *
 * 「每位玩家顏色不重複」在此結構性成立：顏色由伺服器單一持有，
 * 進房 take() 取走、離房 release() 歸還，客戶端無從協商也無從指定，
 * 因此不存在兩人同時選到同色的競態。
 */

const { PLAYER_COLORS, MAX_PLAYERS } = require('../shared/world.js');

class ColorPool {
  constructor() {
    // 以索引代表顏色，available 為尚未配發的索引佇列
    this.available = PLAYER_COLORS.map((_, i) => i);
  }

  get size() {
    return this.available.length;
  }

  get isEmpty() {
    return this.available.length === 0;
  }

  /** 取走一個顏色索引；池空回傳 null（代表房間已滿 8 人） */
  take() {
    if (this.isEmpty) return null;
    return this.available.shift();
  }

  /** 歸還顏色索引；忽略重複歸還與非法索引，避免池被灌出幽靈顏色 */
  release(index) {
    if (!Number.isInteger(index)) return false;
    if (index < 0 || index >= MAX_PLAYERS) return false;
    if (this.available.includes(index)) return false;
    this.available.push(index);
    // 保持由小到大配發，讓房內顏色順序穩定可預期
    this.available.sort((a, b) => a - b);
    return true;
  }
}

module.exports = { ColorPool };
