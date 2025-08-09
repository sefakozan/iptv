// EventManager.js
// IPTV Player - Modern Event Management System
// Using modern ES modules, TypeScript-ready, and optimized patterns

/**
 * @typedef {Object} EventData
 * @property {string} type - Event type
 * @property {any} data - Event payload
 * @property {number} timestamp - Event timestamp
 */

export class EventManager {
	etype = Object.freeze({
		COUNTRY_CHANGE: 'country:change',
		CHANNEL_CHANGE: 'channel:change',
		PLAYLIST_CHANGE: 'playlist:change',
		STREAM_CHANGE: 'stream:change',
		NEW_VERSION_INSTALLED: 'app:version:installed',
		APP_INSTALLED: 'app:installed',
		APP_BACKGROUND: 'app:background',
		APP_FOREGROUND: 'app:foreground',
		APP_RESIZE: 'app:resize',
		FAVORITES_CHANGED: 'favorites:changed',
		FAVORITES_ADDED: 'favorites:added',
		FAVORITES_REMOVED: 'favorites:removed',
		LOADING_START: 'loading:start',
		LOADING_END: 'loading:end',
		ERROR_OCCURRED: 'error:occurred',
		SETTINGS_CHANGED: 'settings:changed',
		STATE_CHANGED: 'state:changed',
		VIDEO_PLAY: 'video:play',
		VIDEO_PAUSE: 'video:pause',
		VIDEO_ERROR: 'video:error',
		NETWORK_ONLINE: 'network:online',
		NETWORK_OFFLINE: 'network:offline',
		SW_CACHE_CLEARED: 'sw:cache:cleared',
		PLAYLIST_CACHE_CLEARED: 'playlist:cache:cleared',
		SW_REGISTERD: 'sw:registered',
		PWA_UPDATE_AVAILABLE: 'pwa:update:available',
		PWA_UPDATE_INSTALLED: 'pwa:update:installed',
	});

	/** @type {EventManager|null} */
	static #instance = null;

	/**
	 * @private Use EventManager.getInstance() instead
	 */
	constructor() {
		if (EventManager.#instance) {
			throw new Error('EventManager is a singleton. Use EventManager.getInstance()');
		}

		window.iptv = window.iptv || {};
		window.iptv.em = this;

		this.#initialize();
	}

	/**
	 * Get singleton instance
	 * @returns {EventManager}
	 */
	static getInstance() {
		if (!EventManager.#instance) {
			EventManager.#instance = new EventManager();
		}
		return EventManager.#instance;
	}

