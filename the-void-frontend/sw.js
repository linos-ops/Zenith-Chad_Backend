/* Zenith Chads service worker: phone notifications, app-icon badge, and offline feed. */
const VERSION = 'zc-v3';
const SHELL = VERSION + '-shell', API = VERSION + '-api';
const BACKEND = 'https://zenith-chad-backend.onrender.com';

self.addEventListener('install', e => {
    e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/'])).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

// Offline: open the app and show the last feed you saw
self.addEventListener('fetch', e => {
    const r = e.request;
    if (r.method !== 'GET') return;
    const url = new URL(r.url);
    const isFeed = url.origin === BACKEND && /^\/api\/posts(\/trending)?$/.test(url.pathname);
    if (r.mode !== 'navigate' && !isFeed) return;
    const store = isFeed ? API : SHELL;
    const key = isFeed ? r.url : '/';
    e.respondWith(fetch(r).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(store).then(c => c.put(key, copy)); }
        return res;
    }).catch(() => caches.match(key).then(hit => hit || Response.error())));
});

// Safari must always show something for a push; other browsers may skip it while the app is open
const APPLE = /iPhone|iPad|iPod|Mac OS X/.test(self.navigator.userAgent) && !/Chrome\//.test(self.navigator.userAgent);

self.addEventListener('push', e => {
    let d = {};
    try { d = e.data.json(); } catch (err) { d = { title: 'Zenith Chads', body: e.data ? e.data.text() : '' }; }
    e.waitUntil((async () => {
        // red number on the app icon (home screen / dock)
        if (typeof d.badge === 'number') {
            try { if (d.badge > 0) await self.navigator.setAppBadge(d.badge); else await self.navigator.clearAppBadge(); } catch (err) {}
        }
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const inApp = wins.some(w => w.visibilityState === 'visible' && w.focused);
        const show = APPLE || !inApp;
        wins.forEach(w => w.postMessage({ type: 'push', kind: d.type, title: d.title, body: d.body, postId: d.postId, badge: d.badge, shown: show }));
        if (!show) return;
        await self.registration.showNotification(d.title || 'Zenith Chads', {
            body: d.body || '',
            icon: '/icons/icon-192.png',
            badge: '/icons/badge-96.png',
            tag: d.tag || undefined,
            renotify: !!d.tag,
            timestamp: Date.now(),
            data: { postId: d.postId || null }
        });
    })());
});

// Tapping a notification opens the app straight on that post
self.addEventListener('notificationclick', e => {
    e.notification.close();
    const postId = e.notification.data && e.notification.data.postId;
    e.waitUntil((async () => {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const win = wins.find(w => 'focus' in w);
        if (win) { await win.focus(); win.postMessage({ type: 'open-post', postId }); return; }
        await self.clients.openWindow(postId ? `/?post=${postId}` : '/');
    })());
});
