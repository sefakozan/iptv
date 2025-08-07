/**
 * IPTV Player Service Worker
 *
 * Modern ES6+ service worker with advanced caching strategies,
 * offline support, background sync, and performance optimization.
 *
 * Features:
 * - Multi-tier Caching Strategy
 * - Intelligent Cache Management
 * - Network-First/Cache-First Strategies
 * - Background Synchronization
 * - Push Notifications Support
 * - Performance Monitoring
 * - Comprehensive Error Handling
 * - Offline Fallbacks
 *
 * @author IPTV Player Team
 * @version 2.0.0
 */

// =============================================================================
// Service Worker Configuration & Constants
// =============================================================================

/**
 * Service Worker configuration and cache settings
 */
class ServiceWorkerConfig {
	constructor() {
		this.development = false;
		this.version = '2.1.7';
		this.version = this.development ? `${this.version}-dev` : this.version;
		this.cacheName = `iptv-player-v${this.version}`;
		this.staticCacheName = `${this.cacheName}-static`;
		this.dynamicCacheName = `${this.cacheName}-dynamic`;
		this.imageCacheName = `${this.cacheName}-images`;
		this.apiCacheName = `${this.cacheName}-api`;

		// Cache limits
		this.maxCacheItems = {
			static: 100,
			dynamic: 200,
			images: 150,
			api: 50,
		};

		// Cache expiration times (in milliseconds)
		this.cacheExpiration = {
			static: 7 * 24 * 60 * 60 * 1000, // 7 days
			dynamic: 24 * 60 * 60 * 1000, // 1 day
			images: 30 * 24 * 60 * 60 * 1000, // 30 days
			api: 5 * 60 * 1000, // 5 minutes
		};

		// Network timeout
		this.networkTimeout = 5000;

		// Static resources to cache on install
		this.staticResources = ['./', './index.html', './style.css', './script.js', './pwa-script.js', './manifest.json', './assets/icon-192x192.png', './assets/icon-512x512.png', './assets/screenshot-wide.png', './assets/screenshot-mobile.png'];

		// External CDN resources
		this.externalResources = [
			'https://cdn.jsdelivr.net/npm/bootstrap@5.3.7/dist/css/bootstrap.min.css',
			'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/css/select2.min.css',
			'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.0.0/css/all.min.css',
			'https://cdn.jsdelivr.net/npm/bootstrap@5.3.7/dist/js/bootstrap.bundle.min.js',
			'https://code.jquery.com/jquery-3.7.1.min.js',
			'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/js/select2.min.js',
			'https://cdn.jsdelivr.net/npm/hls.js@1.6.9/dist/hls.min.js',
			'https://cdn.jsdelivr.net/npm/iptv-util@latest/rollup/iptv-util-min.js',
		];

		// Streaming patterns to exclude from caching
		this.streamingPatterns = [
			/\.ts(\?.*)?$/, // HLS video segments
			/\.m3u8(\?.*)?$/, // HLS playlists
			/\/hls\//, // HLS streaming paths
			/\/dash\//, // DASH streaming paths
			/video\/mp2t/, // MPEG-TS content type
			/application\/vnd\.apple\.mpegurl/, // HLS content type
		];

		// Allowed M3U sources (for playlist caching)
		this.allowedM3USources = ['sefakozan', 'raw.githubusercontent.com'];
	}

	/**
	 * Get all cache names
	 * @returns {Array<string>} Array of cache names
	 */
	getAllCacheNames() {
		return [this.staticCacheName, this.dynamicCacheName, this.imageCacheName, this.apiCacheName];
	}

	/**
	 * Check if URL should be excluded from caching
	 * @param {string} url - URL to check
	 * @returns {boolean} True if should be excluded
	 */
	shouldExcludeFromCache(url) {
		try {
			const urlObj = new URL(url);

			// Check streaming patterns
			for (const pattern of this.streamingPatterns) {
				if (pattern.test(url) || pattern.test(urlObj.pathname)) {
					return true;
				}
			}

			// Check M3U files from unauthorized sources
			if (urlObj.pathname.endsWith('.m3u')) {
				const isAllowedSource = this.allowedM3USources.some((source) => urlObj.hostname.includes(source));
				return !isAllowedSource;
			}

			return false;
		} catch {
			console.warn('Invalid URL for cache check:', url);
			return true; // Exclude invalid URLs
		}
	}
}

