/* ========================================================================
   IPTV Player - User Interface Management
   ======================================================================== */

// User Interface Management
export const UIManager = {
	setCountrySelect() {
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

		// Not: Select2 arama input'u için built-in placeholder ayarı yok.
		// Input, dropdown açıldığında oluşturulduğu için burada set edilir.
		$countrySelect.on('select2:open', () => {
			const $search = $('.select2-container--open .select2-search__field');
			$search.attr('placeholder', 'Type to search for a country...');
			// İsteğe bağlı:
			$search.attr({ 'aria-label': 'Search country', inputmode: 'search' }).trigger('focus');
		});
	},

	formatCountryOption(state) {
		if (!state.id) return state.text;

		const flag0 = $(state.element).data('flag0');
		const flag1 = $(state.element).data('flag1');
		const flag2 = $(state.element).data('flag2');

		const flagPic = `<picture>
	<source srcset="${flag2}" type="image/svg+xml">
  <source srcset="${flag1}" type="image/svg+xml">
  <img src="${flag0}" alt="Ülkenin bayrağı" class="flag-img">
</picture>`;
		return $(`<span>${flagPic}${state.text}</span>`);
	},

	// Populate country select dropdown
	populateCountrySelect(countries) {
		try {
			const $countrySelect = $('#countrySelect');
			$countrySelect.empty();

			// Add CSS for flag support if not already added

			countries.forEach((country) => {
				if (country.disabled) return;

				// Use emoji directly in the text for better compatibility
				const option = new Option(`${country.name} (${country.code})`, country.code);
				option.setAttribute('data-flag0', country.imgs[0]);
				option.setAttribute('data-flag1', country.imgs[1]);
				option.setAttribute('data-flag2', country.imgs[2]);
				$countrySelect.append(option);

				// Add CSS class for styling
				option.className = 'country-option';
				$countrySelect.append(option);
			});

			console.log(`Populated country select with ${countries.length} countries`);
		} catch (error) {
			console.error(error, 'Populating country select');
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
			}
		} catch (error) {
			console.error(error, 'Populating channel list');
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
			console.error(error, 'Filtering channels');
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
			console.error(error, ErrorManager.ERROR_TYPES.UI, 'Updating channel info');
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
			console.error(error, 'Showing channel loading');
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
	},
};
