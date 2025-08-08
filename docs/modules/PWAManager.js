import { EventManager } from './EventManager.js';
import { NotificationManager } from './NotificationManager.js';

export class PWAManager {
	serviceWorkerPath = 'pwa-service-worker.js';

	/** @type {ServiceWorkerRegistration} */
	registration = null;
	appVersion = '';
	installedAppVersion = '';

	isRegistered = false;
	isInstalled = false;
	serviceWorker = null;
	deferredPrompt = null;
	isOnline = false;
	updateAvailable = false;

	/** @type {PWAManager|null} */
	static #instance = null;

	/** @type {NotificationManager} */
	#nm = NotificationManager.getInstance();

	/** @type {EventManager} */
	#em = EventManager.getInstance();

	constructor() {
		if (PWAManager.#instance) {
			throw new Error('SettingsManager is a singleton. Use SettingsManager.getInstance()');
		}
		this.retryAttempts = new Map();

		this.#initialize();
		this.#listen();
	}

	/**
	 * Get singleton instance
	 * @returns {PWAManager}
	 */
	static getInstance() {
		if (!PWAManager.#instance) {
			PWAManager.#instance = new PWAManager();
		}
		return PWAManager.#instance;
	}

	#initialize() {
		this.isInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true || document.referrer.includes('android-app://');
		this.isOnline = navigator.onLine;
		this.#register();
		setInterval(() => navigator.serviceWorker.ready.then((reg) => this.#checkForUpdate.update()), 30000);
		// TODO emit event when istalled bu version needed
	}

	#listen() {
		this.#em.onOnline(() => {
			if (!this.isOnline) {
				this.#nm.success("You're Back Online", 'Internet connection restored.');
			}
			this.isOnline = true;
		});
		this.#em.onOffline(() => {
			this.isOnline = false;
			this.#nm.warning('Connection Lost', 'Your internet connection has been lost. Please check your network.');
		});
	}

	async #register() {
		try {
			navigator.serviceWorker.addEventListener('message', (event) => {
				//const message = { type, data, timestamp: Date.now() };
				debugger;
				const { type, data, time } = event.data;
				debugger;
			});

			const registration = await this.#withRetry('sw-registration', () => navigator.serviceWorker.register(this.serviceWorkerPath));

			console.log('✅ Service Worker registered successfully:', registration);
			this.registration = registration;
			this.isRegistered = true;
			this.isInstalled = true;
			//this.#em.emitRegistered(registration);

			this.registration.addEventListener('updatefound', () => {
				const newWorker = this.registration.installing;
				if (newWorker) this.#updateFound(newWorker);
			});
		} catch (error) {
			console.error(`Service Worker Registration\n${error}`);
		}
	}

	#updateFound(newWorker) {
		newWorker.onstatechange = () => {
			if (newWorker.state === 'installed') {
				if (navigator.serviceWorker.controller) {
					console.log('Uygulama güncellendi. Yenileme önerilebilir.');
					console.log('Yeni güncelleme hazır.');
					// showRefreshUI()
					//showRefreshPrompt()
				}
			}
		};
	}

	/**
	 * Check for service worker update
	 */
	async #checkForUpdate() {
		if (!this.registration) return;

		try {
			await this.registration.update();
			console.log('🔍 Checked for Service Worker update');
		} catch (error) {
			console.error(`Service Worker Update Check\n${error}`);
		}
	}

	status() {
		this.#initialize();
		return {};
	}

	sendSkipWaiting() {
		// Yeni SW'yi hemen aktif et
		navigator.serviceWorker.ready.then((sw) => {
			sw.active.postMessage({ type: 'SKIP_WAITING' });
		});
	}

	sendGetVersion() {
		// Yeni SW'yi hemen aktif et
		navigator.serviceWorker.ready.then((sw) => {
			sw.active.postMessage({ type: 'GET_VERSION' });
		});
	}

	sendClearAllCache() {
		// Yeni SW'yi hemen aktif et
		navigator.serviceWorker.ready.then((sw) => {
			sw.active.postMessage({ type: 'CLEAR_ALL_CACHE', data: {} });
		});
	}

	/**
	 * Handle retry logic
	 * @param {string} operation - Operation name
	 * @param {Function} func - Function to retry
	 * @param {number} maxRetries - Maximum retry attempts
	 * @param {number} delay - Delay between retries
	 * @returns {Promise} Operation result
	 */
	async #withRetry(operation, func, maxRetries = 10, delay = 1000) {
		const attempts = this.retryAttempts.get(operation) || 0;

		try {
			const result = await func();
			this.retryAttempts.delete(operation); // Reset on success
			return result;
		} catch (error) {
			if (attempts < maxRetries) {
				this.retryAttempts.set(operation, attempts + 1);
				console.warn(`${operation} (attempt ${attempts + 1}/${maxRetries}) \n ${error}`);

				await new Promise((resolve) => setTimeout(resolve, delay));
				return this.withRetry(operation, func, maxRetries, delay);
			} else {
				this.retryAttempts.delete(operation);
				console.error(`${operation} (final attempt failed) \n ${error}`);
				throw error;
			}
		}
	}
}

PWAManager.getInstance();
