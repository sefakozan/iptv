/* ========================================================================
   IPTV Player - Event Handlers
   ======================================================================== */

// Event Handlers
const EventHandlers = {
	// Initialize all event handlers
	initializeEventHandlers() {
		this.initializeCountrySelectHandlers();
		this.initializeChannelSelectHandlers();
		this.initializeVideoHandlers();
		this.initializeKeyboardHandlers();
		this.initializeModalHandlers();
		this.initializePWAHandlers();
		this.initializeSettingsHandlers();
		this.initializeSearchHandlers();
		this.initializeGenericHandlers();

		console.log('Event handlers initialized');
	},

	// Country select handlers
	initializeCountrySelectHandlers() {
		$('#countrySelect').on('change', async function () {
			const selectedCountry = $(this).val();
			console.log('Country selected:', selectedCountry);

			if (!selectedCountry) return;

			try {
				// Show channel loading
				UIManager.showChannelLoading();

				// Load channels for selected country
				const success = await DataManager.loadChannelsForCountry(selectedCountry);

				if (success) {
					const channels = appState.getState('channels');
					if (channels && channels.length > 0) {
						// Populate channel dropdown
						UIManager.populateChannelSelect(channels);
						// Auto-select first channel
						$('#channelList').val(0).trigger('change');
					}
				}
			} catch (error) {
				ErrorManager.handle(error, ErrorManager.ERROR_TYPES.NETWORK, 'Loading channels for country');
			}
		});
	},

	// Channel select handlers
	initializeChannelSelectHandlers() {
		$('#channelList').on('change', function () {
			const selectedChannel = $(this).val();
			console.log('Channel selected:', selectedChannel);

			if (!selectedChannel) {
				VideoManager.clearVideo();
				return;
			}

			try {
				// Load and play the selected channel
				VideoManager.loadChannel(selectedChannel);
			} catch (error) {
				ErrorManager.handle(error, ErrorManager.ERROR_TYPES.PLAYBACK, 'Loading selected channel');
			}
		});
	},

	// Video player event handlers
	initializeVideoHandlers() {
		const video = document.getElementById('videoPlayer');

		if (video) {
			// Video events
			video.addEventListener('loadstart', () => {
				console.log('Video load started');
				UIManager.showLoadingSpinner();
			});

			video.addEventListener('canplay', () => {
				console.log('Video can play');
				UIManager.hideLoadingSpinner();
			});

			video.addEventListener('playing', () => {
				console.log('Video playing');
				UIManager.hideLoadingSpinner();
			});

			video.addEventListener('error', (e) => {
				console.error('Video error:', e);
				ErrorManager.handle(new Error('Video playback error'), ErrorManager.ERROR_TYPES.PLAYBACK, 'Video player error', true);
			});

			video.addEventListener('volumechange', () => {
				const settings = SettingsManager.getSettings();
				if (settings.rememberVolume) {
					SettingsManager.saveSettings({
						volume: video.volume,
						muted: video.muted,
					});
				}
			});
		}
	},

	// Keyboard event handlers
	initializeKeyboardHandlers() {
		$(document).on('keydown', (e) => {
			KeyboardManager.handleKeyPress(e);
		});
	},

	// Modal event handlers
	initializeModalHandlers() {
		// Settings modal events
		$('#settingsModal').on('show.bs.modal', () => {
			SettingsManager.showSettingsModal();
		});

		$('#settingsModal').on('hide.bs.modal', () => {
			SettingsManager.hideSettingsModal();
		});

		// Save settings button
		$('#saveSettingsBtn').on('click', () => {
			SettingsManager.saveCurrentSettings();
		});

		// Reset settings button
		$('#resetSettingsBtn').on('click', () => {
			if (confirm('Are you sure you want to reset all settings to defaults?')) {
				SettingsManager.resetToDefaults();
			}
		});
	},

	// PWA installation handlers
	initializePWAHandlers() {
		// Header install button
		$('#headerInstallBtn').on('click', () => {
			SettingsManager.installPWA();
		});

		// Modal install button
		$('#installAppBtn').on('click', () => {
			SettingsManager.installPWA();
		});

		// Update service worker button
		$('#updateSwBtn').on('click', () => {
			SettingsManager.updateServiceWorker();
		});

		// Listen for PWA installation prompt
		window.addEventListener('beforeinstallprompt', (e) => {
			console.log('PWA install prompt available');
			e.preventDefault();
			window.deferredPrompt = e;
			// Update modal status to show install button
			SettingsManager.updateModalStatus();
		});

		// Listen for PWA installation completion
		window.addEventListener('appinstalled', () => {
			console.log('PWA installed successfully');
			window.deferredPrompt = null;
			SettingsManager.showToast('success', 'Installation Complete', 'IPTV Player has been installed successfully!');
			// Update modal status
			setTimeout(() => SettingsManager.updateModalStatus(), 1000);
		});
	},

	// Settings form handlers
	initializeSettingsHandlers() {
		// Auto-save settings when changed
		$('#defaultCountrySelect, #autoplayMuted, #rememberVolume').on('change', () => {
			SettingsManager.saveCurrentSettings();
		});
	},

	// Search functionality handlers
	initializeSearchHandlers() {
		// Global search functionality (if implemented)
		$('#searchInput').on(
			'input',
			Utils.debounce((e) => {
				const searchTerm = e.target.value.toLowerCase().trim();
				this.performSearch(searchTerm);
			}, 300),
		);

		$('#searchInput').on('keypress', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const searchTerm = e.target.value.toLowerCase().trim();
				this.performSearch(searchTerm);
			}
		});
	},

	// Generic UI handlers
	initializeGenericHandlers() {
		// Fullscreen toggle
		$('#fullscreenBtn').on('click', () => {
			VideoManager.toggleFullscreen();
		});

		// Volume controls (if implemented)
		$('#muteBtn').on('click', () => {
			VideoManager.toggleMute();
		});

		// Info panel toggle
		$('#infoBtn').on('click', () => {
			UIManager.toggleInfoPanel();
		});

		// Prevent context menu on video
		$('#videoPlayer').on('contextmenu', (e) => {
			e.preventDefault();
		});

		// Window resize handler
		$(window).on(
			'resize',
			Utils.debounce(() => {
				VideoManager.handleResize();
			}, 250),
		);

		// Handle browser navigation
		$(window).on('beforeunload', () => {
			VideoManager.cleanup();
		});
	},

	// Search functionality
	performSearch(searchTerm) {
		try {
			if (!searchTerm) {
				// Reset to show all channels
				const channels = appState.getState('channels');
				UIManager.populateChannelSelect(channels);
				return;
			}

			const channels = appState.getState('channels');
			if (!channels || channels.length === 0) return;

			// Filter channels based on search term
			const filteredChannels = channels.filter((channel) => channel.text.toLowerCase().includes(searchTerm) || (channel.group && channel.group.toLowerCase().includes(searchTerm)));

			// Update channel dropdown with filtered results
			UIManager.populateChannelSelect(filteredChannels);

			// Auto-select first result if available
			if (filteredChannels.length > 0) {
				$('#channelList').val(0).trigger('change');
			}

			console.log(`Search for "${searchTerm}" returned ${filteredChannels.length} results`);
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Performing search');
		}
	},

	// Clean up event handlers
	cleanup() {
		$(document).off('keydown');
		$(window).off('resize beforeunload');
		$('#countrySelect, #channelList').off('change');
		console.log('Event handlers cleaned up');
	},
};
