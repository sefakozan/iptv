// SettingsManager.js
// IPTV Player - Advanced Settings Management System
// Modern class-based implementation with Singleton Pattern

import { EventManager } from './EventManager.js';
import { NotificationManager } from './NotificationManager.js';
import { PWAManager } from './PWAManager.js';

/**
 * @typedef {Object} Settings
 * @property {string|null} defaultCountry - Default country code
 * @property {boolean} autoplayMuted - Autoplay muted setting
 * @property {boolean} rememberVolume - Remember volume setting
 * @property {number} lastUpdated - Last update timestamp
 */

/**
 * @typedef {Object} ToastAction
 * @property {string} text - Action button text
 * @property {() => void} action - Action callback
 * @property {string} [class] - Button CSS class
 */

/**
 * @typedef {Object} Country
 * @property {string} code - Country code
 * @property {string} name - Country name
 * @property {boolean} [disabled] - Whether the country is disabled
 */

/**
 * @typedef {Object} SettingsConfig
 * @property {string} storageKey - LocalStorage key
 * @property {boolean} debugMode - Enable debug logging
 */

/**
 * SettingsManager class - Singleton for managing IPTV Player settings
 */
export class SettingsManager {
	/** @type {SettingsManager|null} */
	static #instance = null;

	/** @type {SettingsConfig} */
	#config;

	/** @type {number|null} */
	#updateCheckInterval = null;

	/** @type {boolean} */
	#updateNotificationShown = false;

	/** @type {NotificationManager} */
	#nm = NotificationManager.getInstance();

	/** @type {PWAManager} */
	#pwa = PWAManager.getInstance();

	/** @type {EventManager} */
	#em = EventManager.getInstance();

