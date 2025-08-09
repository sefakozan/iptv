/* ========================================================================
   IPTV Player - User Interface Management (Static Class)
   ======================================================================== */

// biome-ignore lint/complexity/noStaticOnlyClass: <all static>
export class UIManager {
	// Ülke seçimi (Select2) kurulum
	static setCountrySelect() {
		const $countrySelect = $('#countrySelect');

		// sorter içinde kullanmak için son arama terimi
		let lastTerm = '';

		$countrySelect.select2({
			placeholder: 'Select a country',
			allowClear: false,
			width: '100%',
			language: {
				searching: () => 'Type to search for a country...',
				inputTooShort: () => 'Type to search for a country...',
				noResults: () => 'No country found',
			},
			templateResult: UIManager.formatCountryOption,
			templateSelection: UIManager.formatCountryOption,
			escapeMarkup: (markup) => markup,

			// 0–2 karakter: ad + kod içinde ara
			// 3+ karakter: sadece ad içinde ara
			matcher: (params, data) => {
				const term = $.trim(params.term || '').toLowerCase();
				lastTerm = term;

				if (!term) return data;
				if (typeof data.text === 'undefined') return null;

				const name = (data.text || '').toLowerCase();
				const code = (data.id || '').toLowerCase();

				if (term.length <= 2) {
					return name.includes(term) || code.includes(term) ? data : null;
				}
				return name.includes(term) ? data : null;
			},

			// Öncelik:
			// 1) Tam 2 karakter kod = arama terimi (tam eşleşme) en üstte
			// 2) name startsWith(term)
			// 3) (yalnızca term<=2 iken) code startsWith(term)
			// 4) içerene göre (zaten matcher sağlıyor), eşitlikte orijinal sırayı koru
			sorter: (results) => {
				if (!lastTerm) return results;
				const term = lastTerm;

				const scoreOf = (item) => {
					const name = (item.text || '').toLowerCase();
					const code = (item.id || '').toLowerCase();
					let s = 0;

					if (term.length === 2 && code === term) s += 1000; // tam kod eşleşmesi
					if (name.startsWith(term)) s += 100; // ad başlıyor
					if (term.length <= 2 && code.startsWith(term)) s += 90; // kod başlıyor
					// içerme (başlamıyorsa) küçük ek puan
					if (!name.startsWith(term) && name.includes(term)) s += 10;
					if (term.length <= 2 && !code.startsWith(term) && code.includes(term)) s += 9;

					return s;
				};

				return results
					.map((item, idx) => ({ item, idx, score: scoreOf(item) }))
					.sort((a, b) => b.score - a.score || a.idx - b.idx)
					.map((x) => x.item);
			},
		});

		// Arama input placeholder (Select2 v4 için built-in yok)
		$countrySelect.on('select2:open', () => {
			const $search = $('.select2-container--open .select2-search__field');
			$search.attr('placeholder', 'Type to search for a country...');
			$search.attr({ 'aria-label': 'Search country', inputmode: 'search' }).trigger('focus');
		});
	}

	// Select2 seçenek render’ı (ülke bayrakları + metin)
	static formatCountryOption(state) {
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
	}

	// Ülke listesini doldur
	static populateCountrySelect(countries) {
		try {
			const $countrySelect = $('#countrySelect');
			$countrySelect.empty();

			countries.forEach((country) => {
				if (country.disabled) return;

				const option = new Option(`${country.name} (${country.code})`, country.code);
				option.setAttribute('data-flag0', country.imgs[0]);
				option.setAttribute('data-flag1', country.imgs[1]);
				option.setAttribute('data-flag2', country.imgs[2]);
				option.className = 'country-option';

				$countrySelect.append(option);
			});

			console.log(`Populated country select with ${countries.length} countries`);
		} catch (error) {
			console.error(error, 'Populating country select');
		}
	}

	// Kanal listesini doldur
	static populateChannelList(channels) {
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

			// İlk yükleme değilse ilk kanalı seç
			if (!appState.isFirstLoad && channels.length > 0) {
				$channelList.val('0').trigger('change');
			}
		} catch (error) {
			console.error(error, 'Populating channel list');
		}
	}

	// Alias
	static populateChannelSelect(channels) {
		return UIManager.populateChannelList(channels);
	}

	// Arama etkinleştir
	static enableChannelSearch() {
		const $channelSearch = $('#channelSearch');

		// Çoğul bağlamayı engelle
		$channelSearch.off('input.channelSearch');

		$channelSearch.on(
			'input.channelSearch',
			Utils.debounce((event) => {
				UIManager.filterChannels(event.target.value);
			}, APP_CONFIG.ui.searchDelay),
		);
	}

	// Arama filtresi
	static filterChannels(searchTerm) {
		try {
			const query = searchTerm.toLowerCase().trim();
			const channels = appState.getState('channels');
			const $channelList = $('#channelList');

			$channelList.empty();

			if (!query) {
				UIManager.populateChannelList(channels);
				return;
			}

			const filteredChannels = channels.filter((channel) => channel.name.toLowerCase().includes(query));

			if (filteredChannels.length === 0) {
				$channelList.append('<option value="">No channels found</option>');
				VideoManager.stopPlayback();
				UIManager.updateChannelInfo('No channel selected');
				return;
			}

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

			// İlk sonucu otomatik seç
			if (filteredChannels.length > 0) {
				const firstOption = $channelList.find('option:first');
				$channelList.val(firstOption.val()).trigger('change');
			}
		} catch (error) {
			console.error(error, 'Filtering channels');
		}
	}

	// Kanal bilgi panelini güncelle
	static updateChannelInfo(message, channel = null) {
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
	}

	// Hata durumu
	static showChannelError(message) {
		$('#channelList')
			.empty()
			.append(`<option value="">${Utils.sanitizeHtml(message)}</option>`)
			.prop('disabled', true);

		$('#channelSearch').prop('disabled', true).val('');
		UIManager.updateChannelInfo(message);
	}

	// Yükleniyor durumu
	static showChannelLoading(message = 'Loading channels...') {
		try {
			$('#channelList')
				.empty()
				.append(`<option value="">${Utils.sanitizeHtml(message)}</option>`)
				.prop('disabled', true);

			$('#channelSearch').prop('disabled', true).val('');
			UIManager.updateChannelInfo(message);

			console.log('Channel loading shown:', message);
		} catch (error) {
			console.error(error, 'Showing channel loading');
		}
	}

	// Info panel toggle
	static toggleInfoPanel() {
		try {
			const $infoPanel = $('#infoPanel');
			if ($infoPanel.length > 0) {
				$infoPanel.toggleClass('d-none');
			}
		} catch (error) {
			console.warn('Failed to toggle info panel:', error);
		}
	}
}
