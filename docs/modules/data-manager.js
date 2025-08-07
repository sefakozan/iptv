/* ========================================================================
   IPTV Player - Data Management System
   ======================================================================== */

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

			const response = await fetch('./countries.json');
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
				const primaryUrl = `${APP_CONFIG.api.countryPlaylistUrl}${countryCode}.m3u`;
				const fallbackUrl = `${APP_CONFIG.api.countryPlaylistFallbackUrl}${countryCode}.m3u`;

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
