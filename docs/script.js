/* ========================================================================
   IPTV Player - Modern JavaScript Application
   ======================================================================== */

// Application Configuration
const APP_CONFIG = {
	cache: {
		enabled: true,
		maxSize: 100,
		ttl: 600000, // 10 minutes
	},
	video: {
		autoplay: true,
		defaultVolume: 0.8,
	},
	ui: {
		animationDuration: 300,
		searchDelay: 200,
		loadingDelay: 100,
	},
	api: {
		baseUrl: 'https://sefakozan.github.io/iptv/s/',
		fallbackUrl: 'https://raw.githubusercontent.com/iptv-org/iptv/refs/heads/gh-pages/countries/',
		flagUrl: 'https://abs-0.twimg.com/emoji/v2/svg/',
	},
};

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

// Select2 Management
const Select2Manager = {
	// Initialize Select2 component
	initialize() {
		try {
			const $countrySelect = $('#countrySelect');

			$countrySelect.select2({
				placeholder: 'Select a country',
				allowClear: false,
				width: '100%',
				language: {
					searching: () => 'Type to search for a country...',
					inputTooShort: () => 'Type to search for a country...',
					noResults: () => 'No country found',
				},
				templateResult: this.formatCountryOption,
				templateSelection: this.formatCountryOption,
				escapeMarkup: (markup) => markup, // Allow HTML content
			});

			// Set search placeholder when dropdown opens
			$countrySelect.on('select2:open', () => {
				setTimeout(() => {
					const searchBox = Utils.safeQuerySelector('.select2-search__field');
					if (searchBox) {
						searchBox.placeholder = 'Type to search for a country...';
					}
				}, 0);
			});

			console.log('Select2 initialized successfully');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Select2 initialization', true);
		}
	},

	// Format country options with flags
	formatCountryOption(state) {
		if (!state.id) return state.text;

		const flagUrl = $(state.element).data('flag');
		if (!flagUrl) return state.text;

		const flagImg = `<img src="${flagUrl}" 
                             style="width: 2rem; height: auto; aspect-ratio: 4/3; 
                                    vertical-align: middle; margin-right: 0.5rem; 
                                    border-radius: 0.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);" 
                             alt="Flag" 
                             onerror="this.style.display='none'" />`;

		return $(`<span>${flagImg}${Utils.sanitizeHtml(state.text)}</span>`);
	},
};