// =============================================================================
// Error Management System
// =============================================================================

/**
 * Service Worker error manager
 */
class ServiceWorkerErrorManager {
	constructor() {
		this.errors = [];
		this.maxErrors = 100;
		this.performanceMetrics = {
			cacheHits: 0,
			cacheMisses: 0,
			networkRequests: 0,
			errors: 0,
		};
	}

	/**
	 * Log error with context
	 * @param {Error|string} error - Error to log
	 * @param {string} context - Error context
	 * @param {Object} metadata - Additional metadata
	 */
	logError(error, context = 'Unknown', metadata = {}) {
		const errorEntry = {
			timestamp: new Date().toISOString(),
			error: error instanceof Error ? error.message : error,
			stack: error instanceof Error ? error.stack : null,
			context,
			metadata,
			id: this.generateErrorId(),
		};

		this.errors.push(errorEntry);
		this.performanceMetrics.errors++;

		// Keep only recent errors
		if (this.errors.length > this.maxErrors) {
			this.errors = this.errors.slice(-this.maxErrors);
		}

		// Log to console with formatting
		console.error(`❌ SW Error [${context}]:`, error, metadata);

		// Send error to main thread if possible
		this.notifyMainThread('sw:error', errorEntry);
	}

	/**
	 * Log performance metric
	 * @param {string} metric - Metric name
	 * @param {number} value - Metric value
	 */
	logMetric(metric, value = 1) {
		if (metric in this.performanceMetrics) {
			this.performanceMetrics[metric] += value;
		}
	}

	/**
	 * Generate unique error ID
	 * @returns {string} Error ID
	 */
	generateErrorId() {
		return Date.now().toString(36) + Math.random().toString(36).substr(2);
	}

	/**
	 * Get performance report
	 * @returns {Object} Performance metrics
	 */
	getPerformanceReport() {
		return {
			...this.performanceMetrics,
			cacheEfficiency: this.performanceMetrics.cacheHits / (this.performanceMetrics.cacheHits + this.performanceMetrics.cacheMisses) || 0,
			errorRate: this.performanceMetrics.errors / this.performanceMetrics.networkRequests || 0,
		};
	}

	/**
	 * Notify main thread of events
	 * @param {string} type - Event type
	 * @param {Object} data - Event data
	 */
	async notifyMainThread(type, data) {
		try {
			const clients = await self.clients.matchAll();
			const message = { type, data, timestamp: Date.now() };

			clients.forEach((client) => {
				client.postMessage(message);
			});
		} catch (error) {
			console.warn('Failed to notify main thread:', error);
		}
	}
}

// =============================================================================
// Cache Management System
// =============================================================================

/**
 * Advanced cache manager with multiple strategies
 */
class CacheManager {
	constructor(config, errorManager) {
		this.config = config;
		this.errorManager = errorManager;
	}

	/**
	 * Initialize all caches
	 * @returns {Promise<void>}
	 */
	async initializeCaches() {
		try {
			console.log('🔧 Initializing cache system...');

			// Create all cache instances
			await Promise.all(this.config.getAllCacheNames().map((cacheName) => caches.open(cacheName)));

			console.log('✅ Cache system initialized');
		} catch (error) {
			this.errorManager.logError(error, 'Cache Initialization');
			throw error;
		}
	}

	/**
	 * Cache static resources during install
	 * @returns {Promise<void>}
	 */
	async cacheStaticResources() {
		try {
			console.log('📦 Caching static resources...');

			const cache = await caches.open(this.config.staticCacheName);

			// Cache local static resources
			await cache.addAll(this.config.staticResources);

			// Cache external resources with error handling
			await this.cacheExternalResources(cache);

			console.log('✅ Static resources cached successfully');
		} catch (error) {
			this.errorManager.logError(error, 'Static Resource Caching');
			throw error;
		}
	}