	/**
	 * @param {Partial<SettingsConfig>} [config]
	 * @private Use SettingsManager.getInstance()
	 */
	constructor(config = {}) {
		if (SettingsManager.#instance) {
			throw new Error('SettingsManager is a singleton. Use SettingsManager.getInstance()');
		}
		this.#config = {
			storageKey: config.storageKey ?? 'iptv',
			debugMode: config.debugMode ?? false,
		};
		this.#initialize();
		window.iptv = window.iptv || {};
		window.iptv.settings = this;
	}

	/**
	 * Get singleton instance
	 * @param {Partial<SettingsConfig>} [config]
	 * @returns {SettingsManager}
	 */
	static getInstance(config) {
		if (!SettingsManager.#instance) {
			SettingsManager.#instance = new SettingsManager(config);
		}
		return SettingsManager.#instance;
	}

	/**
	 * Initialize settings system
	 * @private
	 */
	#initialize() {
		this.#initializeAutoUpdate();
		this.#log('info', '⚙️ SettingsManager initialized');
	}

	/**
	 * Get all settings from localStorage
	 * @returns {Settings}
	 */
	getSettings() {
		try {
			const stored = localStorage.getItem(this.#config.storageKey);
			return stored ? JSON.parse(stored) : {};
		} catch (error) {
			this.#log('warn', '❌ Failed to load settings', error);
			return {};
		}
	}

	/**
	 * Save settings to localStorage
	 * @param {Partial<Settings>} settings
	 * @returns {boolean}
	 */
	saveSettings(settings) {
		try {
			const currentSettings = this.getSettings();
			const updatedSettings = { ...currentSettings, ...settings };
			localStorage.setItem(this.#config.storageKey, JSON.stringify(updatedSettings));
			this.#log('info', '⚙️ Settings saved', updatedSettings);
			return true;
		} catch (error) {
			this.#emitError(error, 'Saving settings', 'validation');
			return false;
		}
	}

	/**
	 * Update modal status information
	 */
	updateModalStatus() {
		try {
			const isInstalled = this.#pwa.isAppInstalled();
			this.#updateInstallStatus(isInstalled);
			this.#updateServiceWorkerStatus();
			this.#updateLastUpdatedTime();
			this.#updateHeaderInstallButton(isInstalled);
		} catch (error) {
			this.#log('warn', '❌ Error updating modal status', error);
		}
	}

	/**
	 * Update install status in modal
	 * @param {boolean} isInstalled
	 * @private
	 */
	#updateInstallStatus(isInstalled) {
		const $installStatus = document.querySelector('#installStatus');
		const $installBtn = document.querySelector('#installAppBtn');
		if (!$installStatus || !$installBtn) return;

		$installStatus.className = `badge ${isInstalled ? 'bg-success' : 'bg-secondary'}`;
		$installStatus.innerHTML = isInstalled ? '<i class="fas fa-check me-1"></i>Installed' : '<i class="fas fa-download me-1"></i>Not Installed';
		$installBtn.classList.toggle('d-none', isInstalled || !window.deferredPrompt);
	}

	/**
	 * Update service worker status in modal
	 * @private
	 */
	async #updateServiceWorkerStatus() {
		const $swStatus = document.querySelector('#swStatus');
		const $updateBtn = document.querySelector('#updateSwBtn');
		if (!$swStatus || !$updateBtn) return;

		if (!('serviceWorker' in navigator)) {
			$swStatus.className = 'badge bg-secondary';
			$swStatus.innerHTML = '<i class="fas fa-times me-1"></i>Not Supported';
			$updateBtn.classList.add('d-none');
			return;
		}

		const registrations = await navigator.serviceWorker.getRegistrations();
		if (registrations.length === 0) {
			$swStatus.className = 'badge bg-warning';
			$swStatus.innerHTML = '<i class="fas fa-exclamation me-1"></i>Not Active';
			$updateBtn.classList.add('d-none');
			return;
		}

		const registration = registrations[0];
		$swStatus.className = `badge ${registration.waiting ? 'bg-warning' : 'bg-success'}`;
		$swStatus.innerHTML = registration.waiting ? '<i class="fas fa-exclamation me-1"></i>Update Available' : '<i class="fas fa-check me-1"></i>Active';
		$updateBtn.classList.toggle('d-none', !registration.waiting);
	}

	/**
	 * Update last updated time in modal
	 * @private
	 */
	#updateLastUpdatedTime() {
		const $lastUpdated = document.querySelector('#lastUpdated');
		if ($lastUpdated) {
			$lastUpdated.textContent = new Date().toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'long',
				day: 'numeric',
			});
		}
	}

	/**
	 * Update header install button
	 * @param {boolean} isInstalled
	 * @private
	 */
	async #updateHeaderInstallButton(isInstalled) {
		try {
			const $headerInstallBtn = document.querySelector('#headerInstallBtn');
			if (!$headerInstallBtn) return;

			const $btnIcon = $headerInstallBtn.querySelector('i');
			const $btnText = $headerInstallBtn.querySelector('.btn-text');
			if (!$btnIcon || !$btnText) return;

			$headerInstallBtn.className = `btn ${isInstalled ? 'btn-outline-success' : 'btn-outline-light'}`;
			$headerInstallBtn.disabled = isInstalled;
			$headerInstallBtn.title = isInstalled ? 'App is installed' : 'Install IPTV Player as PWA';

			$btnIcon.className = isInstalled ? 'fas fa-check-circle' : 'fas fa-download';
			$btnText.textContent = isInstalled ? ((await this.getServiceWorkerVersion()) ?? 'v2.1.3') : 'Install App';

			$headerInstallBtn.style.display = isInstalled || window.deferredPrompt ? '' : 'none';
		} catch (error) {
			this.#log('warn', '❌ Error updating header install button', error);
		}
	}

	/**
	 * Save current settings from modal UI
	 */
	saveCurrentSettings() {
		const $defaultCountrySelect = document.querySelector('#defaultCountrySelect');
		const $autoplayMuted = document.querySelector('#autoplayMuted');
		const $rememberVolume = document.querySelector('#rememberVolume');

		if (!$defaultCountrySelect || !$autoplayMuted || !$rememberVolume) return;

		const success = this.saveSettings({
			defaultCountry: $defaultCountrySelect.value || null,
			autoplayMuted: $autoplayMuted.checked,
			rememberVolume: $rememberVolume.checked,
			lastUpdated: Date.now(),
		});

		if (success) {
			this.#nm.success('', 'Settings saved successfully!');
		}
	}

	/**
	 * Reset settings to defaults
	 */
	resetToDefaults() {
		try {
			localStorage.removeItem(this.#config.storageKey);
			const $defaultCountrySelect = document.querySelector('#defaultCountrySelect');
			const $autoplayMuted = document.querySelector('#autoplayMuted');
			const $rememberVolume = document.querySelector('#rememberVolume');

			if ($defaultCountrySelect) $defaultCountrySelect.value = '';
			if ($autoplayMuted) $autoplayMuted.checked = true;
			if ($rememberVolume) $rememberVolume.checked = false;

			this.#nm.success('', 'Settings reset to defaults!');
		} catch (error) {
			this.#emitError(error, 'Resetting settings', 'storage');
		}
	}

	/**
	 * Populate default country select
	 * @param {Country[]} countries
	 */
	populateDefaultCountrySelect(countries) {
		try {
			const $defaultCountrySelect = document.querySelector('#defaultCountrySelect');
			if (!$defaultCountrySelect) return;

			const currentSettings = this.getSettings();
			$defaultCountrySelect.innerHTML = '<option value="">No default (manual selection)</option>';

			countries.forEach((country) => {
				if (country.disabled) return;
				const option = new Option(country.name, country.code.toLowerCase());
				if (currentSettings.defaultCountry === country.code.toLowerCase()) {
					option.selected = true;
				}
				$defaultCountrySelect.appendChild(option);
			});

			const $autoplayMuted = document.querySelector('#autoplayMuted');
			const $rememberVolume = document.querySelector('#rememberVolume');
			if ($autoplayMuted) $autoplayMuted.checked = currentSettings.autoplayMuted ?? true;
			if ($rememberVolume) $rememberVolume.checked = currentSettings.rememberVolume ?? false;

			this.#log('info', '⚙️ Populated default country select and loaded audio preferences');
		} catch (error) {
			this.#emitError(error, 'Populating settings', 'ui');
		}
	}

	/**
	 * Load and apply default settings
	 * @param {Country[]} countries
	 */
	async loadDefaultSettings(countries) {
		try {
			const settings = this.getSettings();
			const { defaultCountry } = settings;
			const $countrySelect = document.querySelector('#countrySelect');

			if (!$countrySelect || !defaultCountry) {
				$countrySelect.value = 'us';
				$countrySelect?.dispatchEvent(new Event('change'));
				return;
			}

			const countryExists = countries.some((c) => c.code.toLowerCase() === defaultCountry.toLowerCase());
			$countrySelect.value = countryExists ? defaultCountry : 'us';
			$countrySelect.dispatchEvent(new Event('change'));

			this.#log('info', `⚙️ Loading default country: ${$countrySelect.value}`);
		} catch (error) {
			this.#emitError(error, 'Loading default settings', 'validation');
			document.querySelector('#countrySelect').value = 'us';
			document.querySelector('#countrySelect')?.dispatchEvent(new Event('change'));
		}
	}

	/**
	 * Initialize automatic PWA update checking
	 * @private
	 */
	#initializeAutoUpdate() {
		this.#updateCheckInterval = setInterval(() => this.checkForPWAUpdates(), 30000);
		document.addEventListener(
			'visibilitychange',
			() => {
				if (!document.hidden) setTimeout(() => this.checkForPWAUpdates(), 1000);
			},
			{ passive: true },
		);
		setTimeout(() => this.checkForPWAUpdates(), 5000);
	}

	/**
	 * Check for PWA updates
	 */
	async checkForPWAUpdates() {
		try {
			if (!('serviceWorker' in navigator)) return;

			const registration = await navigator.serviceWorker.getRegistration();
			if (!registration) return;

			await registration.update();
			if (registration.waiting) {
				this.#handleAvailableUpdate(registration);
			}

			registration.addEventListener('updatefound', () => {
				const newWorker = registration.installing;
				if (!newWorker) return;

				newWorker.addEventListener('statechange', () => {
					if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
						this.#handleAvailableUpdate(registration);
					}
				});
			});
		} catch (error) {
			this.#log('error', '❌ PWA update check failed', error);
		}
	}

	/**
	 * Handle available PWA update
	 * @param {ServiceWorkerRegistration} registration
	 * @private
	 */
	#handleAvailableUpdate(registration) {
		if (this.#updateNotificationShown) return;
		this.#updateNotificationShown = true;

		this.#nm.primary('Update Available', 'A new version of the app is available!', {
			delay: 0,
			actions: [
				{
					text: 'Update Now',
					action: () => this.#applyPWAUpdate(registration),
				},
				{
					text: 'Later',
					action: () => {
						this.#updateNotificationShown = false;
					},
				},
			],
		});
	}

	/**
	 * Apply PWA update
	 * @param {ServiceWorkerRegistration} registration
	 * @private
	 */
	async #applyPWAUpdate(registration) {
		try {
			if (!registration.waiting) return;

			registration.waiting.postMessage({ type: 'SKIP_WAITING' });
			navigator.serviceWorker.addEventListener('controllerchange', async () => {
				const newVersion = await this.getServiceWorkerVersion();
				this.#nm.success('Update Complete', `App updated to ${newVersion ?? 'new version'}!`, {
					delay: 0,
					actions: [{ text: 'Reload Page', action: () => window.location.reload() }],
				});
				setTimeout(() => this.#updateHeaderInstallButtonVersion(newVersion), 1000);
			});
		} catch (error) {
			this.#nm.error('Update Failed', 'Update failed. Please refresh the page manually.');
			this.#log('error', '❌ PWA update application failed', error);
		}
	}

	/**
	 * Get service worker version
	 * @returns {Promise<string|null>}
	 */
	async getServiceWorkerVersion() {
		try {
			if (!('serviceWorker' in navigator)) return null;

			const registration = await navigator.serviceWorker.getRegistration();
			if (!registration?.active) return null;

			return new Promise((resolve) => {
				const messageChannel = new MessageChannel();
				messageChannel.port1.onmessage = (event) => resolve(event.data?.version ?? null);
				registration.active.postMessage({ type: 'GET_VERSION' }, [messageChannel.port2]);
				setTimeout(() => resolve(null), 2000);
			});
		} catch (error) {
			this.#log('warn', '❌ Failed to get service worker version', error);
			return null;
		}
	}

	/**
	 * Update header install button with version
	 * @param {string|null} version
	 * @private
	 */
	#updateHeaderInstallButtonVersion(version) {
		try {
			const $headerInstallBtn = document.querySelector('#headerInstallBtn');
			if (version && $headerInstallBtn?.classList.contains('btn-outline-success')) {
				$headerInstallBtn.querySelector('.btn-text').textContent = version;
				this.#log('info', `⚙️ Header button updated with version: ${version}`);
			}
		} catch (error) {
			this.#log('warn', '❌ Error updating header button version', error);
		}
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
	 * Sanitize HTML content
	 * @param {string} str
	 * @returns {string}
	 * @private
	 */
	#sanitizeHtml(str) {
		const div = document.createElement('div');
		div.textContent = str;
		return div.innerHTML;
	}

	/**
	 * Log messages with level
	 * @param {'info' | 'warn' | 'error'} level
	 * @param {string} message
	 * @param {...any} args
	 * @private
	 */
	#log(level, message, ...args) {
		if (this.#config.debugMode || level !== 'info') {
			console[level](message, ...args);
		}
	}

	/**
	 * Emit error to EventManager
	 * @param {Error} error
	 * @param {string} context
	 * @param {'validation' | 'storage' | 'ui'} type
	 * @private
	 */
	#emitError(error, context, type) {
		// Assuming EventManager is available globally or imported
		window.iptv_em?.emitError?.(error, context, type);
	}

	/**
	 * Stop automatic update checking
	 */
	stopAutoUpdate() {
		if (this.#updateCheckInterval) {
			clearInterval(this.#updateCheckInterval);
			this.#updateCheckInterval = null;
			this.#log('info', '⚙️ Stopped auto-update checking');
		}
	}
}
