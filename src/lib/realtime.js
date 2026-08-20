// Thin holder for the Socket.IO server so routes can push live updates without
// importing server.js. Balance changes are emitted to a per-user room.

let io = null;

export function setIo(instance) {
  io = instance;
}

/**
 * Push a balance update to a single student (all their open tabs/devices).
 *
 * THE PAYLOAD CONTRACT, since point pools (migration-044):
 *
 *   { vendorId, poolVendorIds?, balance, community? }
 *
 * `vendorId` is where the money MOVED — the counter that rang it up, and the
 * only one whose toast, tier refresh and history reload should fire.
 *
 * `poolVendorIds` is which CARDS now show a different number. For an unpooled
 * vendor it is `[vendorId]`; for a pooled one it is every active sibling that
 * spends the same purse, because one shared balance changing changes all of
 * their cards at once. The client patches each id in the list and treats
 * `vendorId` as the event's origin, so its loop needs no is-this-pooled branch:
 *
 *   for (const id of payload.poolVendorIds ?? [payload.vendorId]) patchCard(id, payload.balance)
 *
 * IT IS ONE EVENT ON PURPOSE. Emitting one per sibling would be three sockets'
 * worth of "+50 pts" toasts for a single purchase, and three tier reloads.
 * Anything added here that is per-LOCATION rather than per-purse (visits, punch
 * cards, rewards) does not belong on this event — see emitPunch, which stays
 * per-vendor because visits are not shared.
 *
 * The field is optional so an old client, or any caller that has not been
 * updated, keeps working: absent means "just this vendor", which is what every
 * caller meant before pools existed.
 */
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
