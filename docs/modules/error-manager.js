/* ========================================================================
   IPTV Player - Error Management System
   ======================================================================== */

// Error Management System
const ErrorManager = {
	// Error types
	ERROR_TYPES: {
		NETWORK: 'network',
		PARSING: 'parsing',
		VALIDATION: 'validation',
		PLAYBACK: 'playback',
		UI: 'ui',
	},

	// Handle different types of errors
	handle(error, type = 'general', context = '', showUser = false) {
		const errorInfo = {
			type,
			context,
			message: Utils.formatError(error),
			timestamp: new Date().toISOString(),
			userAgent: navigator.userAgent,
			url: window.location.href,
		};

		// Log to console
		console.error(`[${type.toUpperCase()}] ${context}:`, error);

		// Show user notification if requested
		if (showUser) {
			SettingsManager.showToast('error', 'Error Message', errorInfo.message);
		}

		// Report to analytics/monitoring service
		this.reportError(errorInfo);

		return errorInfo;
	},

	reportError(errorInfo) {
		// Placeholder for error reporting service integration
		// Could integrate with services like Sentry, LogRocket, etc.
		if (window.gtag) {
			window.gtag('event', 'exception', {
				description: errorInfo.message,
				fatal: false,
			});
		}
	},
};