// Data Management System
const DataManager = {
	// Load countries data
	async loadCountries() {
		try {
			console.log('Loading countries data...');
			appState.setState('isLoading', true);

			const response = await fetch('countries.json');
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const countries = await response.json();

			// Validate data structure
			if (!Array.isArray(countries)) {
				throw new Error('Invalid countries data format');
			}

			appState.setState('countries', countries);
			console.log(`Successfully loaded ${countries.length} countries`);

			// Update UI
			UIManager.populateCountrySelect(countries);
			SettingsManager.populateDefaultCountrySelect(countries);

			// Load default settings
			await SettingsManager.loadDefaultSettings();

			return countries;
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.NETWORK, 'Loading countries', true);
			throw error;
		} finally {
			appState.setState('isLoading', false);
		}
	},

	// Load channels for specific country
	async loadChannelsForCountry(countryCode, randomSort = false) {
		try {
			console.log(`Loading channels for country: ${countryCode}`);
			appState.setState('isLoading', true);

			// Check cache first
			const cacheKey = `channels_${countryCode}`;
			let channels = appState.getCache(cacheKey);

			if (channels) {
				console.log(`Using cached channels for ${countryCode}: ${channels.length}`);
			} else {
				// Fetch from primary or fallback URL
				const primaryUrl = `${APP_CONFIG.api.baseUrl}${countryCode}.m3u`;
				const fallbackUrl = `${APP_CONFIG.api.fallbackUrl}${countryCode}.m3u`;

				let m3uUrl = primaryUrl;
				let response = await fetch(primaryUrl, { method: 'HEAD' });

				if (!response.ok) {
					console.log('Primary URL failed, trying fallback...');
					m3uUrl = fallbackUrl;
					response = await fetch(fallbackUrl, { method: 'HEAD' });

					if (!response.ok) {
						throw new Error(`Both primary and fallback URLs failed for ${countryCode}`);
					}
				}

				// Fetch M3U content
				const fullResponse = await fetch(m3uUrl);
				if (!fullResponse.ok) {
					throw new Error(`Failed to fetch M3U: ${fullResponse.status}`);
				}

				const m3uContent = await fullResponse.text();
				channels = this.parseM3U(m3uContent);

				// Cache the results
				appState.setCache(cacheKey, channels);
				console.log(`Loaded and cached ${channels.length} channels for ${countryCode}`);
			}

			// Apply random sorting if requested
			if (randomSort) {
				channels = [...channels].sort(() => Math.random() - 0.5);
				console.log('Applied random sorting to channels');
			}

			appState.setState('channels', channels);
			appState.setState('currentCountry', countryCode);

			// Update UI
			UIManager.populateChannelList(channels);
			UIManager.enableChannelSearch();

			return channels;
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.NETWORK, `Loading channels for ${countryCode}`, true);
			UIManager.showChannelError('Failed to load channels');
			throw error;
		} finally {
			appState.setState('isLoading', false);
		}
	},

	// Parse M3U playlist format
	parseM3U(m3uContent) {
		try {
			const channels = [];

			// Use IptvUtil if available, otherwise fallback to simple parsing
			if (typeof IptvUtil !== 'undefined' && IptvUtil.parser) {
				const playlist = IptvUtil.parser(m3uContent);

				for (const item of playlist.links) {
					if (!this.isValidChannelUrl(item.url)) continue;

					if (item.title?.trim()) {
						channels.push({
							id: Utils.generateId(),
							name: item.title.trim(),
							url: item.url,
							logo: item?.extinf?.['tvg-logo'] || '',
						});
					}
				}
			} else {
				// Fallback simple M3U parsing
				const lines = m3uContent.split('\n');

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i].trim();

					if (line.startsWith('#EXTINF:')) {
						const nextLine = lines[i + 1]?.trim();

						if (nextLine && this.isValidChannelUrl(nextLine)) {
							const titleMatch = line.match(/,(.+)$/);
							const logoMatch = line.match(/tvg-logo="([^"]+)"/);

							if (titleMatch?.[1]?.trim()) {
								channels.push({
									id: Utils.generateId(),
									name: titleMatch[1].trim(),
									url: nextLine,
									logo: logoMatch?.[1] || '',
								});
							}
						}
					}
				}
			}

			console.log(`Parsed ${channels.length} valid channels from M3U`);
			return channels;
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.PARSING, 'Parsing M3U content');
			return [];
		}
	},

	// Validate channel URL
	isValidChannelUrl(url) {
		if (!url || typeof url !== 'string') return false;
		if (!url.includes('.m3u8')) return false;
		if (url.startsWith('http:')) return false; // Prefer HTTPS
		return Utils.isValidUrl(url);
	},
};

