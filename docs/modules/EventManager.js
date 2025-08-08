// EventManager.js
// IPTV Player - Modern Event Management System
// Using modern ES modules, TypeScript-ready, and optimized patterns

/**
 * @typedef {Object} EventOptions
 * @property {boolean} [once=false] - Whether the listener should be called only once
 * @property {number} [priority=0] - Listener priority (higher executes first)
 */

/**
 * @typedef {Object} EventData
 * @property {string} type - Event type
 * @property {any} data - Event payload
 * @property {number} timestamp - Event timestamp
 * @property {string} id - Unique event ID
 */

/**
 * @typedef {Object} Listener
 * @property {Function} callback - Listener callback function
 * @property {boolean} once - Whether it's a one-time listener
 * @property {number} priority - Listener priority
 * @property {string} id - Unique listener ID
 */

// biome-ignore lint/correctness/noUnusedVariables: <loaded script>
class EventManager {
	// Constants
	static #MAX_HISTORY_SIZE = 100;
	estr = Object.freeze({
		COUNTRY_CHANGE: 'country:change',
		CHANNEL_CHANGE: 'channel:change',
		NEW_VERSION_INSTALLED: 'app:version:installed',
		APP_INSTALLED: 'app:installed',
		FAVORITES_CHANGED: 'favorites:changed',
		FAVORITES_ADDED: 'favorites:added',
		FAVORITES_REMOVED: 'favorites:removed',
		LOADING_START: 'loading:start',
		LOADING_END: 'loading:end',
		ERROR_OCCURRED: 'error:occurred',
		SETTINGS_CHANGED: 'settings:changed',
		VIDEO_PLAY: 'video:play',
		VIDEO_PAUSE: 'video:pause',
		VIDEO_ERROR: 'video:error',
		NETWORK_ONLINE: 'network:online',
		NETWORK_OFFLINE: 'network:offline',
		CACHE_CLEARED: 'cache:cleared',
		PWA_UPDATE_AVAILABLE: 'pwa:update:available',
		PWA_UPDATE_INSTALLED: 'pwa:update:installed',
	});

	/** @type {EventManager|null} */
	static #instance = null;

	/** @type {Map<string, Listener[]>} */
	#listeners = new Map();

	/** @type {EventData[]} */
	#eventHistory = [];

	/**
	 * @private Use EventManager.getInstance() instead
	 */
	constructor() {
		if (EventManager.#instance) {
			throw new Error('EventManager is a singleton. Use EventManager.getInstance()');
		}
		this.initialize();
	}

	/**
	 * Get singleton instance
	 * @returns {EventManager}
	 */
	static getInstance() {
		if (!EventManager.#instance) {
			EventManager.#instance = new EventManager();
			window.iptv_em = EventManager.#instance;
		}
		return EventManager.#instance;
	}

	/**
	 * Initialize event system
	 * @private
	 */
	initialize() {
		this.setupBrowserEvents();
		console.info('🎯 EventManager initialized', {
			events: Object.values(this.estr),
		});
	}

	/**
	 * Setup browser-level event listeners
	 * @private
	 */
	setupBrowserEvents() {
		const emitNetworkEvent = (isOnline) => {
			this.emit(this.estr[`NETWORK_${isOnline ? 'ONLINE' : 'OFFLINE'}`], {
				timestamp: Date.now(),
				source: 'browser',
			});
		};

		// TODO

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

		document.addEventListener('visibilitychange', () => {
			const eventData = {
				hidden: document.hidden,
				visibilityState: document.visibilityState,
				timestamp: Date.now(),
			};
			this.emit(document.hidden ? 'app:background' : 'app:foreground', eventData);
		});
	}

