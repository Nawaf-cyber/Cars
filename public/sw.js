/* عامل الخدمة — يجعل النظام يُثبَّت كبرنامج ويفتح فوراً.

   قاعدة صارمة: لا يُخزَّن أي شيء من /api إطلاقاً.
   بيانات السيارات والمتابعات تأتي دائماً من الخادم مباشرة، فلا تظهر أرقام قديمة،
   ويبقى إيقاف الاشتراك ساري المفعول فوراً. المخزَّن هو هيكل الصفحة فقط.

   استراتيجية الهيكل: المخزَّن أولاً ثم تحديث صامت في الخلفية.
   السبب أن الهيكل (HTML/CSS/JS) يتغيّر عند النشر فقط، فانتظار الشبكة في كل
   فتحة يكلّف ثانية كاملة بلا فائدة — خصوصاً على جوّال بشبكة ضعيفة.
   التحديث يصل مع الفتحة التالية، وهذا مقبول لأن البيانات ليست هنا. */
const CACHE = 'shell-v2';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // reload يتجاوز مخزن المتصفح فنضمن أن النسخة المثبَّتة هي أحدث ما نُشر
      .then((c) => Promise.all(SHELL.map((u) =>
        fetch(new Request(u, { cache: 'reload' }))
          .then((r) => (r.ok ? c.put(u, r) : null))
          .catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** يجلب من الشبكة ويحدّث المخزَّن بصمت — لا يُنتظر ولا يُظهر خطأ. */
function revalidate(request) {
  return fetch(request)
    .then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
      return res;
    })
    .catch(() => null);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // كل ما يخص البيانات والجلسات يمر للشبكة دون تخزين
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        revalidate(e.request);        // لا ننتظرها — الصفحة ظهرت أصلاً
        return hit;
      }
      // أول مرة: من الشبكة، وإن تعذّرت نعرض الهيكل المخزَّن
      return revalidate(e.request).then((res) => res ||
        caches.match('/index.html').then((shell) => shell || Response.error()));
    })
  );
});
