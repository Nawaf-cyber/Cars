/* عامل الخدمة — يجعل النظام يُثبَّت كبرنامج ويفتح فوراً.
   قاعدة صارمة: لا يُخزَّن أي شيء من /api إطلاقاً.
   بيانات السيارات والمتابعات تأتي دائماً من الخادم مباشرة، فلا تظهر أرقام قديمة،
   ويبقى إيقاف الاشتراك ساري المفعول فوراً. المخزَّن هو هيكل الصفحة فقط. */
const CACHE = 'shell-v1';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // كل ما يخص البيانات والجلسات يمر للشبكة دون تخزين
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // الشبكة أولاً حتى تصل التحديثات فوراً، والمخزَّن احتياط عند انقطاع الشبكة
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