	/**
	 * Cache external resources with individual error handling
	 * @param {Cache} cache - Cache instance
	 * @returns {Promise<void>}
	 */
	async cacheExternalResources(cache) {
		const results = await Promise.allSettled(this.config.externalResources.map((url) => this.cacheResourceSafely(cache, url)));

		const failed = results.filter((result) => result.status === 'rejected');
		if (failed.length > 0) {
			console.warn(`⚠️ Failed to cache ${failed.length} external resources`);
		}
	}

	/**
	 * Safely cache a single resource
	 * @param {Cache} cache - Cache instance
	 * @param {string} url - Resource URL
	 * @returns {Promise<void>}
	 */
	async cacheResourceSafely(cache, url) {
		try {
			const response = await fetch(url, {
				mode: 'cors',
				credentials: 'omit',
			});

			if (response.ok) {
				await cache.put(url, response);
			} else {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
		} catch (error) {
			this.errorManager.logError(error, 'Resource Caching', { url });
			throw error;
		}
	}

	/**
	 * Clean up old caches
	 * @returns {Promise<void>}
	 */
	async cleanupOldCaches() {
		try {
			console.log('🧹 Cleaning up old caches...');

			const cacheNames = await caches.keys();
			const currentCaches = this.config.getAllCacheNames();

			const deletionPromises = cacheNames
				.filter((cacheName) => !currentCaches.includes(cacheName))
				.map((cacheName) => {
					console.log(`🗑️ Deleting old cache: ${cacheName}`);
					return caches.delete(cacheName);
				});

			await Promise.all(deletionPromises);
			console.log('✅ Old caches cleaned up');
		} catch (error) {
			this.errorManager.logError(error, 'Cache Cleanup');
		}
	}

	/**
	 * Trim cache to stay within limits
	 * @param {string} cacheName - Cache name to trim
	 * @param {number} maxItems - Maximum items to keep
	 * @returns {Promise<void>}
	 */
	async trimCache(cacheName, maxItems) {
		try {
			const cache = await caches.open(cacheName);
			const requests = await cache.keys();

			if (requests.length > maxItems) {
				const itemsToDelete = requests.length - maxItems;

				for (let i = 0; i < itemsToDelete; i++) {
					await cache.delete(requests[i]);
				}

				console.log(`✂️ Trimmed ${itemsToDelete} items from ${cacheName}`);
			}
		} catch (error) {
			this.errorManager.logError(error, 'Cache Trimming', { cacheName });
		}
	}

	/**
	 * Get appropriate cache name for URL
	 * @param {string} url - Request URL
	 * @returns {string} Cache name
	 */
	getCacheNameForUrl(url) {
		try {
			const urlObj = new URL(url);

			// API endpoints
			if (urlObj.pathname.includes('/api/') || urlObj.pathname.endsWith('.json')) {
				return this.config.apiCacheName;
			}

			// Images
			if (urlObj.pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i)) {
				return this.config.imageCacheName;
			}

			// Static resources
			if (this.config.staticResources.includes(url) || this.config.externalResources.includes(url)) {
				return this.config.staticCacheName;
			}

			// Everything else goes to dynamic cache
			return this.config.dynamicCacheName;
		} catch {
			return this.config.dynamicCacheName;
		}
	}

	/**
	 * Check if cache entry is expired
	 * @param {Response} response - Cached response
	 * @param {string} cacheName - Cache name
	 * @returns {boolean} True if expired
	 */
	isCacheExpired(response, cacheName) {
		const cacheDate = response.headers.get('sw-cache-date');
		if (!cacheDate) return false;

		const cacheTime = new Date(cacheDate).getTime();
		const now = Date.now();

		const maxAge = this.getCacheMaxAge(cacheName);
		return now - cacheTime > maxAge;
	}

	/**
	 * Get cache max age for cache type
	 * @param {string} cacheName - Cache name
	 * @returns {number} Max age in milliseconds
	 */
	getCacheMaxAge(cacheName) {
		if (cacheName.includes('static')) return this.config.cacheExpiration.static;
		if (cacheName.includes('images')) return this.config.cacheExpiration.images;
		if (cacheName.includes('api')) return this.config.cacheExpiration.api;
		return this.config.cacheExpiration.dynamic;
	}
}

// =============================================================================
// Network & Fetch Strategy Manager
// =============================================================================

/**
 * Advanced fetch strategies for different resource types
 */