// User Interface Management
const UIManager = {
	// Populate country select dropdown
	populateCountrySelect(countries) {
		try {
			const $countrySelect = $('#countrySelect');
			$countrySelect.empty().append('<option value="">Select a country</option>');

			countries.forEach((country) => {
				if (country.disabled) return;

				const code = country.code.toLowerCase();
				const flagUrl = this.generateFlagUrl(country.flag);

				const option = new Option(`${country.name} (${country.code})`, code);
				option.setAttribute('data-flag', flagUrl);
				$countrySelect.append(option);
			});

			console.log(`Populated country select with ${countries.length} countries`);
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Populating country select');
		}
	},

	// Generate flag URL from emoji
	generateFlagUrl(flagEmoji) {
		try {
			if (!flagEmoji) return '';

			const codePoints = Array.from(flagEmoji)
				.map((char) => char.codePointAt(0).toString(16))
				.join('-');

			return `${APP_CONFIG.api.flagUrl}${codePoints}.svg`;
		} catch (error) {
			console.warn('Failed to generate flag URL:', error);
			return '';
		}
	},

	// Populate channel list
	populateChannelList(channels) {
		try {
			const $channelList = $('#channelList');
			const $channelSearch = $('#channelSearch');

			$channelList.empty().prop('disabled', false);
			$channelSearch.prop('disabled', false).val('');

			if (channels.length === 0) {
				$channelList.append('<option value="">No channels found</option>');
				return;
			}

			channels.forEach((channel, index) => {
				const option = new Option(channel.name, index.toString());

				if (channel.logo) {
					$(option).css({
						'background-image': `url(${channel.logo})`,
						'background-repeat': 'no-repeat',
						'background-position': '8px center',
						'background-size': '24px 24px',
						'padding-left': '40px',
					});
				}

				$channelList.append(option);
			});

			console.log(`Populated channel list with ${channels.length} channels`);

			// Auto-select first channel if not first load
			if (!appState.isFirstLoad && channels.length > 0) {
				$channelList.val('0').trigger('change');
			} else if (appState.isFirstLoad) {
				appState.isFirstLoad = false;
			}
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Populating channel list');
		}
	},

	// Enable channel search functionality
	enableChannelSearch() {
		const $channelSearch = $('#channelSearch');

		// Remove existing handlers to prevent duplicates
		$channelSearch.off('input.channelSearch');

		// Add debounced search handler
		$channelSearch.on(
			'input.channelSearch',
			Utils.debounce((event) => {
				this.filterChannels(event.target.value);
			}, APP_CONFIG.ui.searchDelay),
		);
	},

	// Filter channels based on search term
	filterChannels(searchTerm) {
		try {
			const query = searchTerm.toLowerCase().trim();
			const channels = appState.getState('channels');
			const $channelList = $('#channelList');

			$channelList.empty();

			if (!query) {
				// Show all channels if no search term
				this.populateChannelList(channels);
				return;
			}

			const filteredChannels = channels.filter((channel) => channel.name.toLowerCase().includes(query));

			if (filteredChannels.length === 0) {
				$channelList.append('<option value="">No channels found</option>');
				VideoManager.stopPlayback();
				this.updateChannelInfo('No channel selected');
				return;
			}

			// Populate with filtered channels
			filteredChannels.forEach((channel) => {
				const originalIndex = channels.indexOf(channel);
				const option = new Option(channel.name, originalIndex.toString());

				if (channel.logo) {
					$(option).css({
						'background-image': `url(${channel.logo})`,
						'background-repeat': 'no-repeat',
						'background-position': '8px center',
						'background-size': '24px 24px',
						'padding-left': '40px',
					});
				}

				$channelList.append(option);
			});

			// Auto-select first filtered result
			if (filteredChannels.length > 0) {
				const firstOption = $channelList.find('option:first');
				$channelList.val(firstOption.val()).trigger('change');
			}
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Filtering channels');
		}
	},

	// Update channel information display
	updateChannelInfo(message, channel = null) {
		try {
			const $channelInfo = $('#channelInfo');

			if (!channel) {
				$channelInfo.html(`<p class="mb-0">${Utils.sanitizeHtml(message)}</p>`);
				return;
			}

			const logoHtml = channel.logo
				? `<img src="${channel.logo}" 
                     alt="Logo" 
                     style="max-height:38px; max-width:60px; object-fit:contain; 
                            filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5)); 
                            background:#23272f; border-radius:0.3rem; flex-shrink:0;" 
                     onerror="this.style.display='none'">`
				: '';

			$channelInfo.html(`
                <div style="display:flex; align-items:center; gap:1rem; min-height:40px;">
                    ${logoHtml}
                    <div style="flex:1 1 0; min-width:0;">
                        <div style="font-weight:600; font-size:1.1rem;">${Utils.sanitizeHtml(channel.name)}</div>
                        <div class="url-clip" 
                             title="${Utils.sanitizeHtml(channel.url)}" 
                             style="color:#8fd3ff; font-size:0.98rem; word-break:break-all;">
                            ${Utils.sanitizeHtml(channel.url)}
                        </div>
                    </div>
                </div>
            `);
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Updating channel info');
		}
	},

	// Show channel loading/error states
	showChannelError(message) {
		$('#channelList')
			.empty()
			.append(`<option value="">${Utils.sanitizeHtml(message)}</option>`)
			.prop('disabled', true);

		$('#channelSearch').prop('disabled', true).val('');
		this.updateChannelInfo(message);
	},
};

