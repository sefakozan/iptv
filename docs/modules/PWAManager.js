import { appConfig } from './AppConfig.js';
import { eventManager } from './EventManager.js';
import { notificationManager } from './NotificationManager.js';

export class PWAManager {
	serviceWorkerPath = 'pwa-service-worker.js';

	/** @type {ServiceWorkerRegistration|null} */
	registration = null;

	#appVersion = '';
	#isAppInstalled = false;
	isRegistered = false;
	isOnline = false;
	updateAvailable = false;

	/** @type {BeforeInstallPromptEvent|null} */
	deferredPrompt = null;

	// init guards
	#initialized = false;
	#initPromise = null;
	#updateTimerId = null;

	isInitialized() {
		return this.#initialized;
	}

	async initialize() {
		if (this.#initPromise) return this.#initPromise;

		this.#initPromise = (async () => {
			if (this.#initialized) return;

			// path from config if available
			try {
				const cfg = appConfig.getConfig?.();
				if (cfg?.serviceWorkerPath) this.serviceWorkerPath = cfg.serviceWorkerPath;
			} catch {}

			this.isOnline = navigator.onLine;
			this.#setupListeners();

			if ('serviceWorker' in navigator) {
				await this.#register();
				// periodic update check
				if (this.#updateTimerId) clearInterval(this.#updateTimerId);
				this.#updateTimerId = window.setInterval(() => this.checkForUpdate(), 30000);
			}

			// initial install state
			this.isAppInstalled();

			this.#initialized = true;
		})();

		return this.#initPromise;
	}

	#setupListeners() {
		// Online / Offline
		window.addEventListener('online', () => {
			if (!this.isOnline) notificationManager.online();
			this.isOnline = true;
		});
		window.addEventListener('offline', () => {
			this.isOnline = false;
			notificationManager.offline();
		});

		// PWA install prompt
		window.addEventListener('beforeinstallprompt', (event) => {
			event.preventDefault();
			this.deferredPrompt = event;
		});

		window.addEventListener('appinstalled', (event) => {
			console.log('PWA installed:', event);
			notificationManager.installed();
			this.isAppInstalled();
			this.deferredPrompt = null;
			// Event publish
			try {
				eventManager.emit(eventManager.etype.APP_INSTALLED, { source: 'pwa' });
			} catch {}
		});

		window.addEventListener('load', () => this.isAppInstalled());
	}

	/**
	 * Handle PWA installation
	 */
	async installPWA() {
		if (!this.deferredPrompt) {
			notificationManager.manual();
			return;
		}
		this.deferredPrompt.prompt();
		const { outcome } = await this.deferredPrompt.userChoice;
		if (outcome === 'accepted') {
			notificationManager.success('Installation Started', 'IPTV Player is being installed...');
		} else {
			notificationManager.info('Installation Cancelled', 'You can install the app later from browser menu.');
		}
		this.deferredPrompt = null;
	}

	/**
	 * Public: check and apply update if waiting worker exists
	 */
	async checkForUpdate() {
		if (!('serviceWorker' in navigator)) return;

		const registration = await navigator.serviceWorker.getRegistration();
		if (!registration) return;

		if (registration.waiting) {
			try {
				registration.waiting.postMessage({ type: 'SKIP_WAITING' });
				this.updateAvailable = true;
				notificationManager.updated();
			} catch (e) {
				console.error('Failed to message waiting SW:', e);
			}
		} else {
			await registration.update();
		}
	}

	async #register() {
		try {
			// SW message listener
			navigator.serviceWorker.addEventListener('message', (event) => this.#onSWMessage(event));

			const registration = await this.#withRetry('sw-registration', () => navigator.serviceWorker.register(this.serviceWorkerPath));

			console.log('✅ Service Worker registered successfully:', registration);
			this.registration = registration;
			this.isRegistered = true;

			this.registration.addEventListener('updatefound', () => {
				const newWorker = this.registration.installing;
				if (newWorker) this.#updateFound(newWorker);
			});
		} catch (error) {
			console.error('Service Worker Registration\n', error);
		}
	}