class FetchStrategyManager {
	constructor(config, cacheManager, errorManager) {
		this.config = config;
		this.cacheManager = cacheManager;
		this.errorManager = errorManager;
	}

	/**
	 * Handle fetch request with appropriate strategy
	 * @param {FetchEvent} event - Fetch event
	 * @returns {Promise<Response>} Response
	 */
	async handleFetch(event) {
		const { request } = event;

		try {
			// cache disabled
			if (this.config.development) {
				return fetch(request);
			}

			// Skip non-GET requests
			if (request.method !== 'GET') {
				return fetch(request);
			}

			// Skip streaming content
			if (this.config.shouldExcludeFromCache(request.url)) {
				this.errorManager.logMetric('networkRequests');
				return fetch(request);
			}

			// Choose strategy based on request type
			return await this.selectStrategy(request);
		} catch (error) {
			this.errorManager.logError(error, 'Fetch Handling', { url: request.url });
			return this.createErrorResponse();
		}
	}

	/**
	 * Select appropriate caching strategy
	 * @param {Request} request - Request object
	 * @returns {Promise<Response>} Response
	 */
	async selectStrategy(request) {
		const url = request.url;

		// Static resources: Cache First
		if (this.isStaticResource(url)) {
			return this.cacheFirst(request);
		}

		// API requests: Network First with short cache
		if (this.isApiRequest(url)) {
			return this.networkFirst(request);
		}

		// Images: Cache First with fallback
		if (this.isImageRequest(url)) {
			return this.cacheFirst(request);
		}

		// Everything else: Stale While Revalidate
		return this.staleWhileRevalidate(request);
	}

	/**
	 * Cache First strategy
	 * @param {Request} request - Request object
	 * @returns {Promise<Response>} Response
	 */
	async cacheFirst(request) {
		const cacheName = this.cacheManager.getCacheNameForUrl(request.url);
		const cache = await caches.open(cacheName);
		const cachedResponse = await cache.match(request);

		if (cachedResponse && !this.cacheManager.isCacheExpired(cachedResponse, cacheName)) {
			this.errorManager.logMetric('cacheHits');
			return cachedResponse;
		}

		this.errorManager.logMetric('cacheMisses');
		this.errorManager.logMetric('networkRequests');

		try {
			const networkResponse = await this.fetchWithTimeout(request);

			// Cache the response
			if (networkResponse.ok) {
				await this.cacheResponse(cache, request, networkResponse.clone());
			}

			return networkResponse;
		} catch (error) {
			// Return stale cache if available
			if (cachedResponse) {
				console.warn('🔄 Serving stale content due to network error');
				return cachedResponse;
			}
			throw error;
		}
	}

	/**
	 * Network First strategy
	 * @param {Request} request - Request object
	 * @returns {Promise<Response>} Response
	 */
	async networkFirst(request) {
		const cacheName = this.cacheManager.getCacheNameForUrl(request.url);
		const cache = await caches.open(cacheName);

		this.errorManager.logMetric('networkRequests');

		try {
			const networkResponse = await this.fetchWithTimeout(request);

			if (networkResponse.ok) {
				await this.cacheResponse(cache, request, networkResponse.clone());
			}

			return networkResponse;
		} catch (error) {
			this.errorManager.logMetric('cacheMisses');

			// Fallback to cache
			const cachedResponse = await cache.match(request);
			if (cachedResponse) {
				console.warn('🔄 Serving cached content due to network error');
				this.errorManager.logMetric('cacheHits');
				return cachedResponse;
			}

			throw error;
		}
	}

	/**
	 * Stale While Revalidate strategy
	 * @param {Request} request - Request object
	 * @returns {Promise<Response>} Response
	 */
	async staleWhileRevalidate(request) {
		const cacheName = this.cacheManager.getCacheNameForUrl(request.url);
		const cache = await caches.open(cacheName);
		const cachedResponse = await cache.match(request);

		// Start network request (don't await)
		const networkResponsePromise = this.fetchWithTimeout(request)
			.then((response) => {
				if (response.ok) {
					this.cacheResponse(cache, request, response.clone());
				}
				return response;
			})
			.catch((error) => {
				this.errorManager.logError(error, 'Background Fetch', { url: request.url });
			});

		this.errorManager.logMetric('networkRequests');

		// Return cached version immediately if available
		if (cachedResponse) {
			this.errorManager.logMetric('cacheHits');
			return cachedResponse;
		}

		// No cache available, wait for network
		this.errorManager.logMetric('cacheMisses');
		return networkResponsePromise;
	}