// Video Player Management
const VideoManager = {
	// Play selected channel
	async playChannel(channelIndex) {
		try {
			const channels = appState.getState('channels');
			const channel = channels[parseInt(channelIndex)];

			if (!channel) {
				throw new Error('Invalid channel index');
			}

			console.log(`Playing channel: ${channel.name}`);
			appState.setState('currentChannel', channel);

			// Update UI first
			UIManager.updateChannelInfo('Loading channel...', channel);

			// Stop any existing playback
			this.stopPlayback();

			const video = document.getElementById('videoPlayer');
			if (!video) {
				throw new Error('Video player element not found');
			}

			// Setup HLS playback
			if (Hls.isSupported()) {
				appState.hls = new Hls({
					enableWorker: true,
					lowLatencyMode: true,
					backBufferLength: 90,
				});

				appState.hls.loadSource(channel.url);
				appState.hls.attachMedia(video);

				// Handle HLS events
				appState.hls.on(Hls.Events.MANIFEST_PARSED, () => {
					video.play().catch((error) => {
						console.warn('Autoplay failed:', error);
					});
				});

				appState.hls.on(Hls.Events.ERROR, (_, data) => {
					ErrorManager.handle(new Error(`HLS Error: ${data.type} - ${data.details}`), ErrorManager.ERROR_TYPES.PLAYBACK, `Playing ${channel.name}`);
				});
			} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
				// Safari native HLS support
				video.src = channel.url;
				video.addEventListener(
					'loadedmetadata',
					() => {
						video.play().catch((error) => {
							console.warn('Autoplay failed:', error);
						});
					},
					{ once: true },
				);
			} else {
				throw new Error('HLS playback not supported in this browser');
			}

			// Update channel info after successful setup
			UIManager.updateChannelInfo('Now playing', channel);
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.PLAYBACK, 'Playing channel', true);
			UIManager.updateChannelInfo('Failed to play channel');
		}
	},

	// Stop current playback
	stopPlayback() {
		try {
			const video = document.getElementById('videoPlayer');

			if (appState.hls) {
				appState.hls.destroy();
				appState.hls = null;
			}

			if (video) {
				video.pause();
				video.src = '';
				video.load();
			}

			console.log('Playback stopped');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.PLAYBACK, 'Stopping playback');
		}
	},
};

// Keyboard Navigation System
const KeyboardManager = {
	// Initialize keyboard event handlers
	initialize() {
		$(document).on('keydown.iptvKeyboard', (event) => {
			this.handleKeyPress(event);
		});

		console.log('Keyboard navigation initialized');
	},

	// Handle keyboard events
	handleKeyPress(event) {
		try {
			const { key } = event;

			switch (key) {
				case 'Tab':
					event.preventDefault();
					this.selectRandomCountry();
					break;

				case 'ArrowLeft':
				case 'ArrowRight':
					if (appState.getState('countries').length > 0) {
						event.preventDefault();
						this.navigateCountries(key === 'ArrowRight');
					}
					break;

				case 'ArrowUp':
				case 'ArrowDown':
					if (appState.getState('channels').length > 0) {
						event.preventDefault();
						this.navigateChannels(key === 'ArrowDown');
					}
					break;

				case 'Escape':
					VideoManager.stopPlayback();
					break;

				case ' ': // Spacebar
					event.preventDefault();
					this.togglePlayPause();
					break;
			}
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Keyboard navigation');
		}
	},

	// Select random country
	selectRandomCountry() {
		const $countrySelect = $('#countrySelect');
		const options = $countrySelect.find('option').not(':first');

		if (options.length === 0) return;

		const randomIndex = Math.floor(Math.random() * options.length);
		const randomOption = options.eq(randomIndex);

		$countrySelect.val(randomOption.val()).trigger('change', [{ random: true }]);
		console.log('🎲 Random country selected via Tab key');
	},

	// Navigate between countries
	navigateCountries(forward = true) {
		const $countrySelect = $('#countrySelect');
		const currentValue = $countrySelect.val();
		const options = $countrySelect.find('option').not(':first');

		let currentIndex = -1;
		options.each(function (index) {
			if ($(this).val() === currentValue) {
				currentIndex = index;
				return false;
			}
		});

		let newIndex;
		if (forward) {
			newIndex = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
		} else {
			newIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
		}

		const newOption = options.eq(newIndex);
		$countrySelect.val(newOption.val()).trigger('change');
	},

	// Navigate between channels
	navigateChannels(forward = true) {
		const $channelList = $('#channelList');
		const options = $channelList.find('option').filter(function () {
			return $(this).val() !== '';
		});

		if (options.length === 0) return;

		const currentValue = $channelList.val();
		let currentIndex = -1;

		options.each(function (index) {
			if ($(this).val() === currentValue) {
				currentIndex = index;
				return false;
			}
		});

		let newIndex;
		if (forward) {
			newIndex = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
		} else {
			newIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
		}

		const newValue = options.eq(newIndex).val();
		$channelList.val(newValue).trigger('change');
	},

	// Toggle play/pause
	togglePlayPause() {
		const video = document.getElementById('videoPlayer');
		if (!video) return;

		if (video.paused) {
			video.play().catch((error) => {
				console.warn('Play failed:', error);
			});
		} else {
			video.pause();
		}
	},
};

