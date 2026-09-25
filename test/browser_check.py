#!/usr/bin/env python3
"""
真實瀏覽器端對端測試：Node harness 用的是 stub canvas，驗證不到繪製層與真實連線。
這支腳本在 Chromium 實跑遊戲，確認：
  1. 載入與遊玩期間沒有 console error / page error
  2. 精靈快取真的被烘焙出來，且尺寸足以容納光暈（不會被裁切）
  3. 遊戲迴圈持續推進、畫面確實有畫出東西（非全黑）
  4. 兩個分頁能看到彼此移動與射擊，且顏色不重複（T-016 驗收核心）
  5. 伺服器不可用時自動退回本地單人房，仍可完整遊玩
執行：python3 test/browser_check.py
"""
import http.server
import json
import os
import pathlib
import re
import socketserver
import subprocess
import sys
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []
PASSES = []


def check(name, ok, detail=""):
    (PASSES if ok else FAILURES).append(name)
    print(f"{'ok  ' if ok else 'FAIL'} - {name}{(' :: ' + detail) if detail else ''}")


def start_game_server():
    """啟動真正的權威伺服器，從 stdout 解析它實際綁定的埠"""
    env = {**os.environ, "PORT": "0"}
    proc = subprocess.Popen(
        ["node", "server/server.js"], cwd=str(ROOT), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        match = re.search(r"http://localhost:(\d+)", line)
        if match:
            # 後續輸出要持續排空，否則 stdout 緩衝填滿會讓伺服器卡住
            threading.Thread(target=lambda: [l for l in proc.stdout], daemon=True).start()
            return proc, int(match.group(1))
    proc.kill()
    raise RuntimeError("遊戲伺服器啟動失敗")


def start_static_server():
    """純靜態伺服器（不支援 WebSocket），用來驗證離線退回路徑"""
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(ROOT), **kw)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def attach_error_capture(page, sink):
    page.on("console", lambda m: sink.append(f"console.{m.type}: {m.text}")
            if m.type == "error" else None)
    page.on("pageerror", lambda e: sink.append(f"pageerror: {e}"))


def wait_online(page, timeout=10000):
    page.wait_for_function("() => window.game && game.net.status === 'online'", timeout=timeout)


