/**
 * 共用數學與視界常數（瀏覽器與 Node 權威伺服器共用）
 *
 * 本檔與 shared/ 底下所有模組一律零 DOM、零 Web Audio 相依，
 * 才能同時被瀏覽器 <script> 與伺服器 require() 載入。
 */

// 碰撞與數學輔助函式
const MathUtil = {
  clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  },
  dist(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.hypot(dx, dy);
  },
  // 圓形碰撞檢測
  circleIntersect(c1, c2) {
    const dx = c1.x - c2.x;
    const dy = c1.y - c2.y;
    const r = (c1.radius || 10) + (c2.radius || 10);
    return (dx * dx + dy * dy) <= (r * r);
  },
  // 三次貝茲曲線採樣 (小蜜蜂俯衝航跡專用)
  cubicBezier(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;

    return {
      x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
      y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
    };
  },
  // 大蜜蜂特色：牽引光束梯形區域包含判定（T-008 牽引光束預留，尚未接線）
  pointInBeam(px, py, originX, originY, widthTop, widthBottom, length) {
    if (py < originY || py > originY + length) return false;
    const progress = (py - originY) / length;
    const currentHalfW = (widthTop / 2) + progress * ((widthBottom - widthTop) / 2);
    return Math.abs(px - originX) <= currentHalfW;
  }
};

// 畫布尺寸單一事實來源：實體的出界判定不再各自寫死魔數
const VIEW = { width: 480, height: 640, margin: 40 };

// ponytail: one-liner: 同一份檔案同時餵瀏覽器 <script> 與 Node require()
// upgrade if: 專案導入打包工具，屆時全面改 ESM export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MathUtil, VIEW };
}
