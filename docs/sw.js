const CACHE_NAME = 'iptv-player-v1.0.0';
const MAX_ITEMS = 500;

navigator.storage.estimate().then((estimate) => {
	console.log(`Used: ${estimate.usage / 1024 / 1024} MB`);
	console.log(`Quota: ${estimate.quota / 1024 / 1024} MB`);
});

const urlsToCache = [
	'./',
	'./index.html',
	'./style.css',
	'./script.js',
	'./manifest.json',
	// External CDN resources
	'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css',
	'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/css/select2.min.css',
	'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
	'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/js/bootstrap.bundle.min.js',
	'https://code.jquery.com/jquery-3.6.0.min.js',
	'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/js/select2.min.js',
	'https://cdn.jsdelivr.net/npm/hls.js@1.1.5/dist/hls.min.js',
	'https://cdn.jsdelivr.net/npm/iptv-util@latest/rollup/iptv-util-min.js',
];

// Install Service Worker
self.addEventListener('install', (event) => {
	console.log('🔧 IPTV Player Service Worker installing...');
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => {
				console.log('📦 Caching app shell resources');
				return cache.addAll(urlsToCache);
			})
			.then(() => {
				console.log('✅ IPTV Player Service Worker installed successfully');
				return self.skipWaiting();
			}),
	);
});

// Activate Service Worker
self.addEventListener('activate', (event) => {
	console.log('🚀 IPTV Player Service Worker activating...');
	event.waitUntil(
		caches
			.keys()
			.then((cacheNames) => {
				return Promise.all(
					cacheNames.map((cacheName) => {
						if (cacheName !== CACHE_NAME) {
							console.log('🗑️ Deleting old cache:', cacheName);
							return caches.delete(cacheName);
						}
					}),
				);
			})
			.then(() => {
				console.log('✅ IPTV Player Service Worker activated');
				return self.clients.claim();
			}),
	);
});

async function trimCache() {
	const cache = await caches.open(CACHE_NAME);
	const requests = await cache.keys();
	if (requests.length > MAX_ITEMS) {
		for (let i = 0; i < requests.length - MAX_ITEMS; i++) {
			await cache.delete(requests[i]);
		}
	}
}

// Ensure you clone the Response before reading its body.
async function handleFetch(event) {
	const cache = await caches.open(CACHE_NAME);
	const cachedResponse = await cache.match(event.request);
	if (cachedResponse) {
		//  check header, video/mp2t
		//return cachedResponse;
	}

	const response = await fetch(event.request);
	const clonedResponse = response.clone(); // Clone immediately

	const isFull = await cache
		.put(event.request, clonedResponse)
		.then(() => '')
		.catch((e) => e);

	if (isFull) console.error(isFull);
	return response; // Return the original
}

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	// clean search params, if video stream url return
	try {
		const urlObj = new URL(event.request.url);

		if (urlObj.pathname) {
			if (urlObj.pathname.endsWith('.ts')) return;
			if (urlObj.pathname.endsWith('.m3u8')) return;
			if (urlObj.pathname.endsWith('.m3u')) {
				if (!urlObj.hostname.startsWith('sefakozan') && !urlObj.hostname.startsWith('raw.githubusercontent')) {
					return;
				}
			}
		}
	} catch {
		console.error(`invalid url: ${event.request.url}`);
	}

	event.respondWith(handleFetch(event));
});

// Handle background sync for offline functionality
self.addEventListener('sync', (event) => {
	if (event.tag === 'background-sync') {
		console.log('🔄 Background sync triggered');
		// Handle background synchronization tasks
	}
});

// Handle push notifications (future feature)
self.addEventListener('push', (event) => {
	if (event.data) {
		const data = event.data.json();
		const options = {
			body: data.body,
			icon: './assets/icon-192x192.png',
			badge: './assets/icon-72x72.png',
			vibrate: [100, 50, 100],
			data: {
				dateOfArrival: Date.now(),
				primaryKey: data.primaryKey,
			},
			actions: [
				{
					action: 'explore',
					title: 'Open IPTV Player',
					icon: './assets/icon-96x96.png',
				},
				{
					action: 'close',
					title: 'Close',
					icon: './assets/icon-96x96.png',
				},
			],
		};

		event.waitUntil(self.registration.showNotification(data.title, options));
	}
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
	event.notification.close();

	if (event.action === 'explore') {
		event.waitUntil(clients.openWindow('./'));
	}
});

// Message handling for communication with main thread
self.addEventListener('message', (event) => {
	if (event.data && event.data.type === 'SKIP_WAITING') {
		self.skipWaiting();
	}

	if (event.data && event.data.type === 'GET_VERSION') {
		event.ports[0].postMessage({ version: CACHE_NAME });
	}
});