def main():
    server_proc, port = start_game_server()
    errors = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ── 單頁：渲染與遊玩 ──────────────────────────────
            page = browser.new_page(viewport={"width": 900, "height": 1200})
            attach_error_capture(page, errors)
            page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="load")
            wait_online(page)

            check("頁面載入無 JS 錯誤", not errors, "; ".join(errors[:3]))
            check("已連上權威伺服器",
                  page.evaluate("() => game.net.status") == "online",
                  page.evaluate("() => game.net.roomId + ' / ' + game.net.colorName"))

            sprites = page.evaluate("""() => ({
                bullets: Object.fromEntries(Object.entries(BULLET_SPRITES)
                    .map(([k, v]) => [k, [v.width, v.height]])),
                enemies: Object.fromEntries(Object.entries(ENEMY_SPRITES)
                    .map(([k, v]) => [k, [v.width, v.height]])),
                bells: BELL_SPRITES.map(v => [v.width, v.height]),
                missile: [MISSILE_SPRITE.width, MISSILE_SPRITE.height]
            })""")
            check("子彈精靈已烘焙 3 種", len(sprites["bullets"]) == 3, json.dumps(sprites["bullets"]))
            check("敵機精靈已烘焙 4 種", len(sprites["enemies"]) == 4, json.dumps(sprites["enemies"]))
            check("鈴鐺精靈已烘焙 5 種", len(sprites["bells"]) == 5)
            # vulcan 裸圖 4x14 + shadowBlur 6 → 至少需 16x26
            vw, vh = sprites["bullets"]["vulcan"]
            check("vulcan 精靈尺寸容得下光暈", vw >= 16 and vh >= 26, f"{vw}x{vh}")
            # 敵機裸圖 26x25 + shadowBlur 6 → 至少需 38x37
            ew, eh = sprites["enemies"]["drone"]
            check("敵機精靈尺寸容得下光暈", ew >= 38 and eh >= 37, f"{ew}x{eh}")

            # 精靈非空白：首次啟動 Chromium 時帶 shadowBlur 的路徑 raster 偶爾尚未完成
            # 就被 getImageData 讀到，故給少量重試避免誤報。
            opaque = 0
            for _ in range(5):
                opaque = page.evaluate("""() => {
                    const s = ENEMY_SPRITES.drone;
                    const d = s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
                    let n = 0;
                    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
                    return n;
                }""")
                if opaque > 200:
                    break
                page.wait_for_timeout(200)
            check("敵機精靈確實畫出內容", opaque > 200, f"不透明像素 {opaque}")

            page.wait_for_timeout(1200)
            state = page.evaluate("""() => {
                const s = game.session.getState();
                return { state: s.state, enemies: s.enemies.length, level: s.level, tick: s.tick };
            }""")
            check("敵群已生成", state["enemies"] > 0, str(state["enemies"]))
            check("權威模擬有推進", state["tick"] > 0, f"tick={state['tick']}")

            painted = page.evaluate("""() => {
                const c = document.getElementById('gameCanvas').getContext('2d');
                const d = c.getImageData(0, 0, 480, 640).data;
                let lit = 0;
                for (let i = 0; i < d.length; i += 4)
                    if (d[i] + d[i+1] + d[i+2] > 90) lit++;
                return lit;
            }""")
            check("畫布有實際繪製內容", painted > 500, f"亮點像素 {painted}")

            shot = ROOT / "test" / "screenshot.png"
            page.locator(".canvas-wrapper").screenshot(path=str(shot))

            # ── 雙頁：互見（T-016 驗收核心）────────────────────
            # 刻意開第二個 browser 而非同一個 browser 的第二個分頁：
            # Chromium 會節流非活動分頁的 requestAnimationFrame，
            # 兩個分頁擠在同一個 browser 時，背景那個根本不會送出輸入，測不到同步。
            browser2 = p.chromium.launch()
            page2 = browser2.new_page(viewport={"width": 900, "height": 1200})
            attach_error_capture(page2, errors)
            page2.goto(f"http://127.0.0.1:{port}/index.html", wait_until="load")
            wait_online(page2)
            page.wait_for_timeout(600)

            color1 = page.evaluate("() => game.net.color")
            color2 = page2.evaluate("() => game.net.color")
            room1 = page.evaluate("() => game.net.roomId")
            room2 = page2.evaluate("() => game.net.roomId")
            check("兩個分頁進入同一房間", room1 == room2, f"{room1} vs {room2}")
            check("兩位玩家顏色不重複", color1 != color2, f"{color1} vs {color2}")

            seen = page.evaluate("() => game.session.getState().players.length")
            check("分頁 1 看得到 2 位玩家", seen == 2, str(seen))

            # 分頁 2 把戰機開到畫面左側，分頁 1 應看到它移動過去
            id2 = page2.evaluate("() => game.session.selfId")
            page2.evaluate("() => { game.localShip.x = 60; game.localShip.y = 500; }")
            page.wait_for_timeout(900)
            observed = page.evaluate(
                "(id) => { const p = game.session.getState().players.find(p => p.id === id);"
                " return p ? { x: p.x, y: p.y } : null; }", id2)
            check("分頁 1 看到分頁 2 的移動",
                  observed is not None and abs(observed["x"] - 60) < 40,
                  json.dumps(observed))

            # 分頁 2 持續開火，分頁 1 應看到場上出現子彈
            # 用按住空白鍵而非單發 fireRequested：後者只在某一幀有效，容易錯過取樣窗口
            page2.evaluate("() => { game.input.keys['Space'] = true; }")
            page.wait_for_timeout(700)
            bullets = page.evaluate("() => game.session.getState().bullets.length")
            check("分頁 1 看得到他人的射擊", bullets > 0, f"場上子彈 {bullets}")

            # 等進場 3 秒無敵結束再截圖：無敵期間戰機會閃爍，
            # 截在隱藏幀的話畫面上只會剩下名牌，看不出「互見」
            page.wait_for_function(
                "(id) => { const p = game.session.getState().players.find(p => p.id === id);"
                " return p && p.invulnerableTime <= 0; }", arg=id2, timeout=8000)
            multi_shot = ROOT / "test" / "screenshot-multiplayer.png"
            page.locator(".canvas-wrapper").screenshot(path=str(multi_shot))
            page2.evaluate("() => { game.input.keys['Space'] = false; }")

            # 炸彈端對端清場（BUG-2）
            #
            # 必須等到自機真的在場上且還有炸彈才投：重生倒數中 applyInput 會直接吞掉請求。
            # 這裡原本沒等也沒驗證炸彈是否真的放出去，斷言只有 after < before——
            # 炸彈沒放成功時，光靠另一個分頁的普通射擊擊墜幾架就足以讓它通過，
            # 實測同一份程式碼會在「31 → 0」與「30 → 28」之間跳動。
            cleared = page.evaluate("""() => new Promise((res, rej) => {
                const deadline = Date.now() + 10000;
                const tick = () => {
                    const me = game.selfState;
                    if (me && me.isActive && me.bombs > 0) {
                        const before = game.session.getState().enemies.length;
                        const bombsBefore = me.bombs;
                        game.input.bombRequested = true;
                        setTimeout(() => res({
                            before, after: game.session.getState().enemies.length,
                            bombsBefore, bombsAfter: game.selfState ? game.selfState.bombs : -1,
                            score: game.selfState ? game.selfState.score : 0
                        }), 2500);
                    } else if (Date.now() > deadline) {
                        rej(new Error('自機遲遲沒有進入「在場上且有炸彈」的可投彈狀態'));
                    } else {
                        setTimeout(tick, 100);
                    }
                };
                tick();
            })""")
            check("清屏炸彈真的有放出去",
                  cleared["bombsAfter"] < cleared["bombsBefore"],
                  f"炸彈存量 {cleared['bombsBefore']} → {cleared['bombsAfter']}")
            check("清屏炸彈把全場敵機清光",
                  cleared["after"] == 0 and cleared["before"] > 0,
                  f"{cleared['before']} → {cleared['after']}, score={cleared['score']}")

            ta = page.evaluate("() => getComputedStyle(document.getElementById('gameCanvas')).touchAction")
            check("畫布 touch-action: none", ta == "none", ta)

            # ── UI：分數榜與暱稱（T-017）──────────────────────
            check("畫面上沒有任何連線碼輸入框",
                  page.evaluate("() => document.querySelectorAll('.signal-box, textarea').length") == 0)

            roster = page.evaluate("""() => [...document.querySelectorAll('.roster-item')]
                .map(li => ({ text: li.textContent, color: li.style.color,
                              self: li.classList.contains('is-self') }))""")
            check("分數榜列出 2 位玩家", len(roster) == 2, json.dumps(roster, ensure_ascii=False))
            check("分數榜標示出自己", sum(1 for r in roster if r["self"]) == 1)
            check("分數榜每位玩家配色不同",
                  len({r["color"] for r in roster}) == len(roster))

            # 換暱稱重新加入
            page.fill("#nickInput", "隊長")
            page.click("#btnJoin")
            wait_online(page)
            page.wait_for_timeout(800)
            nick_now = page.evaluate("() => { const me = game.selfState; return me ? me.nick : null; }")
            check("換暱稱後生效", nick_now == "隊長", str(nick_now))

            # ── 8 人同場（T-017 驗收核心）─────────────────────
            # 額外 6 個分頁只需要連線與領色，不需要操作，
            # 因此用同一個 browser 的多個 context 即可（背景分頁的 ws 仍正常收訊）
            extra_pages = []
            for i in range(6):
                ctx = browser.new_context()
                extra = ctx.new_page()
                extra.goto(f"http://127.0.0.1:{port}/index.html", wait_until="load")
                wait_online(extra)
                extra_pages.append((ctx, extra))

            page.bring_to_front()
            page.wait_for_timeout(1200)
            eight = page.evaluate("""() => {
                const players = game.session.getState().players;
                return { count: players.length,
                         colors: [...new Set(players.map(p => p.playerColor))].length,
                         allActive: players.every(p => 'isActive' in p) };
            }""")
            check("8 人進入同一房間", eight["count"] == 8, json.dumps(eight))
            check("8 人顏色完全不重複", eight["colors"] == 8, f"相異顏色 {eight['colors']}")

            roster8 = page.evaluate("() => document.querySelectorAll('.roster-item').length")
            check("分數榜列出全部 8 人", roster8 == 8, str(roster8))

            eight_shot = ROOT / "test" / "screenshot-8players.png"
            page.locator(".arcade-cabinet").screenshot(path=str(eight_shot))

            for ctx, extra in extra_pages:
                extra.close()
                ctx.close()

            page2.close()
            browser2.close()
            page.close()

            # ── 離線退回：純靜態伺服器（無 WebSocket）──────────
            httpd, static_port = start_static_server()
            offline_errors = []
            page3 = browser.new_page(viewport={"width": 900, "height": 1200})
            attach_error_capture(page3, offline_errors)
            page3.goto(f"http://127.0.0.1:{static_port}/index.html", wait_until="load")
            page3.wait_for_function(
                "() => window.game && game.session === game.local", timeout=10000)
            page3.wait_for_timeout(1500)

            local = page3.evaluate("""() => {
                const s = game.session.getState();
                return { enemies: s.enemies.length, tick: s.tick, level: s.level,
                         isLocal: game.session === game.local };
            }""")
            check("伺服器不可用時退回本地單人房", local["isLocal"])
            check("單人房仍可完整遊玩",
                  local["enemies"] > 0 and local["tick"] > 0,
                  f"敵機 {local['enemies']}、tick {local['tick']}")

            # ── 魔王關（T-013 平衡調校）───────────────────────
            # 本地房跑的是與權威端完全同一份 shared/world.js，因此這裡驗到的
            # Boss 行為等同伺服器行為；差別只在這裡還額外驗了「畫得出來」。
            boss_stage = page3.evaluate("""() => new Promise(res => {
                const w = game.session.world;
                w.startStage(3, game.session.fx);      // 每 3 關為魔王關
                const boss = w.enemies.find(e => e.type === 'boss');

                // 滿血階段與殘血階段各採樣 3 秒，比較彈幕密度
                const sample = (secs) => new Promise(done => {
                    const before = w.enemyBullets.length;
                    let fired = 0;
                    const seen = new Set(w.enemyBullets);
                    const iv = setInterval(() => {
                        w.enemyBullets.forEach(b => { if (!seen.has(b)) { seen.add(b); fired++; } });
                    }, 50);
                    setTimeout(() => { clearInterval(iv); done(fired); }, secs * 1000);
                });

                sample(3).then(full => {
                    boss.hp = boss.maxHp * 0.1;        // 逼入最終階段
                    return sample(3).then(low => res({
                        maxHp: boss.maxHp,
                        isBossStage: w.isBossStage,
                        style: boss.bossStyle,
                        firedFullHp: full,
                        firedLowHp: low
                    }));
                });
            })""")
            check("魔王關生成 Boss 且血量為調校後的基準值",
                  boss_stage["isBossStage"] and boss_stage["maxHp"] == 520,
                  f"maxHp {boss_stage['maxHp']}、造型 {boss_stage['style']}")
            check("Boss 會持續發射彈幕",
                  boss_stage["firedFullHp"] > 0,
                  f"滿血 3 秒內發射 {boss_stage['firedFullHp']} 發")
            check("殘血階段的彈幕比滿血階段更密",
                  boss_stage["firedLowHp"] > boss_stage["firedFullHp"],
                  f"滿血 {boss_stage['firedFullHp']} 發 → 殘血 {boss_stage['firedLowHp']} 發")

            boss_shot = ROOT / "test" / "screenshot-boss.png"
            page3.locator(".canvas-wrapper").screenshot(path=str(boss_shot))
            boss_px = page3.evaluate("""() => {
                const c = document.getElementById('gameCanvas');
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let lit = 0;
                for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 90) lit++;
                return lit;
            }""")
            check("魔王關畫面確實有繪製內容（含 Boss 血條）",
                  boss_px > 1000, f"亮點像素 {boss_px}")

            # WebSocket 連線失敗是預期行為，不列入錯誤
            real_offline_errors = [e for e in offline_errors if "WebSocket" not in e]
            check("單人模式無非預期 JS 錯誤", not real_offline_errors,
                  "; ".join(real_offline_errors[:3]))

            page3.close()
            httpd.shutdown()

            print(f"     截圖：{shot}")
            check("全程無 JS 錯誤", not errors, "; ".join(errors[:3]))
            browser.close()
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()

    print(f"\n通過 {len(PASSES)} / 失敗 {len(FAILURES)}")
    if FAILURES:
        print("失敗項目：" + ", ".join(FAILURES))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
