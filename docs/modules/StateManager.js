/* ========================================================================
   IPTV Player - State Management System
   Application State Management with Notifications
   ======================================================================== */

import { AppConfig } from './AppConfig.js';
import { EventManager } from './EventManager.js';
import { NotificationManager } from './NotificationManager.js';
import { PWAManager } from './PWAManager.js';
import { SettingsManager } from './SettingsManager.js';

// Modern ES6 Singleton StateManager
export class StateManager {
	static #instance = null;
	#storageKey = 'iptv-config';
	#state = {};
	favs = {
		us: {},
	};

	/** @type {EventManager} */
	#em = null;

	/** @type {NotificationManager} */
	#nm = null;

	constructor() {
		if (StateManager.#instance) {
			throw new Error('StateManager is a singleton. Use StateManager.getInstance()');
		}
		// Varsayılan state
		this.#state = {
			currentCountry: null,
			defaultCountry: 'us',
			currentChannel: null,
			currentPlaylist: null,
			currentStream: null,
			autoplayMuted: false,
			rememberVolume: true,
			lastUpdated: Date.now(),
			currentTheme: '',
		};
		this.fav;
		this.#nm = NotificationManager.getInstance();
		this.#em = EventManager.getInstance();
	}

	/**
	 * Get singleton instance
	 * @returns {StateManager}
	 */
	static getInstance() {
		if (!StateManager.#instance) {
			StateManager.#instance = new StateManager();
			window.iptv = window.iptv || {};
			window.iptv.state = StateManager;
		}
		return StateManager.#instance;
	}

	save() {
		localStorage.setItem(this.#storageKey, JSON.stringify(this.#state));
		localStorage.setItem(`${this.#storageKey}-favs`, JSON.stringify(this.favs));
	}
	load() {
		try {
			let storedState = localStorage.getItem(this.#storageKey);
			let storedFavs = localStorage.getItem(`${this.#storageKey}-favs`);
			storedState = JSON.parse(storedState);
			storedFavs = JSON.parse(storedFavs);

			this.#state = storedState;
			this.favs = storedFavs;
			// TODO notify
		} catch (error) {
			console.error('warn', '❌ Failed to load states', error);
			return {};
		}
	}

	getState() {
		return { ...this.#state };
	}

	setCountry(country) {
		const prev = this.#state.country;
		this.#state.country = country;
		this.#em.emit(this.#em.estr.COUNTRY_CHANGE, { prev, country });
	}

	setChannel(channel) {
		const prev = this.#state.channel;
		this.#state.channel = channel;
		this.#em.emit(this.#em.estr.CHANNEL_CHANGE, { prev, channel });
	}

	setPlaylist(playlist) {
		const prev = this.#state.playlist;
		this.#state.playlist = playlist;
		this.#em.emit('playlist:change', { prev, playlist });
		//this.nm.info('Playlist değişti', String(playlist));
	}

	setStream(stream) {
		const prev = this.#state.stream;
		this.#state.stream = stream;
		this.#em.emit('stream:change', { prev, stream });
		//this.nm.info('Stream değişti', String(stream));
	}

	setFavorites(favorites) {
		const prev = [...this.#state.favorites];
		this.#state.favorites = [...favorites];
		this.#em.emit(this.#em.estr.FAVORITES_CHANGED, { prev, favorites });
		this.nm.success('Favoriler güncellendi', 'Favori listesi değişti');
	}

	addFavorite(channel) {
		if (!this.#state.favorites.includes(channel)) {
			const prev = [...this.#state.favorites];
			this.#state.favorites.push(channel);
			this.#em.emit(this.#em.estr.FAVORITES_ADDED, { channel });
		}
	}

	removeFavorite(channel) {
		const idx = this.#state.favorites.indexOf(channel);
		if (idx !== -1) {
			const prev = [...this.#state.favorites];
			this.#state.favorites.splice(idx, 1);
			this.#em.emit(this.#em.estr.FAVORITES_REMOVED, { channel });
		}
	}

	// setInstalled(installed) {
	// 	const prev = this.#state.installed;
	// 	this.#state.installed = installed;
	// 	this.#em.emit(this.#em.estr.APP_INSTALLED, { prev, installed });
	// }

	// setVersion(version) {
	// 	const prev = this.#state.version;
	// 	this.#state.version = version;
	// 	this.#em.emit(this.#em.estr.NEW_VERSION_INSTALLED, { prev, version });
	// }
}