	#onSWMessage(event) {
		try {
			const { type, data } = event.data || {};
			if (!type) return;

			switch (type) {
				case 'VERSION':
					this.#appVersion = data?.version || '';
					break;
				case 'CLEAR_ALL_CACHE_OK':
					notificationManager.success('Cache Cleared', 'All caches cleared by Service Worker.');
					break;
				case 'UPDATE_AVAILABLE':
					this.updateAvailable = true;
					notificationManager.info('Update Available', 'A new version is ready. It will be applied on reload.');
					break;
				default:
					break;
			}
		} catch (e) {
			console.warn('SW message parse error:', e);
		}
	}

	#updateFound(newWorker) {
		newWorker.onstatechange = () => {
			if (newWorker.state === 'installed') {
				if (navigator.serviceWorker.controller) {
					this.updateAvailable = true;
					console.log('New update is installed and ready.');
					notificationManager.info('Update Ready', 'A new version is installed. Reload to apply.');
				}
			}
		};
	}

	status() {
		return {
			serviceWorkerPath: this.serviceWorkerPath,
			isRegistered: this.isRegistered,
			isOnline: this.isOnline,
			updateAvailable: this.updateAvailable,
			isAppInstalled: this.#isAppInstalled,
			appVersion: this.#appVersion
		};
	}

	isAppInstalled() {
		try {
			this.#isAppInstalled =
				window.matchMedia?.('(display-mode: standalone)').matches ||
				window.navigator?.standalone === true ||
				navigator?.standalone === true ||
				document.referrer?.includes('android-app://');

			if ('getInstalledRelatedApps' in navigator) {
				navigator.getInstalledRelatedApps().then((apps) => {
					const installed = Array.isArray(apps) && apps.length > 0;
					this.#isAppInstalled = this.#isAppInstalled || installed;
					if (installed) {
						try {
							eventManager.emit(eventManager.etype.APP_INSTALLED, { source: 'pwa' });
						} catch {}
					}
				});
			}
		} catch (error) {
			console.error(error);
		}

		if (this.#isAppInstalled) {
			try {
				eventManager.emit(eventManager.etype.APP_INSTALLED, { source: 'pwa' });
			} catch {}
		}
		return this.#isAppInstalled;
	}

	sendSkipWaiting() {
		navigator.serviceWorker.ready.then((reg) => {
			reg?.active?.postMessage?.({ type: 'SKIP_WAITING' });
		});
	}

	sendGetVersion() {
		navigator.serviceWorker.ready.then((reg) => {
			reg?.active?.postMessage?.({ type: 'GET_VERSION' });
		});
	}

	sendClearAllCache() {
		navigator.serviceWorker.ready.then((reg) => {
			reg?.active?.postMessage?.({ type: 'CLEAR_ALL_CACHE', data: {} });
		});
	}

	/**
	 * Retry helper with exponential backoff (linear delay here for simplicity)
	 * @param {string} operation
	 * @param {() => Promise<any>} func
	 * @param {number} maxRetries
	 * @param {number} delay
	 */
	async #withRetry(operation, func, maxRetries = 10, delay = 1000) {
		let attempt = 0;
		for (;;) {
			try {
				return await func();
			} catch (error) {
				attempt++;
				if (attempt >= maxRetries) {
					console.error(`${operation} (final attempt failed)\n`, error);
					throw error;
				}
				console.warn(`${operation} (attempt ${attempt}/${maxRetries})\n`, error);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}
}

export const pwaManager = new PWAManager();
await pwaManager.initialize();

// Dev’de global erişim (export adıyla, window.iptv altında)
if (appConfig.isDevelopment && typeof window !== 'undefined') {
	window.iptv = window.iptv || {};
	window.iptv.pwaManager = pwaManager;
}
