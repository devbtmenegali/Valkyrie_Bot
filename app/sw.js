// Kyrie PWA Service Worker (v3 - Branding & Real-time Update)
const CACHE_NAME = "kyrie-pwa-v3";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Suporte a Web Push (quando publicado em HTTPS para iOS/Android)
self.addEventListener("push", (event) => {
  let payload = { title: "Kyrie", body: "Nova atualização executiva." };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "Kyrie", {
      body: payload.body || "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: payload.tag || "kyrie-alert",
      data: { url: payload.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
