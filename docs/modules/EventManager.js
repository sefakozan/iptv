// EventManager.js
// IPTV Player - Modern Event Management System

import { appConfig } from './AppConfig.js';

/**
 * @typedef {Object} EventData
 * @property {string} type
 * @property {any} data
 * @property {number} timestamp
 */

export class EventManager {
	etype = Object.freeze({
		NETWORK_ONLINE: 'network:online',
		NETWORK_OFFLINE: 'network:offline',
		APP_RESIZE: 'app:resize',
		APP_BACKGROUND: 'app:background',
		APP_FOREGROUND: 'app:foreground'
	});

	#initialized = false;
	#initPromise = null;
	#handlerMap = new Map();

	isInitialized() {
		return this.#initialized;
	}

	async initialize() {
		if (this.#initPromise) return this.#initPromise;
		this.#initPromise = (async () => {
			if (this.#initialized) return;
			this.#setupBrowserEvents();
			this.#initialized = true;
		})();
		return this.#initPromise;
	}

	#setupBrowserEvents() {
		const emitNet = (on) => this.emit(on ? this.etype.NETWORK_ONLINE : this.etype.NETWORK_OFFLINE, { source: 'browser' });

		window.addEventListener('online', () => emitNet(true));
		window.addEventListener('offline', () => emitNet(false));
		if ('onLine' in navigator) emitNet(navigator.onLine);

		window.addEventListener('resize', () => this.emit(this.etype.APP_RESIZE, { width: window.innerWidth, height: window.innerHeight }));
		document.addEventListener('visibilitychange', () => {
			const hidden = document.hidden;
			this.emit(hidden ? this.etype.APP_BACKGROUND : this.etype.APP_FOREGROUND, { visibilityState: document.visibilityState });
		});
	}

	on(eventType, callback) {
		if (typeof eventType !== 'string' || typeof callback !== 'function') return () => {};
		if (!this.#handlerMap.has(eventType)) this.#handlerMap.set(eventType, new Set());
		const set = this.#handlerMap.get(eventType);
		if (set.has(callback)) return () => this.off(eventType, callback);

		const wrapper = (evt) => {
			const payload = evt?.detail;
			try {
				callback(payload);
			} catch (e) {
				console.error('Event callback error:', e);
			}
		};
		set.add(callback);
		window.addEventListener(eventType, wrapper, { passive: true });

		return () => this.off(eventType, callback, wrapper);
	}

	off(eventType, callback, wrapperRef) {
		const set = this.#handlerMap.get(eventType);
		if (!set || !set.has(callback)) return;
		// Tek listener sarmalayıcısını bulmak için capture=false ile kaldır
		window.removeEventListener(eventType, wrapperRef || (() => {}), { capture: false });
		set.delete(callback);
		if (set.size === 0) this.#handlerMap.delete(eventType);
	}

	emit(eventType, data = {}) {
		const event = { type: eventType, data, timestamp: Date.now() };
		window.dispatchEvent(new CustomEvent(event.type, { detail: event, bubbles: false, cancelable: false }));
		return event;
	}
}

// Export + init
export const eventManager = new EventManager();
await eventManager.initialize();

// Dev’de global erişim (export adıyla, window.iptv altında)
if (appConfig.isDevelopment && typeof window !== 'undefined') {
	window.iptv = window.iptv || {};
	window.iptv.eventManager = eventManager;
}