	/**
	 * Fetch with timeout
	 * @param {Request} request - Request object
	 * @returns {Promise<Response>} Response
	 */
	async fetchWithTimeout(request) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.config.networkTimeout);

		try {
			const response = await fetch(request, {
				signal: controller.signal,
			});
			clearTimeout(timeoutId);
			return response;
		} catch (error) {
			clearTimeout(timeoutId);
			throw error;
		}
	}

	/**
	 * Cache response with metadata
	 * @param {Cache} cache - Cache instance
	 * @param {Request} request - Request object
	 * @param {Response} response - Response to cache
	 * @returns {Promise<void>}
	 */
	async cacheResponse(cache, request, response) {
		try {
			// Add cache timestamp
			const responseToCache = new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: {
					...Object.fromEntries(response.headers.entries()),
					'sw-cache-date': new Date().toISOString(),
				},
			});

			await cache.put(request, responseToCache);

			// Trim cache if necessary
			const cacheName = this.cacheManager.getCacheNameForUrl(request.url);
			const maxItems = this.getMaxItemsForCache(cacheName);
			await this.cacheManager.trimCache(cacheName, maxItems);
		} catch (error) {
			this.errorManager.logError(error, 'Cache Storage', { url: request.url });
		}
	}

	/**
	 * Get max items for cache type
	 * @param {string} cacheName - Cache name
	 * @returns {number} Max items
	 */
	getMaxItemsForCache(cacheName) {
		if (cacheName.includes('static')) return this.config.maxCacheItems.static;
		if (cacheName.includes('images')) return this.config.maxCacheItems.images;
		if (cacheName.includes('api')) return this.config.maxCacheItems.api;
		return this.config.maxCacheItems.dynamic;
	}

	/**
	 * Check if URL is a static resource
	 * @param {string} url - URL to check
	 * @returns {boolean} True if static resource
	 */
	isStaticResource(url) {
		return this.config.staticResources.includes(url) || this.config.externalResources.includes(url) || url.match(/\.(css|js|woff2?|ttf|eot)$/i);
	}

	/**
	 * Check if URL is an API request
	 * @param {string} url - URL to check
	 * @returns {boolean} True if API request
	 */
	isApiRequest(url) {
		return url.includes('/api/') || url.endsWith('.json') || url.includes('countries.json') || url.includes('languages.json');
	}

	/**
	 * Check if URL is an image request
	 * @param {string} url - URL to check
	 * @returns {boolean} True if image request
	 */
	isImageRequest(url) {
		return url.match(/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i);
	}

	/**
	 * Create error response for offline scenarios
	 * @returns {Response} Error response
	 */
	createErrorResponse() {
		return new Response(
			JSON.stringify({
				error: 'Network error',
				message: 'Unable to fetch resource',
				offline: !navigator.onLine,
			}),
			{
				status: 503,
				statusText: 'Service Unavailable',
				headers: {
					'Content-Type': 'application/json',
				},
			},
		);
	}
}

// =============================================================================
// Background Sync Manager
// =============================================================================

/**
 * Background synchronization manager
 */
class BackgroundSyncManager {
	constructor(errorManager) {
		this.errorManager = errorManager;
		this.syncQueue = [];
	}

	/**
	 * Handle background sync event
	 * @param {SyncEvent} event - Sync event
	 * @returns {Promise<void>}
	 */
	async handleSync(event) {
		console.log('🔄 Background sync triggered:', event.tag);

		try {
			switch (event.tag) {
				case 'performance-sync':
					await this.syncPerformanceData();
					break;
				case 'error-sync':
					await this.syncErrorData();
					break;
				case 'cache-cleanup':
					await this.performCacheCleanup();
					break;
				default:
					console.warn('Unknown sync tag:', event.tag);
			}
		} catch (error) {
			this.errorManager.logError(error, 'Background Sync', { tag: event.tag });
			throw error;
		}
	}

