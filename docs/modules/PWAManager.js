import { EventManager } from './EventManager.js';
import { NotificationManager } from './NotificationManager.js';

export class PWAManager {
	serviceWorkerPath = 'pwa-service-worker.js';

	/** @type {ServiceWorkerRegistration} */
	registration = null;
	#appVersion = '';
	#isAppInstalled = false;
	isRegistered = false;

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
		window.iptv = window.iptv || {};
		window.iptv.pwa = this;
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
		this.isOnline = navigator.onLine;
		this.#register();
		setInterval(() => navigator.serviceWorker.ready.then(() => this.checkForUpdate()), 30000);
		this.isAppInstalled();

		// TODO emit event when istalled bu version needed
	}

	#listen() {
		this.#em.onOnline(() => {
			if (!this.isOnline) {
				this.#nm.online();
			}
			this.isOnline = true;
		});
		this.#em.onOffline(() => {
			this.isOnline = false;
			this.#nm.offline();
		});

		window.addEventListener('beforeinstallprompt', (event) => {
			event.preventDefault();
			window.deferredPrompt = event; // Yükleme istemini sakla

			// "Kurulum butonunu" göster
			//document.getElementById('installBtn').style.display = 'block';
		});

		window.addEventListener('appinstalled', (event) => {
			console(event);
			this.#nm.installed();
			this.isAppInstalled();
			window.deferredPrompt = null;
		});

		window.addEventListener('load', () => this.isAppInstalled());
	}

	/**
	 * Handle PWA installation
	 */
	async installPWA() {
		if (!window.deferredPrompt) {
			this.#nm.manual();
			return;
		}

		window.deferredPrompt.prompt();
		const { outcome } = await window.deferredPrompt.userChoice;
		if (outcome === 'accepted') {
			this.#nm.success('Installation Started', 'IPTV Player is being installed...');
			setTimeout(() => this.updateModalStatus(), 1000);
		} else {
			this.#nm.info('Installation Cancelled', 'You can install the app later from browser menu.');
		}
		window.deferredPrompt = null;
	}

	/**
	 * Update service worker
	 */
	async checkForUpdate() {
		if (!('serviceWorker' in navigator)) return;

		const registration = await navigator.serviceWorker.getRegistration();
		if (!registration) return;

		if (registration.waiting) {
			registration.waiting.postMessage({ type: 'SKIP_WAITING' });
			this.#nm.updated();
			// TODO check
			// setTimeout(() => window.location.reload(), 2000);
		} else {
			await registration.update();
		}
	}

	async #register() {
		try {
			navigator.serviceWorker.addEventListener('message', (event) => {
				//const message = { type, data, timestamp: Date.now() };

				const { type, data, time } = event.data;
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

	isAppInstalled() {
		try {
			this.#isAppInstalled =
				window.matchMedia('(display-mode: standalone)').matches ||
				window.navigator?.standalone === true ||
				navigator?.standalone === true ||
				document.referrer?.includes('android-app://');

			if ('getInstalledRelatedApps' in navigator) {
				navigator.getInstalledRelatedApps().then((apps) => {
					if (apps.length > 0) {
						this.#isAppInstalled = true;
						this.#em.emitAppInstalled();
					} else {
						this.#isAppInstalled = false;
					}
				});
			}
		} catch (error) {
			console.error(error);
		}

		if (this.#isAppInstalled) this.#em.emitAppInstalled();
		return this.#isAppInstalled;
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
