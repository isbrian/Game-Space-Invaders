/**
 * 自動配對器
 *
 * 「加入即玩」的核心：玩家不選房、不開房、不等人，
 * 進來就丟進第一個有空位的房間；沒有空房就開一間新的。
 */

const { Room } = require('./room.js');

class Matchmaker {
  constructor() {
    this.rooms = new Map(); // roomId -> Room
  }

  get roomCount() {
    return this.rooms.size;
  }

  get playerCount() {
    let total = 0;
    this.rooms.forEach(r => { total += r.playerCount; });
    return total;
  }

  /** 找第一個未滿的房間；全滿或無房則開新房 */
  findOrCreateRoom() {
    for (const room of this.rooms.values()) {
      if (!room.isFull) return room;
    }
    const room = new Room((empty) => this.dispose(empty));
    this.rooms.set(room.id, room);
    return room;
  }

  join(playerId, socket, nick) {
    // 極端競態下（同一 tick 內多人湧入）取色仍可能失敗，改派下一間
    for (let attempt = 0; attempt < 3; attempt++) {
      const room = this.findOrCreateRoom();
      const result = room.join(playerId, socket, nick);
      if (result) return { room, result };
    }
    return null;
  }

  /** 房間淨空後銷毀：計時器已由 Room.stop() 關閉，這裡只解除參照 */
  dispose(room) {
    this.rooms.delete(room.id);
  }

  stats() {
    return {
      rooms: this.roomCount,
      players: this.playerCount,
      detail: [...this.rooms.values()].map(r => ({
        id: r.id,
        players: r.playerCount,
        level: r.world.level,
        colorsLeft: r.colors.size
      }))
    };
  }
}

module.exports = { Matchmaker };