	/**
	 * Add event listener
	 * @param {string} eventType
	 * @param {(event: EventData) => void} callback
	 * @param {EventOptions} [options={}]
	 * @returns {string|null} listener ID
	 */
	on(eventType, callback, options = {}) {
		try {
			if (!this.#isValidEventParams(eventType, callback)) {
				throw new TypeError('Invalid parameters: eventType must be string, callback must be function');
			}

			const listener = {
				callback,
				once: !!options.once,
				priority: Number(options.priority) || 0,
				id: this.#generateId('listener'),
			};

			const listeners = this.#listeners.get(eventType) || [];
			listeners.push(listener);
			this.#listeners.set(
				eventType,
				listeners.sort((a, b) => b.priority - a.priority),
			);

			console.debug(`🎯 Listener added: ${eventType} (ID: ${listener.id})`);
			return listener.id;
		} catch (error) {
			console.error('❌ Failed to add listener:', error);
			return null;
		}
	}

	/**
	 * Add one-time event listener
	 * @param {string} eventType
	 * @param {(event: EventData) => void} callback
	 * @param {EventOptions} [options={}]
	 * @returns {string|null}
	 */
	once(eventType, callback, options = {}) {
		return this.on(eventType, callback, { ...options, once: true });
	}

	/**
	 * Remove event listener
	 * @param {string} eventType
	 * @param {string} listenerId
	 * @returns {boolean}
	 */
	off(eventType, listenerId) {
		try {
			const listeners = this.#listeners.get(eventType);
			if (!listeners) return false;

			const index = listeners.findIndex((l) => l.id === listenerId);
			if (index === -1) return false;

			listeners.splice(index, 1);
			if (listeners.length === 0) {
				this.#listeners.delete(eventType);
			}

			console.debug(`🎯 Listener removed: ${eventType} (ID: ${listenerId})`);
			return true;
		} catch (error) {
			console.error('❌ Failed to remove listener:', error);
			return false;
		}
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
				id: this.#generateId('event'),
			};

			this.#addToHistory(event);
			const listeners = this.#listeners.get(eventType) || [];

			console.debug(`🎯 Emitting: ${eventType}`, data);

			const listenersToRemove = [];
			for (const listener of listeners) {
				try {
					listener.callback(event);
					if (listener.once) listenersToRemove.push(listener.id);
				} catch (error) {
					console.error(`❌ Listener error for ${eventType}:`, error);
				}
			}

			listenersToRemove.forEach((id) => this.off(eventType, id));
			return event;
		} catch (error) {
			console.error('❌ Failed to emit event:', error);
			return null;
		}
	}

	// Specific event emitters
	emitCountryChange(countryData) {
		return this.emit(this.estr.COUNTRY_CHANGE, {
			country: countryData,
			source: 'user',
		});
	}

	emitChannelChange(channelData) {
		return this.emit(this.estr.CHANNEL_CHANGE, {
			channel: channelData,
			source: 'user',
		});
	}

	emitNewVersionInstalled(versionData) {
		return this.emit(this.estr.NEW_VERSION_INSTALLED, {
			version: versionData,
			source: 'service-worker',
		});
	}

	emitAppInstalled() {
		return this.emit(this.estr.APP_INSTALLED, {
			installDate: new Date().toISOString(),
			source: 'pwa',
		});
	}

	emitFavoritesChanged(action, channelData) {
		this.emit(this.estr.FAVORITES_CHANGED, {
			action,
			channel: channelData,
			source: 'user',
		});

		const specificEvent = action === 'added' ? this.estr.FAVORITES_ADDED : this.estr.FAVORITES_REMOVED;

		return this.emit(specificEvent, { channel: channelData, source: 'user' });
	}

	emitLoadingStart(message) {
		return this.emit(this.estr.LOADING_START, {
			message,
			source: 'application',
		});
	}

	emitLoadingEnd(message) {
		return this.emit(this.estr.LOADING_END, {
			message,
			source: 'application',
		});
	}

	emitError(error, context) {
		return this.emit(this.estr.ERROR_OCCURRED, {
			error: error.message || String(error),
			context,
			stack: error.stack,
			source: 'application',
		});
	}

	/**
	 * Add event to history
	 * @param {EventData} event
	 * @private
	 */
	#addToHistory(event) {
		this.#eventHistory.push(event);
		if (this.#eventHistory.length > EventManager.#MAX_HISTORY_SIZE) {
			this.#eventHistory.shift();
		}
	}

	/**
	 * Get event history
	 * @param {string|null} eventType
	 * @param {number} [limit=10]
	 * @returns {EventData[]}
	 */
	getHistory(eventType = null, limit = 10) {
		const history = eventType ? this.#eventHistory.filter((e) => e.type === eventType) : this.#eventHistory;
		return history.slice(-Math.min(limit, history.length));
	}

	/**
	 * Clear event history
	 */
	clearHistory() {
		this.#eventHistory = [];
		console.debug('🎯 Event history cleared');
	}

	/**
	 * Get listener count for event type
	 * @param {string} eventType
	 * @returns {number}
	 */
	getListenerCount(eventType) {
		return this.#listeners.get(eventType)?.length || 0;
	}

	/**
	 * Get active event types
	 * @returns {string[]}
	 */
	getActiveEventTypes() {
		return Array.from(this.#listeners.keys());
	}

	/**
	 * Remove all listeners for event type
	 * @param {string} eventType
	 * @returns {number} Number of listeners removed
	 */
	removeAllListeners(eventType) {
		const count = this.getListenerCount(eventType);
		if (count > 0) {
			this.#listeners.delete(eventType);
			console.debug(`🎯 Removed ${count} listeners for ${eventType}`);
		}
		return count;
	}

	/**
	 * Generate unique ID
	 * @param {string} prefix
	 * @returns {string}
	 * @private
	 */
	#generateId(prefix) {
		return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
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

	/**
	 * Get event system statistics
	 * @returns {Object}
	 */
	getStats() {
		const stats = {
			totalListeners: 0,
			eventTypes: this.#listeners.size,
			historySize: this.#eventHistory.length,
			listenersByType: {},
		};

		for (const [eventType, listeners] of this.#listeners) {
			stats.totalListeners += listeners.length;
			stats.listenersByType[eventType] = listeners.length;
		}

		return stats;
	}

	/**
	 * Debug system state
	 */
	debug() {
		console.group('🎯 EventManager Debug');
		console.log('Stats:', this.getStats());
		console.log('Active Events:', this.getActiveEventTypes());
		console.log('Recent History:', this.getHistory(null, 5));
		console.groupEnd();
	}
}
