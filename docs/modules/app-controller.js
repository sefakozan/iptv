/* ========================================================================
   IPTV Player - Main Application Controller
   ======================================================================== */

// Main Application Controller
const IPTVApp = {
	// Application initialization
	async initialize() {
		try {
			console.log('Initializing IPTV Player...');

			// Show loading state
			UIManager.showLoading();

			// Initialize managers
			this.initializeManagers();

			// Load application data
			await this.loadApplicationData();

			// Initialize UI
			this.initializeUI();

			// Initialize event handlers
			EventHandlers.initializeEventHandlers();

			// Initialize PWA features
			this.initializePWA();

			// Hide loading state
			UIManager.hideLoading();

			console.log('IPTV Player initialized successfully');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.CRITICAL, 'Application initialization', true);
			UIManager.hideLoading();
		}
	},

	// Initialize all managers
	initializeManagers() {
		// Initialize video manager
		VideoManager.initialize();

		// Initialize keyboard manager
		KeyboardManager.initialize();

		console.log('Managers initialized');
	},

	// Load all required application data
	async loadApplicationData() {
		try {
			// Load countries data
			const countriesSuccess = await DataManager.loadCountries();
			if (!countriesSuccess) {
				throw new Error('Failed to load countries data');
			}

			console.log('Application data loaded successfully');
		} catch (error) {
			throw new Error(`Failed to load application data: ${error.message}`);
		}
	},

	// Initialize UI components
	initializeUI() {
		try {
			// Populate country select
			const countries = appState.getState('countries');
			UIManager.populateCountrySelect(countries);

			// Populate settings dropdown
			SettingsManager.populateDefaultCountrySelect(countries);

			// Update PWA status in modal
			SettingsManager.updateModalStatus();

			// Load default settings and apply them
			SettingsManager.loadDefaultSettings();

			// Apply saved volume settings
			this.applySavedAudioSettings();

			console.log('UI initialized');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'UI initialization');
		}
	},

	// Initialize PWA features
	initializePWA() {
		try {
			// Initialize automatic updates
			SettingsManager.initializeAutoUpdate();

			// Register service worker message handler
			this.registerServiceWorkerHandler();

			console.log('PWA features initialized');
		} catch (error) {
			console.warn('PWA initialization failed:', error);
		}
	},

	// Register service worker message handler
	registerServiceWorkerHandler() {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.addEventListener('message', (event) => {
				const { type, payload } = event.data;

				switch (type) {
					case 'UPDATE_AVAILABLE':
						SettingsManager.handleAvailableUpdate(payload.registration);
						break;
					case 'UPDATE_APPLIED':
						SettingsManager.showToast('success', 'Update Applied', 'Application updated successfully!');
						break;
					default:
						console.log('Unknown service worker message:', type);
				}
			});
		}
	},

	// Apply saved audio settings
	applySavedAudioSettings() {
		try {
			const settings = SettingsManager.getSettings();
			const video = document.getElementById('videoPlayer');

			if (video && settings.rememberVolume) {
				if (typeof settings.volume === 'number') {
					video.volume = Math.max(0, Math.min(1, settings.volume));
				}
				if (typeof settings.muted === 'boolean') {
					video.muted = settings.muted;
				}
			}

			// Apply autoplay muted setting
			if (video && settings.autoplayMuted !== false) {
				video.muted = true;
			}

			console.log('Audio settings applied');
		} catch (error) {
			console.warn('Failed to apply audio settings:', error);
		}
	},

	// Application cleanup
	cleanup() {
		try {
			console.log('Cleaning up application...');

			// Stop auto-update checking
			SettingsManager.stopAutoUpdate();

			// Clean up video manager
			VideoManager.cleanup();

			// Clean up keyboard manager
			KeyboardManager.cleanup();

			// Clean up event handlers
			EventHandlers.cleanup();

			console.log('Application cleanup completed');
		} catch (error) {
			console.warn('Cleanup failed:', error);
		}
	},

	// Restart application
	async restart() {
		try {
			console.log('Restarting application...');

			// Clean up current instance
			this.cleanup();

			// Wait a moment
			await Utils.sleep(100);

			// Re-initialize
			await this.initialize();

			console.log('Application restarted successfully');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.CRITICAL, 'Application restart', true);
		}
	},

	// Get application status
	getStatus() {
		return {
			initialized: appState.getState('initialized') || false,
			countriesLoaded: appState.getState('countries')?.length > 0,
			channelsLoaded: appState.getState('channels')?.length > 0,
			currentCountry: appState.getState('currentCountry'),
			currentChannel: appState.getState('currentChannel'),
			videoPlayerReady: VideoManager.isReady(),
			errors: ErrorManager.getErrorHistory(),
		};
	},
};

// Application Entry Point
$(document).ready(async () => {
	try {
		// Initialize the application
		await IPTVApp.initialize();

		// Mark as initialized
		appState.setState('initialized', true);

		// Global error handler for unhandled promises
		window.addEventListener('unhandledrejection', (event) => {
			console.error('Unhandled promise rejection:', event.reason);
			ErrorManager.handle(new Error(event.reason), ErrorManager.ERROR_TYPES.CRITICAL, 'Unhandled promise rejection');
			event.preventDefault();
		});

		// Global error handler
		window.addEventListener('error', (event) => {
			console.error('Global error:', event.error);
			ErrorManager.handle(event.error, ErrorManager.ERROR_TYPES.CRITICAL, 'Global error');
		});

		// Handle page visibility changes
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				console.log('App became hidden');
			} else {
				console.log('App became visible');
				// Check for updates when app becomes visible
				setTimeout(() => SettingsManager.checkForPWAUpdates(), 1000);
			}
		});

		// Cleanup on page unload
		window.addEventListener('beforeunload', () => {
			IPTVApp.cleanup();
		});

		console.log('IPTV Player application started successfully');
	} catch (error) {
		console.error('Application startup failed:', error);
		ErrorManager.handle(error, ErrorManager.ERROR_TYPES.CRITICAL, 'Application startup', true);
	}
});
