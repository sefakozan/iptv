/* ========================================================================
   IPTV Player - Keyboard Navigation System
   ======================================================================== */

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