// Settings Management
const SettingsManager = {
	// Storage key for settings
	STORAGE_KEY: 'iptvPlayerSettings',

	// Get all settings
	getSettings() {
		try {
			const stored = localStorage.getItem(this.STORAGE_KEY);
			return stored ? JSON.parse(stored) : {};
		} catch (error) {
			console.warn('Failed to load settings:', error);
			return {};
		}
	},

	// Save settings
	saveSettings(settings) {
		try {
			const currentSettings = this.getSettings();
			const updatedSettings = { ...currentSettings, ...settings };
			localStorage.setItem(this.STORAGE_KEY, JSON.stringify(updatedSettings));
			console.log('Settings saved:', updatedSettings);
			return true;
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.VALIDATION, 'Saving settings', true);
			return false;
		}
	},

	// Show settings modal (now modal)
	showSettingsModal() {
		// Update PWA status information
		this.updateModalStatus();
		// Bootstrap modal will handle the show
	},

	// Hide settings modal (now modal)
	hideSettingsModal() {
		// Bootstrap modal will handle the hide
	},

	// Update modal status information
	updateModalStatus() {
		try {
			// Check installation status
			const isInstalled = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone || document.referrer.includes('android-app://');

			const $installStatus = $('#installStatus');
			const $installBtn = $('#installAppBtn');

			if (isInstalled) {
				$installStatus.removeClass('bg-secondary bg-warning').addClass('bg-success').html('<i class="fas fa-check me-1"></i>Installed');
				$installBtn.addClass('d-none');
			} else {
				$installStatus.removeClass('bg-success bg-warning').addClass('bg-secondary').html('<i class="fas fa-download me-1"></i>Not Installed');
				// Show install button if PWA installation is available
				// TODO  burasi ne yapiyor
				if (window.deferredPrompt || window.BeforeInstallPromptEvent) {
					$installBtn.removeClass('d-none');
				}
			}

			// Check Service Worker status
			const $swStatus = $('#swStatus');
			const $updateBtn = $('#updateSwBtn');

			if ('serviceWorker' in navigator) {
				navigator.serviceWorker.getRegistrations().then((registrations) => {
					if (registrations.length > 0) {
						const registration = registrations[0];

						// Check if there's an update available
						if (registration.waiting) {
							$swStatus.removeClass('bg-secondary bg-success').addClass('bg-warning').html('<i class="fas fa-exclamation me-1"></i>Update Available');
							$updateBtn.removeClass('d-none');
						} else {
							$swStatus.removeClass('bg-secondary bg-warning').addClass('bg-success').html('<i class="fas fa-check me-1"></i>Active');
							$updateBtn.addClass('d-none');
						}
					} else {
						$swStatus.removeClass('bg-success bg-warning').addClass('bg-warning').html('<i class="fas fa-exclamation me-1"></i>Not Active');
						$updateBtn.addClass('d-none');
					}
				});
			} else {
				$swStatus.removeClass('bg-success bg-warning').addClass('bg-secondary').html('<i class="fas fa-times me-1"></i>Not Supported');
				$updateBtn.addClass('d-none');
			}

			// Update last updated time
			const lastUpdate = new Date().toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'long',
				day: 'numeric',
			});
			$('#lastUpdated').text(lastUpdate);

			// Update header install button
			this.updateHeaderInstallButton(isInstalled);
		} catch (error) {
			console.warn('Error updating modal status:', error);
		}
	},

	// Update header install button based on installation status
	updateHeaderInstallButton(isInstalled) {
		try {
			const $headerInstallBtn = $('#headerInstallBtn');
			const $btnIcon = $headerInstallBtn.find('i');
			const $btnText = $headerInstallBtn.find('.btn-text');

			if (isInstalled) {
				// App is installed - show version
				$btnIcon.removeClass('fas fa-download').addClass('fas fa-check-circle');
				$btnText.text('v2.1.3');
				$headerInstallBtn.removeClass('btn-outline-light').addClass('btn-outline-success');
				$headerInstallBtn.prop('disabled', true);
				$headerInstallBtn.attr('title', 'App is installed');
			} else {
				// App is not installed - show install button
				$btnIcon.removeClass('fas fa-check-circle').addClass('fas fa-download');
				$btnText.text('Install App');
				$headerInstallBtn.removeClass('btn-outline-success').addClass('btn-outline-light');
				$headerInstallBtn.prop('disabled', false);
				$headerInstallBtn.attr('title', 'Install IPTV Player as PWA');

				// Show button only if installation is available
				if (window.deferredPrompt || window.BeforeInstallPromptEvent) {
					$headerInstallBtn.show();
				} else {
					$headerInstallBtn.hide();
				}
			}
		} catch (error) {
			console.warn('Error updating header install button:', error);
		}
	},

	// Handle PWA installation
	installPWA() {
		if (window.deferredPrompt) {
			window.deferredPrompt.prompt();
			window.deferredPrompt.userChoice.then((choiceResult) => {
				if (choiceResult.outcome === 'accepted') {
					console.log('PWA installation accepted');
					this.showToast('success', 'Installation Started', 'IPTV Player is being installed...');
					// Update status after installation
					setTimeout(() => this.updateModalStatus(), 1000);
				} else {
					this.showToast('info', 'Installation Cancelled', 'You can install the app later from browser menu.');
				}
				window.deferredPrompt = null;
			});
		} else {
			// Show manual installation instructions
			this.showToast(
				'info',
				'Manual Installation',
				`To install IPTV Player manually:<br>
				1. Click browser menu (⋮)<br>
				2. Select "Install App" or "Add to Home Screen"<br>
				3. Follow the installation prompts`,
				8000,
			);
		}
	},

	// Handle Service Worker update
	updateServiceWorker() {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.getRegistrations().then((registrations) => {
				if (registrations.length > 0) {
					const registration = registrations[0];
					if (registration.waiting) {
						// Tell the waiting SW to skip waiting
						registration.waiting.postMessage({ type: 'SKIP_WAITING' });

						// Show update message
						this.showToast('success', 'App Updated!', 'App updated successfully! Changes will be applied on next reload.', 5000);

						// Refresh page after a delay
						setTimeout(() => window.location.reload(), 2000);
					} else {
						// Force update check
						registration.update().then(() => {
							this.updateModalStatus();
						});
					}
				}
			});
		}
	},

	// Create and show Bootstrap toast
	showToast(type = 'info', title = '', message = '', delay = 5000, actions = null) {
		const toastId = `toast-${Date.now()}`;

		// Toast type classes
		const typeClasses = {
			success: 'bg-success text-white',
			error: 'bg-danger text-white',
			warning: 'bg-warning text-dark',
			info: 'bg-info text-white',
			primary: 'bg-primary text-white',
		};

		// Toast icons
		const typeIcons = {
			success: 'fas fa-check-circle',
			error: 'fas fa-exclamation-triangle',
			warning: 'fas fa-exclamation-circle',
			info: 'fas fa-info-circle',
			primary: 'fas fa-bell',
		};

		const closeButtonClass = type === 'warning' ? 'btn-close' : 'btn-close btn-close-white';

		let actionsHtml = '';
		const actionHandlers = {};
		if (actions && actions.length > 0) {
			actionsHtml = `
				<div class="mt-2 pt-2 border-top">
					${actions
						.map((action, index) => {
							const actionId = `${toastId}-action-${index}`;
							if (action.action && typeof action.action === 'function') {
								actionHandlers[actionId] = action.action;
							}
							return `
						<button type="button" class="btn btn-sm ${action.class || 'btn-outline-light'} me-2" 
								id="${actionId}">${action.text}</button>
					`;
						})
						.join('')}
				</div>
			`;
		}

		const toastHtml = `
			<div id="${toastId}" class="toast align-items-center ${typeClasses[type] || typeClasses.info} border-0 position-fixed" 
				 style="top: 20px; right: 20px; z-index: 9999; max-width: 400px; min-width: 300px;" role="alert" aria-live="assertive" aria-atomic="true">
				<div class="d-flex">
					<div class="toast-body">
						<div class="d-flex align-items-start">
							<i class="${typeIcons[type] || typeIcons.info} me-2 mt-1"></i>
							<div class="flex-grow-1">
								${title ? `<strong>${title}</strong><br>` : ''}
								${message}
								${actionsHtml}
							</div>
						</div>
					</div>
					<button type="button" class="${closeButtonClass} me-2 m-auto" 
							data-bs-dismiss="toast" aria-label="Close"></button>
				</div>
			</div>
		`;

		// Remove existing toasts of same type to prevent spam
		$(`.toast.${typeClasses[type].split(' ')[0]}`).each(function () {
			const existingToast = bootstrap.Toast.getInstance(this);
			if (existingToast) {
				existingToast.hide();
			}
		});

		$('body').append(toastHtml);
		const toastElement = document.getElementById(toastId);

		// Add action button event handlers
		Object.keys(actionHandlers).forEach((actionId) => {
			const button = document.getElementById(actionId);
			if (button) {
				button.addEventListener('click', () => {
					actionHandlers[actionId]();
					// Close the toast after action
					const toast = bootstrap.Toast.getInstance(toastElement);
					if (toast) {
						toast.hide();
					}
				});
			}
		});

		const bsToast = new bootstrap.Toast(toastElement, {
			delay: delay,
			autohide: delay > 0,
		});

		bsToast.show();

		// Clean up after hidden
		toastElement.addEventListener('hidden.bs.toast', () => {
			toastElement.remove();
		});

		return bsToast;
	}, // Save current settings from modal UI
	saveCurrentSettings() {
		const defaultCountry = $('#defaultCountrySelect').val();
		const autoplayMuted = $('#autoplayMuted').is(':checked');
		const rememberVolume = $('#rememberVolume').is(':checked');

		const success = this.saveSettings({
			defaultCountry: defaultCountry || null,
			autoplayMuted: autoplayMuted,
			rememberVolume: rememberVolume,
			lastUpdated: Date.now(),
		});

		if (success) {
			this.showToast('success', '', 'Settings saved successfully!');
		}
	},

	// Reset settings to defaults
	resetToDefaults() {
		try {
			localStorage.removeItem(this.STORAGE_KEY);

			// Reset UI
			$('#defaultCountrySelect').val('');
			$('#autoplayMuted').prop('checked', true);
			$('#rememberVolume').prop('checked', false);

			// Show success message
			this.showToast('success', '', 'Settings reset to defaults!');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.STORAGE, 'Resetting settings', true);
		}
	},

	// Populate default country select
	populateDefaultCountrySelect(countries) {
		try {
			const $defaultCountrySelect = $('#defaultCountrySelect');
			const currentSettings = this.getSettings();

			$defaultCountrySelect.empty().append('<option value="">No default (manual selection)</option>');

			countries.forEach((country) => {
				if (country.disabled) return;

				const option = new Option(country.name, country.code.toLowerCase());
				if (currentSettings.defaultCountry === country.code.toLowerCase()) {
					option.selected = true;
				}
				$defaultCountrySelect.append(option);
			});

			// Load audio preferences
			$('#autoplayMuted').prop('checked', currentSettings.autoplayMuted !== false); // Default to true
			$('#rememberVolume').prop('checked', currentSettings.rememberVolume === true); // Default to false

			console.log('Populated default country select and loaded audio preferences');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Populating settings');
		}
	},

	// Load and apply default settings
	async loadDefaultSettings() {
		try {
			const settings = this.getSettings();
			const { defaultCountry } = settings;

			if (!defaultCountry) {
				// Fallback to US if no default
				$('#countrySelect').val('us').trigger('change');
				return;
			}

			// Check if default country exists in current data
			const countries = appState.getState('countries');
			const countryExists = countries.some((country) => country.code.toLowerCase() === defaultCountry.toLowerCase());

			if (countryExists) {
				console.log('Loading default country:', defaultCountry);
				$('#countrySelect').val(defaultCountry).trigger('change');
			} else {
				console.warn('Default country not found, falling back to US');
				$('#countrySelect').val('us').trigger('change');
			}
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.VALIDATION, 'Loading default settings');
			// Fallback to US
			$('#countrySelect').val('us').trigger('change');
		}
	},

	// Initialize automatic PWA update checking
	initializeAutoUpdate() {
		// Check for updates every 30 seconds
		this.updateCheckInterval = setInterval(() => {
			this.checkForPWAUpdates();
		}, 30000);

		// Check immediately when the app becomes visible again
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) {
				setTimeout(() => this.checkForPWAUpdates(), 1000);
			}
		});

		// Initial check after 5 seconds
		setTimeout(() => this.checkForPWAUpdates(), 5000);
	},

	// Check for PWA updates automatically
	async checkForPWAUpdates() {
		try {
			if (!('serviceWorker' in navigator)) return;

			const registration = await navigator.serviceWorker.getRegistration();
			if (!registration) return;

			// Force update check
			await registration.update();

			// Check if there's a waiting service worker
			if (registration.waiting) {
				this.handleAvailableUpdate(registration);
			}

			// Listen for new service worker installing
			registration.addEventListener('updatefound', () => {
				const newWorker = registration.installing;
				if (!newWorker) return;

				newWorker.addEventListener('statechange', () => {
					if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
						this.handleAvailableUpdate(registration);
					}
				});
			});
		} catch (error) {
			console.log('PWA update check failed:', error);
		}
	},

	// Handle available PWA update
	handleAvailableUpdate(registration) {
		// Prevent multiple notifications for the same update
		if (this.updateNotificationShown) return;
		this.updateNotificationShown = true;

		this.showToast('primary', 'Update Available', 'A new version of the app is available!', 0, [
			{
				text: 'Update Now',
				action: () => {
					this.applyPWAUpdate(registration);
				},
			},
			{
				text: 'Later',
				action: () => {
					this.updateNotificationShown = false; // Allow notification again later
				},
			},
		]);
	},

	// Apply PWA update
	async applyPWAUpdate(registration) {
		try {
			if (registration.waiting) {
				// Tell the service worker to skip waiting and become active
				registration.waiting.postMessage({ type: 'SKIP_WAITING' });

				// Listen for the service worker to become active
				navigator.serviceWorker.addEventListener('controllerchange', () => {
					this.showToast('success', 'Update Complete', 'App updated successfully! The new version is now active.', 0, [
						{
							text: 'Reload Page',
							action: () => {
								window.location.reload();
							},
						},
					]);
				});
			}
		} catch (error) {
			console.error('PWA update application failed:', error);
			this.showToast('error', 'Update Failed', 'Update failed. Please refresh the page manually.');
		}
	},

	// Stop automatic update checking (cleanup)
	stopAutoUpdate() {
		if (this.updateCheckInterval) {
			clearInterval(this.updateCheckInterval);
			this.updateCheckInterval = null;
		}
	},
};

