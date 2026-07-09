// Thin holder for the Socket.IO server so routes can push live updates without
// importing server.js. Balance changes are emitted to a per-user room.

let io = null;

export function setIo(instance) {
  io = instance;
}

/** Push a balance update to a single student (all their open tabs/devices). */
export function emitBalance(userId, payload) {
  if (io && userId) io.to(`user:${userId}`).emit('balance', payload);
}
