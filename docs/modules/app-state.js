/* ========================================================================
   IPTV Player - Application State Management
   ======================================================================== */

// Application State Management
class ApplicationState {
	constructor() {
		this.countries = [];
		this.channels = [];
		this.currentCountry = null;
		this.currentChannel = null;
		this.isLoading = false;
		this.cache = new Map();
		this.hls = null;
		this.isFirstLoad = true;
	}

	// Update state with notifications
	setState(key, value) {
		const oldValue = this[key];
		this[key] = value;
		this.notifyStateChange(key, value, oldValue);
	}

	// Get current state
	getState(key) {
		return this[key];
	}

	// Notify components about state changes
	notifyStateChange(key, newValue, oldValue) {
		console.log(`State changed: ${key}`, { from: oldValue, to: newValue });
		document.dispatchEvent(
			new CustomEvent('appStateChange', {
				detail: { key, newValue, oldValue },
			}),
		);
	}

	// Advanced cache management
	setCache(key, value, customTtl = null) {
		if (!APP_CONFIG.cache.enabled) return false;

		const ttl = customTtl || APP_CONFIG.cache.ttl;
		this.cache.set(key, {
			data: value,
			timestamp: Date.now(),
			ttl: ttl,
		});

		// Auto cleanup old entries
		this.cleanupCache();
		return true;
	}

	getCache(key) {
		if (!APP_CONFIG.cache.enabled) return null;

		const cached = this.cache.get(key);
		if (!cached) return null;

		// Check if expired
		if (Date.now() - cached.timestamp > cached.ttl) {
			this.cache.delete(key);
			return null;
		}

		return cached.data;
	}

	cleanupCache() {
		if (this.cache.size <= APP_CONFIG.cache.maxSize) return;

		// Remove oldest entries
		const entries = Array.from(this.cache.entries());
		const sortedByAge = entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

		const toRemove = sortedByAge.slice(0, this.cache.size - APP_CONFIG.cache.maxSize);
		toRemove.forEach(([key]) => this.cache.delete(key));

		console.log(`Cache cleanup: removed ${toRemove.length} old entries`);
	}

	// Clear all cache
	clearCache() {
		this.cache.clear();
		console.log('Cache cleared');
	}
}

// Global application state
const appState = new ApplicationState();
