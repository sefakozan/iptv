/* ========================================================================
   IPTV Player - User Interface Management
   ======================================================================== */

// User Interface Management
const UIManager = {
	// Populate country select dropdown
	populateCountrySelect(countries) {
		try {
			const $countrySelect = $('#countrySelect');
			$countrySelect.empty().append('<option value="">🌍 Select a country</option>');

			// Add CSS for flag support if not already added

			countries.forEach((country) => {
				if (country.disabled) return;

				const code = country.code.toLowerCase();
				const flagEmoji = country.flag || '🏴';
				const flagUri = this.generateFlagUrl(flagEmoji);

				// Use emoji directly in the text for better compatibility
				const option = new Option(`${country.name} (${country.code})`, code);
				option.setAttribute('flag', flagUri);
				$countrySelect.append(option);

				// Add CSS class for styling
				option.className = 'country-option';
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

			// Convert emoji to unicode codepoints
			const codePoints = Array.from(flagEmoji)
				.map((char) => char.codePointAt(0).toString(16).toLowerCase())
				.join('-');

			// Try multiple CDN sources
			const flagSources = [
				`${APP_CONFIG.api.flagUrl}${codePoints}.svg`,
				`${APP_CONFIG.api.flagFallbackUrl1}${codePoints}.svg`,
				`${APP_CONFIG.api.flagFallbackUrl2}${codePoints}.svg`
			];

			// Return the first source for now (we can add error handling later)
			return flagSources[0];
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
						'padding-left': '40px'
					});
				}

				$channelList.append(option);
			});

			console.log(`Populated channel list with ${channels.length} channels`);

			// Auto-select first channel if not first load
			if (!appState.isFirstLoad && channels.length > 0) {
				$channelList.val('0').trigger('change');
			}
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Populating channel list');
		}
	},

	// Populate channel select dropdown (alias for populateChannelList)
	populateChannelSelect(channels) {
		return this.populateChannelList(channels);
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
			}, APP_CONFIG.ui.searchDelay)
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
						'padding-left': '40px'
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

	// Application Loading States
	showLoading(message = 'Loading IPTV Player...') {
		try {
			// Create loading overlay if it doesn't exist
			if ($('#loadingOverlay').length === 0) {
				const loadingHtml = `
					<div id="loadingOverlay" class="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center" 
						 style="background: rgba(13, 17, 23, 0.95); z-index: 9999; backdrop-filter: blur(4px);">
						<div class="text-center text-light">
							<div class="spinner-border mb-3" role="status" style="width: 3rem; height: 3rem;">
								<span class="visually-hidden">Loading...</span>
							</div>
							<h4 class="mb-2">IPTV Player</h4>
							<p id="loadingMessage" class="mb-0 text-muted">${Utils.sanitizeHtml(message)}</p>
							<div class="progress mt-3" style="width: 300px; height: 6px;">
								<div class="progress-bar progress-bar-striped progress-bar-animated bg-primary" 
									 role="progressbar" style="width: 100%" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100">
								</div>
							</div>
						</div>
					</div>
				`;
				$('body').append(loadingHtml);
			}

			// Update message
			$('#loadingMessage').text(message);
			$('#loadingOverlay').fadeIn(300);

			console.log('Loading overlay shown:', message);
		} catch (error) {
			console.warn('Failed to show loading overlay:', error);
		}
	},

	// Hide loading overlay
	hideLoading() {
		try {
			$('#loadingOverlay').fadeOut(300, function () {
				$(this).remove();
			});
			console.log('Loading overlay hidden');
		} catch (error) {
			console.warn('Failed to hide loading overlay:', error);
		}
	},

	// Update loading message
	updateLoadingMessage(message) {
		try {
			$('#loadingMessage').text(message);
		} catch (error) {
			console.warn('Failed to update loading message:', error);
		}
	},

	// Show channel loading state
	showChannelLoading(message = 'Loading channels...') {
		try {
			$('#channelList')
				.empty()
				.append(`<option value="">${Utils.sanitizeHtml(message)}</option>`)
				.prop('disabled', true);

			$('#channelSearch').prop('disabled', true).val('');
			this.updateChannelInfo(message);

			console.log('Channel loading shown:', message);
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Showing channel loading');
		}
	},

	// Toggle info panel (if implemented)
	toggleInfoPanel() {
		try {
			const $infoPanel = $('#infoPanel');
			if ($infoPanel.length > 0) {
				$infoPanel.toggleClass('d-none');
			}
		} catch (error) {
			console.warn('Failed to toggle info panel:', error);
		}
	}
};
