/* ========================================================================
   IPTV Player - State Management System
   Application State Management with Notifications
   ======================================================================== */

import { appConfig } from './AppConfig.js';
import { eventManager } from './EventManager.js';
import { notificationManager } from './NotificationManager.js';

/**
 * @typedef {Object} Channel
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} [logo]
 */

/**
 * @typedef {Object} AppState
 * @property {string|null} currentCountry
 * @property {string} defaultCountry
 * @property {Channel|null} currentChannel
 * @property {string|null} currentPlaylist
 * @property {string|null} currentStream
 * @property {boolean} autoplayMuted
 * @property {boolean} rememberVolume
 * @property {string} currentTheme
 * @property {number} lastUpdated
 * @property {string[]} favorites
 */

class StateManager {
	#storageKey = 'iptv-config';
	/** @type {AppState} */
	#state;
	// Legacy per-country favorites storage (kept for forward compatibility)
	#favs = {};

	constructor() {
		// Default state
		this.#state = {
			currentCountry: null,
			defaultCountry: 'US',
			currentChannel: null,
			currentPlaylist: null,
			currentStream: null,
			autoplayMuted: false,
			rememberVolume: true,
			lastUpdated: Date.now(),
			currentTheme: '',
			favorites: []
		};
		// optional legacy bucket
		this.#favs = { us: { url: 0 } };
	}

	/** Persist current state to localStorage */
	save() {
		try {
			localStorage.setItem(this.#storageKey, JSON.stringify(this.#state));
			localStorage.setItem(`${this.#storageKey}-favs`, JSON.stringify(this.#favs));
		} catch (e) {
			console.warn('State save failed:', e);
		}
	}

	/**
	 * Load state from localStorage and merge with defaults
	 * @returns {AppState}
	 */
	load() {
		try {
			const rawState = localStorage.getItem(this.#storageKey);
			const rawFavs = localStorage.getItem(`${this.#storageKey}-favs`);
			const loaded = rawState ? JSON.parse(rawState) : {};
			const favs = rawFavs ? JSON.parse(rawFavs) : this.#favs;

			// Merge cautiously to keep shape stable
			this.#state = {
				...this.#state,
				...loaded,
				favorites: Array.isArray(loaded?.favorites) ? loaded.favorites : this.#state.favorites,
				lastUpdated: Date.now()
			};
			this.#favs = favs && typeof favs === 'object' ? favs : this.#favs;

			// Notify listeners with a snapshot
			eventManager.emit(eventManager.etype.STATE_LOADED, { state: this.getState() });
			return this.getState();
		} catch (error) {
			console.error('Failed to load state:', error);
			return this.getState();
		}
	}

	/**
	 * Return a shallow clone of the current state
	 * @returns {AppState}
	 */
	getState() {
		return { ...this.#state, favorites: [...this.#state.favorites] };
	}

	/**
	 * Set selected country (2-letter code)
	 * @param {string|null} countryCode
	 */
	setCountry(countryCode) {
		const prev = this.#state.currentCountry;
		if (prev === countryCode) return;
		this.#state.currentCountry = countryCode;
		this.#touch();
		this.save();
		eventManager.emit(eventManager.etype.COUNTRY_CHANGE, { prev, current: countryCode });
	}

	/**
	 * Set current playing channel
	 * @param {Channel|null} channel
	 */
	setChannel(channel) {
		const prev = this.#state.currentChannel;
		if (prev?.id === channel?.id) return;
		this.#state.currentChannel = channel || null;
		this.#touch();
		this.save();
		eventManager.emit(eventManager.etype.CHANNEL_CHANGE, { prev, current: channel || null });
	}

	/**
	 * Set current playlist URL
	 * @param {string|null} playlist
	 */
	setPlaylist(playlist) {
		const prev = this.#state.currentPlaylist;
		if (prev === playlist) return;
		this.#state.currentPlaylist = playlist || null;
		this.#touch();
		this.save();
		eventManager.emit(eventManager.etype.PLAYLIST_CHANGE, { prev, current: this.#state.currentPlaylist });
	}

	/**
	 * Set current stream URL
	 * @param {string|null} stream
	 */
	setStream(stream) {
		const prev = this.#state.currentStream;
		if (prev === stream) return;
		this.#state.currentStream = stream || null;
		this.#touch();
		this.save();
		eventManager.emit(eventManager.etype.STREAM_CHANGE, { prev, current: this.#state.currentStream });
	}

	/**
	 * Replace favorites list entirely
	 * @param {string[]} favorites
	 */
	setFavorites(favorites) {
		const next = Array.from(new Set(Array.isArray(favorites) ? favorites : []));
		const prev = [...this.#state.favorites];
		this.#state.favorites = next;
		this.#touch();
		this.save();
		eventManager.emit(eventManager.etype.FAVORITES_CHANGED, { prev, current: [...next] });
		notificationManager.success('Favoriler güncellendi', 'Favori listesi değişti');
	}

	/**
	 * Add a channel id into favorites
	 * @param {string} channelId
	 */
	addFavorite(channelId) {
		if (!channelId) return;
		if (!Array.isArray(this.#state.favorites)) this.#state.favorites = [];
		if (!this.#state.favorites.includes(channelId)) {
			const prev = [...this.#state.favorites];
			this.#state.favorites.push(channelId);
			this.#touch();
			this.save();
			eventManager.emit(eventManager.etype.FAVORITES_ADDED, { channelId, prev, current: [...this.#state.favorites] });
		}
	}

	/**
	 * Remove a channel id from favorites
	 * @param {string} channelId
	 */
	removeFavorite(channelId) {
		if (!Array.isArray(this.#state.favorites) || !channelId) return;
		const idx = this.#state.favorites.indexOf(channelId);
		if (idx !== -1) {
			const prev = [...this.#state.favorites];
			this.#state.favorites.splice(idx, 1);
			this.#touch();
			this.save();
			eventManager.emit(eventManager.etype.FAVORITES_REMOVED, { channelId, prev, current: [...this.#state.favorites] });
		}
	}

	/** Update lastUpdated */
	#touch() {
		this.#state.lastUpdated = Date.now();
	}
}

export const stateManager = new StateManager();

// Dev’de global erişim (export adıyla, window.iptv altında)
if (appConfig.isDevelopment && typeof window !== 'undefined') {
	window.iptv = window.iptv || {};
	window.iptv.stateManager = stateManager;
}
