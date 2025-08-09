import { appConfig } from './AppConfig.js';
import { channelSelect } from './ChannelSelect.js';
import { countrySelect } from './CountrySelect.js';
import { pwaManager } from './PWAManager.js';
import { stateManager } from './StateManager.js';
import { videoManager } from './VideoManager.js';

//applyState
//volume
//muted

// Application Entry Point
$(document).ready(async () => {
	try {
		await countrySelect.readyInit();
		channelSelect.readyInit();
		videoManager.initialize();

		// UIManager.populateCountrySelect(AppConfig.getInstance().countries);
		// StateManager.getInstance().load();
		// // Initialize the application
		// //await IPTVApp.initialize();

		// Global error handler for unhandled promises
		window.addEventListener('unhandledrejection', (event) => {
			console.error('Unhandled promise rejection:', event.reason);
		});

		// Global error handler
		window.addEventListener('error', (event) => {
			console.error('Global error:', event.error);
		});

		// Handle page visibility changes
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				console.log('App became hidden');
			} else {
				console.log('App became visible, check for update');
				// Check for updates when app becomes visible
				setTimeout(() => PWAManager.getInstance().checkForUpdate(), 1000);
			}
		});

		// Cleanup on page unload
		window.addEventListener('beforeunload', () => {
			StateManager.getInstance().save();
			IPTVApp.cleanup();
		});

		console.log('IPTV Player application started successfully');
	} catch (error) {
		console.error('Application startup failed:', error);
	}
});