	/**
	 * Sync performance data to main thread
	 * @returns {Promise<void>}
	 */
	async syncPerformanceData() {
		const report = this.errorManager.getPerformanceReport();
		await this.errorManager.notifyMainThread('sw:performance-report', report);
	}

	/**
	 * Sync error data to main thread
	 * @returns {Promise<void>}
	 */
	async syncErrorData() {
		const errors = this.errorManager.errors.slice(-10); // Last 10 errors
		await this.errorManager.notifyMainThread('sw:error-report', errors);
	}

	/**
	 * Perform cache cleanup
	 * @returns {Promise<void>}
	 */
	async performCacheCleanup() {
		// Implementation for periodic cache cleanup
		console.log('🧹 Performing scheduled cache cleanup');
	}
}

// =============================================================================
// Push Notification Manager
// =============================================================================

/**
 * Push notification manager
 */
class PushNotificationManager {
	constructor(errorManager) {
		this.errorManager = errorManager;
	}

	/**
	 * Handle push event
	 * @param {PushEvent} event - Push event
	 * @returns {Promise<void>}
	 */
	async handlePush(event) {
		try {
			const data = event.data ? event.data.json() : {};

			const options = {
				body: data.body || 'IPTV Player notification',
				icon: './assets/icon-192x192.png',
				badge: './assets/icon-72x72.png',
				image: data.image || './assets/screenshot-wide.png',
				vibrate: [100, 50, 100],
				requireInteraction: data.requireInteraction || false,
				data: {
					dateOfArrival: Date.now(),
					primaryKey: data.primaryKey || Date.now(),
					url: data.url || './',
				},
				actions: [
					{
						action: 'open',
						title: 'Open IPTV Player',
						icon: './assets/icon-96x96.png',
					},
					{
						action: 'dismiss',
						title: 'Dismiss',
						icon: './assets/icon-96x96.png',
					},
				],
			};

			await self.registration.showNotification(data.title || 'IPTV Player', options);

			console.log('📱 Push notification displayed');
		} catch (error) {
			this.errorManager.logError(error, 'Push Notification');
		}
	}

	/**
	 * Handle notification click
	 * @param {NotificationEvent} event - Notification event
	 * @returns {Promise<void>}
	 */
	async handleNotificationClick(event) {
		event.notification.close();

		try {
			const { action, data } = event;
			const url = data?.url || './';

			if (action === 'open' || !action) {
				// Open or focus the app
				const clients = await self.clients.matchAll({ type: 'window' });

				// Check if app is already open
				for (const client of clients) {
					if (client.url.includes(self.registration.scope)) {
						await client.focus();
						return;
					}
				}

				// Open new window
				await self.clients.openWindow(url);
			}

			console.log('📱 Notification clicked:', action);
		} catch (error) {
			this.errorManager.logError(error, 'Notification Click');
		}
	}
}

// =============================================================================
// Main Service Worker Manager
// =============================================================================

/**
 * Main service worker coordinator
 */
class ServiceWorkerManager {
	constructor() {
		this.config = new ServiceWorkerConfig();
		this.errorManager = new ServiceWorkerErrorManager();
		this.cacheManager = new CacheManager(this.config, this.errorManager);
		this.fetchManager = new FetchStrategyManager(this.config, this.cacheManager, this.errorManager);
		this.syncManager = new BackgroundSyncManager(this.errorManager);
		this.pushManager = new PushNotificationManager(this.errorManager);

		this.isInstalled = false;
		this.isActivated = false;
	}

	/**
	 * Initialize service worker
	 * @returns {Promise<void>}
	 */
	async init() {
		try {
			console.log('🚀 IPTV Player Service Worker initializing...');

			// Log storage quota
			await this.logStorageInfo();

			// Initialize cache system
			await this.cacheManager.initializeCaches();

			console.log('✅ Service Worker initialized successfully');
		} catch (error) {
			this.errorManager.logError(error, 'Service Worker Initialization');
			throw error;
		}
	}

	/**
	 * Handle install event
	 * @param {InstallEvent} _event - Install event
	 * @returns {Promise<void>}
	 */
	async handleInstall(_event) {
		console.log('🔧 Service Worker installing...');

		try {
			await this.init();
			await this.cacheManager.cacheStaticResources();

			this.isInstalled = true;
			console.log('✅ Service Worker installed successfully');

			// Skip waiting to activate immediately
			await self.skipWaiting();
		} catch (error) {
			this.errorManager.logError(error, 'Service Worker Installation');
			throw error;
		}
	}

