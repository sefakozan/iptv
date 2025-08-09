/* ========================================================================
   IPTV Player - User Interface Management (Static Class)
   ======================================================================== */

// biome-ignore lint/complexity/noStaticOnlyClass: <all static>
export class UIManager {
	// Ülke seçimi (Select2) kurulum

	// Load channels for specific country

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
