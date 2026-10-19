'use strict';
/**
 * Приватные комнаты по ссылке (ТЗ §1.3, §3.8) + служебный реестр активных звонков.
 */
const crypto = require('crypto');
const store = require('./db');

const CODE_RE = /^[a-z0-9]{6}$/;

class RoomManager {
  constructor() {
    /** @type {Map<string, {id:string, code:string, hostId:string, createdAt:number, mode:string, members:Set<string>, sockets:Map<string,string>}>} */
    this.rooms = new Map();
    /** @type {Map<string, Call>} активные звонки по id */
    this.calls = new Map();
  }

  static genCode() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // без похожих символов
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    return code;
  }

  create({ hostId, hostNick, mode = 'classic' }) {
    let code = RoomManager.genCode();
    while (this.rooms.has(code)) code = RoomManager.genCode();
    const room = {
      id: 'room_' + code, code, hostId, hostNick, mode,
      createdAt: Date.now(), members: new Set([hostId]), sockets: new Map([[hostId, null]]),
    };
    this.rooms.set(code, room);
    return this.public(room);
  }

  get(code) { return this.rooms.get(code); }
  getOrCreate(code, { hostId, hostNick, mode } = {}) {
    return this.rooms.get(code) || this.create({ hostId, hostNick, mode });
  }

  join(code, { userId, nick, socketId }) {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (room.members.size >= 2 && !room.members.has(userId)) return { error: 'full' };
    room.members.add(userId);
    room.sockets.set(userId, socketId);
    return this.public(room);
  }

  leave(code, userId) {
    const room = this.rooms.get(code);
    if (!room) return null;
    room.members.delete(userId);
    room.sockets.delete(userId);
    if (room.members.size === 0) { this.rooms.delete(code); return null; }
    return this.public(room);
  }

  close(code) { this.rooms.delete(code); }

  public(room) {
    return {
      code: room.code, hostId: room.hostId, hostNick: room.hostNick, mode: room.mode,
      createdAt: room.createdAt, members: [...room.members], size: room.members.size,
    };
  }

  /* ---------- звонки ---------- */

  /**
   * Регистрирует звонок. Возвращает { call, id }, где `call` — ЖИВОЙ объект из реестра:
   * мутации (dbId, state, watchdog) обязаны попадать в реестр, иначе finishCall теряет данные.
   */
  registerCall(call) {
    const stored = { ...call, startedAt: Date.now() };
    this.calls.set(stored.id, stored);
    return { call: stored, id: stored.id };
  }
  getCall(id) { return this.calls.get(id); }
  endCall(id, patch = {}) {
    const c = this.calls.get(id);
    if (!c) return null;
    Object.assign(c, patch, { endedAt: Date.now(), durationMs: Date.now() - c.startedAt });
    this.calls.delete(id);
    return c;
  }
  callsByUser(userId) { return [...this.calls.values()].filter(c => c.a === userId || c.b === userId); }
  activeCallCount() { return this.calls.size; }
  /** Публичное представление: без таймеров (watchdog/reconnectTimer не сериализуются в JSON). */
  activeCalls() {
    return [...this.calls.values()].map(({ watchdog, reconnectTimer, ...rest }) => ({
      ...rest,
      durationMs: Date.now() - rest.startedAt,
    }));
  }
}

module.exports = { RoomManager, CODE_RE, store };