	/**
	 * Handle activate event
	 * @param {ExtendableEvent} _event - Activate event
	 * @returns {Promise<void>}
	 */
	async handleActivate(_event) {
		console.log('🚀 Service Worker activating...');

		try {
			await this.cacheManager.cleanupOldCaches();
			await self.clients.claim();

			this.isActivated = true;
			console.log('✅ Service Worker activated successfully');

			// Notify clients of activation
			await this.errorManager.notifyMainThread('sw:activated', {
				version: this.config.version,
				caches: this.config.getAllCacheNames(),
			});
		} catch (error) {
			this.errorManager.logError(error, 'Service Worker Activation');
			throw error;
		}
	}

	/**
	 * Handle message from main thread
	 * @param {MessageEvent} event - Message event
	 * @returns {Promise<void>}
	 */
	async handleMessage(event) {
		const { type, data } = event.data || {};

		try {
			switch (type) {
				case 'SKIP_WAITING':
					await self.skipWaiting();
					break;

				case 'GET_VERSION':
					event.ports[0]?.postMessage({
						version: this.config.version,
						cacheName: this.config.cacheName,
					});
					break;

				case 'GET_PERFORMANCE':
					event.ports[0]?.postMessage(this.errorManager.getPerformanceReport());
					break;

				case 'CLEAR_CACHE':
					await this.clearSpecificCache(data?.cacheName);
					break;

				default:
					console.warn('Unknown message type:', type);
			}
		} catch (error) {
			this.errorManager.logError(error, 'Message Handling', { type });
		}
	}

	/**
	 * Clear specific cache
	 * @param {string} cacheName - Cache name to clear
	 * @returns {Promise<void>}
	 */
	async clearSpecificCache(cacheName) {
		if (cacheName && this.config.getAllCacheNames().includes(cacheName)) {
			await caches.delete(cacheName);
			console.log(`🗑️ Cleared cache: ${cacheName}`);
		}
	}

	/**
	 * Log storage information
	 * @returns {Promise<void>}
	 */
	async logStorageInfo() {
		try {
			if ('storage' in navigator && 'estimate' in navigator.storage) {
				const estimate = await navigator.storage.estimate();
				console.log(`💾 Storage - Used: ${(estimate.usage / 1024 / 1024).toFixed(2)} MB`);
				console.log(`💾 Storage - Quota: ${(estimate.quota / 1024 / 1024).toFixed(2)} MB`);
			}
		} catch (error) {
			console.warn('Could not get storage info:', error);
		}
	}
}

// =============================================================================
// Global Service Worker Instance & Event Listeners
// =============================================================================

// Create global service worker manager
const swManager = new ServiceWorkerManager();

// Install Event
self.addEventListener('install', (event) => {
	event.waitUntil(swManager.handleInstall(event));
});

// Activate Event
self.addEventListener('activate', (event) => {
	event.waitUntil(swManager.handleActivate(event));
});

// Fetch Event
self.addEventListener('fetch', (event) => {
	event.respondWith(swManager.fetchManager.handleFetch(event));
});

// Background Sync Event
self.addEventListener('sync', (event) => {
	event.waitUntil(swManager.syncManager.handleSync(event));
});

// Push Event
self.addEventListener('push', (event) => {
	event.waitUntil(swManager.pushManager.handlePush(event));
});

// Notification Click Event
self.addEventListener('notificationclick', (event) => {
	event.waitUntil(swManager.pushManager.handleNotificationClick(event));
});

// Message Event
self.addEventListener('message', (event) => {
	swManager.handleMessage(event);
});

// Global Error Handler
self.addEventListener('error', (event) => {
	swManager.errorManager.logError(event.error, 'Global SW Error', {
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
	});
});

// Unhandled Promise Rejection Handler
self.addEventListener('unhandledrejection', (event) => {
	swManager.errorManager.logError(event.reason, 'Unhandled SW Promise Rejection');
});

console.log('🎯 IPTV Player Service Worker loaded successfully');