// Event Handlers Module
const EventHandlers = {
	// Handle country selection change
	handleCountryChange(event, extraData) {
		try {
			const selectedCountry = $(event.target).val();
			console.log('Country changed to:', selectedCountry);

			const isRandomSelection = extraData?.random === true;
			if (isRandomSelection) {
				console.log('🎲 Random country selection detected');
			}

			if (!selectedCountry) {
				// Reset UI when no country selected
				UIManager.showChannelError('Select a country first');
				VideoManager.stopPlayback();
				return;
			}

			// Load channels for selected country
			DataManager.loadChannelsForCountry(selectedCountry, isRandomSelection);
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Country selection change');
		}
	},

	// Handle channel selection change
	handleChannelChange(event) {
		try {
			const selectedIndex = $(event.target).val();

			if (!selectedIndex || selectedIndex === '') {
				UIManager.updateChannelInfo('No channel selected');
				VideoManager.stopPlayback();
				return;
			}

			// Play selected channel
			VideoManager.playChannel(selectedIndex);
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Channel selection change');
		}
	},
};

// Main Application Controller
const IPTVApp = {
	// Initialize the application
	async initialize() {
		try {
			console.log('🚀 Initializing IPTV Player...');

			// Initialize core components
			Select2Manager.initialize();
			KeyboardManager.initialize();

			// Initialize automatic PWA update checking
			SettingsManager.initializeAutoUpdate();

			// Attach event handlers
			this.attachEventHandlers();

			// Load initial data
			await DataManager.loadCountries();

			console.log('✅ IPTV Player initialized successfully');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Application initialization', true);
		}
	},

	// Attach all event handlers
	attachEventHandlers() {
		try {
			// Country and channel selection
			$('#countrySelect').on('change', EventHandlers.handleCountryChange);
			$('#channelList').on('change', EventHandlers.handleChannelChange);

			// Settings modal
			$('#saveSettingsBtn').on('click', () => SettingsManager.saveCurrentSettings());
			$('#resetSettingsBtn').on('click', () => SettingsManager.resetToDefaults());

			// Modal event handlers
			$('#settingsModal').on('show.bs.modal', () => SettingsManager.showSettingsModal());
			$('#settingsModal').on('hidden.bs.modal', () => SettingsManager.hideSettingsModal());

			// PWA action buttons
			$('#installAppBtn').on('click', () => SettingsManager.installPWA());
			$('#updateSwBtn').on('click', () => SettingsManager.updateServiceWorker());
			$('#headerInstallBtn').on('click', () => SettingsManager.installPWA());

			// Application state change listener
			document.addEventListener('appStateChange', (event) => {
				const { key, newValue } = event.detail;
				console.log(`App state updated: ${key} =`, newValue);
			});

			console.log('Event handlers attached');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Attaching event handlers');
		}
	},

	// Cleanup on page unload
	cleanup() {
		try {
			VideoManager.stopPlayback();
			$(document).off('.iptvKeyboard');
			SettingsManager.stopAutoUpdate();
			appState.clearCache();
			console.log('Application cleanup completed');
		} catch (error) {
			console.error('Cleanup error:', error);
		}
	},
};

// Initialize application when DOM is ready
$(document).ready(() => {
	IPTVApp.initialize();
});

// Cleanup on page unload
$(window).on('beforeunload', () => {
	IPTVApp.cleanup();
});

// Export for debugging (development only)
if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
	window.IPTVDebug = {
		appState,
		Utils,
		ErrorManager,
		DataManager,
		UIManager,
		VideoManager,
		KeyboardManager,
		SettingsManager,
	};
}
