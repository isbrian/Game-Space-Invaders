/**
 * 音效合成引擎 (Web Audio API)
 * 遵循 Ponytail-ZH 原生原則：免任何外部 MP3/WAV 檔案，透過音頻振盪器合成 8-bit 晶片音效。
 */
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.bossMusicTimer = null;
    this.bossMusicStep = 0;
    this.bossMusicActive = false;
  }

  // 使用者互動時初始化音訊上下文（避免瀏覽器自動播放限制）
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  toggleSound() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.stopBossMusic();
    return this.enabled;
  }

  // 基礎振盪器播放器
  playTone(freqStart, freqEnd, type = 'square', duration = 0.1, gainVal = 0.05) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const now = this.ctx.currentTime;

      osc.type = type;
      osc.frequency.setValueAtTime(freqStart, now);
      if (freqEnd && freqEnd !== freqStart) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(10, freqEnd), now + duration);
      }

      gain.gain.setValueAtTime(gainVal, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + duration);
    } catch (e) {
      // 容錯靜默處理
    }
  }

  // 雷射發射 (Raiden / Galaxian style)
  playShoot() {
    this.playTone(850, 200, 'square', 0.08, 0.04);
  }

  // 重雷射穿透音
  playHeavyLaser() {
    this.playTone(1200, 300, 'sawtooth', 0.12, 0.05);
  }

  // 兵蜂鈴鐺受擊反彈聲 (Metallic ding)
  playBellHit() {
    this.playTone(1400, 1800, 'triangle', 0.07, 0.06);
  }

  // 兵蜂鈴鐺撿取加分/升級聲 (Ascending chime)
  playBellCollect() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      setTimeout(() => {
        this.playTone(freq, freq * 1.05, 'sine', 0.1, 0.05);
      }, idx * 45);
    });
  }

  // 敵人擊毀爆炸
  playExplosion(isLarge = false) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const dur = isLarge ? 0.4 : 0.2;
      const bufferSize = this.ctx.sampleRate * dur;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);

      // 白噪音生成
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;

      // 低通濾波器模擬悶炸感
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(isLarge ? 400 : 800, now);
      filter.frequency.exponentialRampToValueAtTime(30, now + dur);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(isLarge ? 0.09 : 0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);

      noise.start(now);
    } catch (e) {}
  }

  // 雷電特色：全螢幕炸彈衝擊波
  playBomb() {
    this.playExplosion(true);
    this.playTone(180, 40, 'sawtooth', 0.6, 0.1);
  }

  // 玩家受擊
  playPlayerHit() {
    this.playTone(300, 60, 'sawtooth', 0.35, 0.08);
  }

  // 護盾碎裂
  playShieldBreak() {
    this.playTone(900, 150, 'sawtooth', 0.2, 0.06);
  }

  // 通關音樂
  playStageClear() {
    if (!this.enabled) return;
    const melody = [523, 659, 784, 1046, 880, 1046];
    melody.forEach((freq, idx) => {
      setTimeout(() => {
        this.playTone(freq, freq, 'square', 0.12, 0.05);
      }, idx * 80);
    });
  }

  // 遊戲結束
  playGameOver() {
    if (!this.enabled) return;
    const melody = [440, 392, 349, 293];
    melody.forEach((freq, idx) => {
      setTimeout(() => {
        this.playTone(freq, freq * 0.95, 'sawtooth', 0.2, 0.06);
      }, idx * 140);
    });
  }

  // 大蜜蜂特色：牽引光束 (Tractor Beam 脈衝音)
  playTractorBeam() {
    this.playTone(480, 880, 'sine', 0.18, 0.05);
  }

  // 雷電特色：追蹤飛彈點火發射音
  playMissileLaunch() {
    this.playTone(220, 600, 'sawtooth', 0.14, 0.04);
  }

  // 雙機合體歡呼與機械連鎖聲 (Dual Fighter Combined)
  playDualCombine() {
    if (!this.enabled) return;
    const fanfare = [523.25, 659.25, 783.99, 1046.5, 1318.5]; // C5, E5, G5, C6, E6
    fanfare.forEach((freq, idx) => {
      setTimeout(() => {
        this.playTone(freq, freq * 1.02, 'triangle', 0.15, 0.06);
      }, idx * 60);
    });
  }

  // 魔王戰背景音樂：以 Web Audio 合成獨立的低音循環，不使用外部音檔
  startBossMusic() {
    if (this.bossMusicActive) return;
    this.init();
    if (!this.ctx || !this.enabled) return;
    this.bossMusicActive = true;
    this.bossMusicStep = 0;

    // 更有存在感的 Boss BGM：低音 + 重拍 + 高音警戒旋律
    // 160ms 一拍，形成明確的 8-bit 戰鬥節奏。
    const tick = () => {
      if (!this.bossMusicActive || !this.enabled || !this.ctx) return;
      const bass = [82.41, 82.41, 98, 73.42, 82.41, 110, 98, 73.42];
      const lead = [329.63, 392, 493.88, 659.25, 523.25, 392, 311.13, 246.94];
      const i = this.bossMusicStep % bass.length;

      this.playTone(bass[i], bass[i] * 0.94, 'sawtooth', 0.14, 0.075);
      this.playTone(lead[i], lead[i] * 1.03, 'square', 0.13, 0.045);
      this.playTone(i % 2 === 0 ? 146.83 : 123.47, 90, 'triangle', 0.07, 0.025);

      this.bossMusicStep++;
      this.bossMusicTimer = setTimeout(tick, 160);
    };
    tick();
  }

  stopBossMusic() {
    this.bossMusicActive = false;
    if (this.bossMusicTimer) {
      clearTimeout(this.bossMusicTimer);
      this.bossMusicTimer = null;
    }
  }

  // Boss 降臨警報音 (Red Alert Klaxon)
  playWarning() {
    if (!this.enabled) return;
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        this.playTone(620, 310, 'sawtooth', 0.22, 0.08);
      }, i * 280);
    }
  }
}

// 實例化全域音效控制器
const soundEngine = new SoundEngine();
