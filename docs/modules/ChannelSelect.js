import { appConfig } from './AppConfig.js';
import { channelLoader } from './ChannelLoader.js';
import { eventManager } from './EventManager.js';

/** Country select controller: wires Select2, loads options, and reacts to selection. */
class ChannelSelect {
	#currentChannels = [];

	/** Initialize component once countries are ready */
	async readyInit() {}

	async handleChannelChange(event, data) {}

	#formatChannelOption(state) {}

	#initializeComponent() {}

	async load(countryCode, isRandomSort) {
		this.#currentChannels = await channelLoader.load(countryCode, isRandomSort);
		this.#populate(this.#currentChannels);
		this.#enableChannelSearch();
	}

	#populate(channels) {
		try {
			this.#currentChannels = channels;
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

			$channelList.val('0').trigger('change');

			// TODO
			// // Auto-select first channel if not first load
			// if (!appState.isFirstLoad && channels.length > 0) {
			// 	$channelList.val('0').trigger('change');
			// } else if (appState.isFirstLoad) {
			// 	appState.isFirstLoad = false;
			// }
		} catch (error) {
			console.error(error, 'Populating channel list');
		}
	}

	#enableChannelSearch() {
		const $channelSearch = $('#channelSearch');

		// Remove existing handlers to prevent duplicates
		$channelSearch.off('input.channelSearch');

		// Add debounced search handler
		$channelSearch.on('input.channelSearch', (event) => {
			this.#filterChannels(event.target.value);
		});
	}

	// Filter channels based on search term
	#filterChannels(searchTerm) {
		try {
			const query = searchTerm.toLowerCase().trim();
			const $channelList = $('#channelList');

			$channelList.empty();

			if (!query) {
				// Show all channels if no search term
				this.populate(this.#currentChannels);
				return;
			}

			const filteredChannels = this.#currentChannels.filter((channel) => channel.name.toLowerCase().includes(query));

			if (filteredChannels.length === 0) {
				$channelList.append('<option value="">No channels found</option>');
				// TODO
				VideoManager.stopPlayback();
				this.updateChannelInfo('No channel selected');
				return;
			}

			// Populate with filtered channels
			filteredChannels.forEach((channel) => {
				const originalIndex = this.#currentChannels.indexOf(channel);
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
			console.error(error, 'Filtering channels');
		}
	}
}

export const channelSelect = new ChannelSelect();
