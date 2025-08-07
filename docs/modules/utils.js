/* ========================================================================
   IPTV Player - Utility Functions
   ======================================================================== */

// Utility Functions Module
const Utils = {
	// Debounce function for performance
	debounce(func, wait) {
		let timeout;
		return function executedFunction(...args) {
			const later = () => {
				clearTimeout(timeout);
				func.apply(this, args);
			};
			clearTimeout(timeout);
			timeout = setTimeout(later, wait);
		};
	},

	// Throttle function for performance
	throttle(func, limit) {
		let inThrottle;
		return function executedFunction(...args) {
			if (!inThrottle) {
				func.apply(this, args);
				inThrottle = true;
				setTimeout(() => {
					inThrottle = false;
				}, limit);
			}
		};
	},

	// Generate unique IDs
	generateId() {
		return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	},

	// Safe DOM manipulation
	safeQuerySelector(selector) {
		try {
			return document.querySelector(selector);
		} catch (error) {
			console.warn(`Invalid selector: ${selector}`, error);
			return null;
		}
	},

	// Validate URL
	isValidUrl(string) {
		try {
			new URL(string);
			return true;
		} catch {
			return false;
		}
	},

	// Format errors for user display
	formatError(error, context = '') {
		const message = error?.message || error?.toString() || 'Unknown error occurred';
		return context ? `${context}: ${message}` : message;
	},

	// Deep clone object
	deepClone(obj) {
		try {
			return JSON.parse(JSON.stringify(obj));
		} catch {
			return obj;
		}
	},

	// Sanitize HTML content
	sanitizeHtml(str) {
		const div = document.createElement('div');
		div.textContent = str;
		return div.innerHTML;
	},
};