	/**
	 * Initialize event system
	 * @private
	 */
	#initialize() {
		this.#setupBrowserEvents();
		console.info('🎯 EventManager initialized', {
			events: Object.values(this.etype),
		});
	}

	/**
	 * Setup browser-level event listeners
	 * @private
	 */
	#setupBrowserEvents() {
		const emitNetworkEvent = (isOnline) => {
			this.emit(this.etype[`NETWORK_${isOnline ? 'ONLINE' : 'OFFLINE'}`], {
				timestamp: Date.now(),
				source: 'browser',
			});
		};

		// TODO

		// PWA ve Service Worker ile Async Callback

		// window.addEventListener('beforeinstallprompt', (e) => {
		// 	console.log('Yükleme istemi hazır.');
		// 	e.preventDefault();
		// 	window.deferredPrompt = e; // Yükleme istemini sakla
		// });

		// window.addEventListener('appinstalled', () => {
		// 	console.log('PWA başarıyla yüklendi!');
		// 	window.deferredPrompt = null;
		// 	// UI'yı güncelle
		// 	SettingsManager.getInstance().updateModalStatus();
		// });

		window.addEventListener('online', () => emitNetworkEvent(true));
		window.addEventListener('offline', () => emitNetworkEvent(false));
		window.addEventListener('resize', () => this.emit(this.etype.APP_RESIZE));

		document.addEventListener('visibilitychange', () => {
			const eventData = {
				hidden: document.hidden,
				visibilityState: document.visibilityState,
				timestamp: Date.now(),
			};
			this.emit(document.hidden ? this.etype.APP_BACKGROUND : this.etype.APP_FOREGROUND, eventData);
		});
	}

	/**
	 * Add event listener
	 * @param {string} eventType
	 * @param {(event: EventData) => void} callback
	 * @returns {void}
	 */
	on(eventType, callback, once = false) {
		try {
			if (!this.#isValidEventParams(eventType, callback)) {
				throw new TypeError('Invalid parameters: eventType must be string, callback must be function');
			}

			window.addEventListener(
				eventType,
				() => {
					Promise.resolve(callback()).catch((error) => {
						console.error('Event Callback error (sync or async):', error);
					});
				},
				{ once },
			);
		} catch (error) {
			console.error('❌ Failed to add listener:', error);
			return null;
		}
	}

	/**
	 * Add one-time event listener
	 * @param {string} eventType
	 * @param {(event: EventData) => void} callback
	 * @returns {void}
	 */
	once(eventType, callback) {
		on(eventType, callback, true);
	}

	/**
	 * Emit event
	 * @param {string} eventType
	 * @param {any} [data={}]
	 * @returns {EventData|null}
	 */
	emit(eventType, data = {}) {
		try {
			const event = {
				type: eventType,
				data,
				timestamp: Date.now(),
			};

			window.dispatchEvent(
				new CustomEvent(event.type, {
					detail: event,
					bubbles: false,
					cancelable: false,
				}),
			);

			return event;
		} catch (error) {
			console.error('❌ Failed to emit event:', error);
			return null;
		}
	}

	// Specific event handler functions
	/**
	 * Add event listener
	 * @param {() => void} callback
	 * @returns {void}
	 */
	onOnline(callback) {
		this.on(this.etype.NETWORK_ONLINE, callback);
	}

	/**
	 * Add event listener
	 * @param {() => void} callback
	 * @returns {void}
	 */
	onOffline(callback) {
		this.on(this.etype.NETWORK_OFFLINE, callback);
	}

	/**
	 * Add event listener
	 * @param {() => void} callback
	 * @returns {void}
	 */
	onResize(callback) {
		this.on(this.etype.APP_RESIZE, callback);
	}

	/**
	 * Add event listener
	 * @param {() => void} callback
	 * @returns {void}
	 */
	onBackground(callback) {
		this.on(this.etype.APP_BACKGROUND, callback);
	}

	/**
	 * Add event listener
	 * @param {() => void} callback
	 * @returns {void}
	 */
	onForeground(callback) {
		this.on(this.etype.APP_FOREGROUND, callback);
	}

	/**
	 * Add event listener
	 * @param {() => void} callback
	 * @returns {void}
	 */
	onRegistered(callback) {
		this.on(this.etype.SW_REGISTERD, callback);
	}

	// Specific event emitters
	emitCountryChange(countryData) {
		return this.emit(this.etype.COUNTRY_CHANGE, {
			country: countryData,
			source: 'user',
		});
	}

	emitChannelChange(channelData) {
		return this.emit(this.etype.CHANNEL_CHANGE, {
			channel: channelData,
			source: 'user',
		});
	}

	emitNewVersionInstalled(versionData) {
		return this.emit(this.etype.NEW_VERSION_INSTALLED, {
			version: versionData,
			source: 'service-worker',
		});
	}

	emitAppInstalled() {
		return this.emit(this.etype.APP_INSTALLED, {
			installDate: new Date().toISOString(),
			source: 'pwa',
		});
	}

	emitFavoritesChanged(action, channelData) {
		this.emit(this.etype.FAVORITES_CHANGED, {
			action,
			channel: channelData,
			source: 'user',
		});

		const specificEvent = action === 'added' ? this.etype.FAVORITES_ADDED : this.etype.FAVORITES_REMOVED;

		return this.emit(specificEvent, { channel: channelData, source: 'user' });
	}

	emitLoadingStart(message) {
		return this.emit(this.etype.LOADING_START, {
			message,
			source: 'application',
		});
	}

	emitLoadingEnd(message) {
		return this.emit(this.etype.LOADING_END, {
			message,
			source: 'application',
		});
	}

	emitRegistered(message) {
		return this.emit(this.etype.LOADING_END, {
			message,
			source: 'PWAManager',
		});
	}

	emitError(error, context) {
		return this.emit(this.etype.ERROR_OCCURRED, {
			error: error.message || String(error),
			context,
			stack: error.stack,
			source: 'application',
		});
	}

	/**
	 * Remove listener
	 * @param {string} eventType
	 */
	removeListener(eventType, callback) {
		window.removeEventListener(eventType, callback, { capture: false });
	}

	/**
	 * Validate event parameters
	 * @param {string} eventType
	 * @param {Function} callback
	 * @returns {boolean}
	 * @private
	 */
	#isValidEventParams(eventType, callback) {
		return typeof eventType === 'string' && typeof callback === 'function';
	}
}
