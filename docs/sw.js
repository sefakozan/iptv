const CACHE_NAME = "iptv-player-v1.0.0";
const urlsToCache = [
	"./",
	"./index.html",
	"./style.css",
	"./script.js",
	"./manifest.json",
	// External CDN resources
	"https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css",
	"https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/css/select2.min.css",
	"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css",
	"https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/js/bootstrap.bundle.min.js",
	"https://code.jquery.com/jquery-3.6.0.min.js",
	"https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/js/select2.min.js",
	"https://cdn.jsdelivr.net/npm/hls.js@1.1.5/dist/hls.min.js",
	"https://cdn.jsdelivr.net/npm/iptv-util@latest/rollup/iptv-util-min.js",
];

// Install Service Worker
self.addEventListener("install", (event) => {
	console.log("🔧 IPTV Player Service Worker installing...");
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => {
				console.log("📦 Caching app shell resources");
				return cache.addAll(urlsToCache);
			})
			.then(() => {
				console.log("✅ IPTV Player Service Worker installed successfully");
				return self.skipWaiting();
			}),
	);
});

// Activate Service Worker
self.addEventListener("activate", (event) => {
	console.log("🚀 IPTV Player Service Worker activating...");
	event.waitUntil(
		caches
			.keys()
			.then((cacheNames) => {
				return Promise.all(
					cacheNames.map((cacheName) => {
						if (cacheName !== CACHE_NAME) {
							console.log("🗑️ Deleting old cache:", cacheName);
							return caches.delete(cacheName);
						}
					}),
				);
			})
			.then(() => {
				console.log("✅ IPTV Player Service Worker activated");
				return self.clients.claim();
			}),
	);
});

// Fetch Strategy: Network First for API calls, Cache First for static resources
self.addEventListener("fetch", (event) => {
	const { request } = event;

	// Handle different types of requests
	if (request.url.includes(".m3u") || request.url.includes("api")) {
		// Network First strategy for M3U files and API calls
		event.respondWith(
			fetch(request)
				.then((response) => {
					// Clone the response before caching
					const responseClone = response.clone();
					caches.open(CACHE_NAME).then((cache) => {
						cache.put(request, responseClone);
					});
					return response;
				})
				.catch(() => {
					// Fallback to cache if network fails
					return caches.match(request);
				}),
		);
	} else if (request.url.includes("cdn.") || request.url.includes("cdnjs.")) {
		// Cache First strategy for CDN resources
		event.respondWith(
			caches.match(request).then((response) => {
				if (response) {
					return response;
				}
				return fetch(request).then((response) => {
					const responseClone = response.clone();
					caches.open(CACHE_NAME).then((cache) => {
						cache.put(request, responseClone);
					});
					return response;
				});
			}),
		);
	} else {
		// Stale While Revalidate strategy for app shell
		event.respondWith(
			caches.match(request).then((response) => {
				const fetchPromise = fetch(request).then((networkResponse) => {
					caches.open(CACHE_NAME).then((cache) => {
						cache.put(request, networkResponse.clone());
					});
					return networkResponse;
				});

				return response || fetchPromise;
			}),
		);
	}
});

// Handle background sync for offline functionality
self.addEventListener("sync", (event) => {
	if (event.tag === "background-sync") {
		console.log("🔄 Background sync triggered");
		// Handle background synchronization tasks
	}
});

// Handle push notifications (future feature)
self.addEventListener("push", (event) => {
	if (event.data) {
		const data = event.data.json();
		const options = {
			body: data.body,
			icon: "./assets/icon-192x192.png",
			badge: "./assets/icon-72x72.png",
			vibrate: [100, 50, 100],
			data: {
				dateOfArrival: Date.now(),
				primaryKey: data.primaryKey,
			},
			actions: [
				{
					action: "explore",
					title: "Open IPTV Player",
					icon: "./assets/icon-96x96.png",
				},
				{
					action: "close",
					title: "Close",
					icon: "./assets/icon-96x96.png",
				},
			],
		};

		event.waitUntil(self.registration.showNotification(data.title, options));
	}
});

// Handle notification clicks
self.addEventListener("notificationclick", (event) => {
	event.notification.close();

	if (event.action === "explore") {
		event.waitUntil(clients.openWindow("./"));
	}
});

// Message handling for communication with main thread
self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "SKIP_WAITING") {
		self.skipWaiting();
	}

	if (event.data && event.data.type === "GET_VERSION") {
		event.ports[0].postMessage({ version: CACHE_NAME });
	}
});
