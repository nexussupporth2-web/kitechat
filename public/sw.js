// Lets KiteChat show system notifications (which use the phone's own notification sound).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('/');
    })
  );
});

// A notification sent by the server while the app is closed (new message, or an incoming call).
self.addEventListener('push', event => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    /* plain text */
  }
  const call = d.kind === 'call';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // For a plain message, the open app already shows it.
      if (!call && list.some(c => c.visibilityState === 'visible')) return;
      return self.registration.showNotification(d.title || 'KiteChat', {
        body: d.body || 'You have a message',
        tag: d.tag || 'kitechat',
        renotify: true,
        requireInteraction: call,
        vibrate: call ? [400, 200, 400, 200, 400, 200, 400] : [200, 100, 200],
        silent: false
      });
    })
  );
});
