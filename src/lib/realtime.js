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

/** Push a punch-card update (a punch landed / a full card was redeemed). */
export function emitPunch(userId, payload) {
  if (io && userId) io.to(`user:${userId}`).emit('punch', payload);
}

/**
 * Tell a student a vendor deal landed in their in-app list (migration-032).
 * Fired at campaign creation, independently of web push, so an open app shows
 * the badge immediately whether or not notifications were ever granted.
 */
export function emitDeal(userId, payload) {
  if (io && userId) io.to(`user:${userId}`).emit('deal', payload);
}

/**
 * Students with the app open and in the foreground right now.
 *
 * The campaign worker excludes them from a delivery slot: interrupting someone
 * already looking at the app achieves nothing, and spending their daily
 * notification quota to do it is actively harmful. They see the deal in the
 * list instead, over the socket.
 *
 * `visible` is reported by the client on visibilitychange; a socket that has
 * never said otherwise counts as foreground, since browsers keep background
 * sockets alive and assuming "visible" only ever DEFERS a notification.
 *
 * Single-instance, like the rate limiter and alerts.js: each dyno sees its own
 * sockets. On a multi-dyno deploy this degrades to "some foreground students
 * still get a push" — never to a double send.
 */
export function visibleUserIds() {
  if (!io) return [];
  const ids = new Set();
  for (const socket of io.of('/').sockets.values()) {
    if (socket.data?.userId && socket.data.visible !== false) ids.add(socket.data.userId);
  }
  return [...ids];
}
