import { appConfig } from './AppConfig.js';
import { loadChannel } from './ChannelLoader.js';

class CountrySelect {
	defaultCountry = 'us';
	currentCountry = '';
	prevCountry = '';
	constructor() {}
	async readyInit() {
		await CountryPromise;
		this.#initializeomponent();
		this.#loadData(AppConfig.getInstance().countries);
		$('#countrySelect').on('change', this.handleCountryChange);
	}

	async handleCountryChange(event, data) {
		const selectedCountry = $(event.target).val();
		const random = data?.random === true;
		const channels = loadChannel(selectedCountry, random);
		//	UIManager.populateChannelList(channels);
		//	UIManager.enableChannelSearch();
	}

	async loadDefault() {
		await loadChannel(this.default);
	}

	#formatCountryOption(state) {
		if (!state.id) return state.text;

		const flag0 = $(state.element).data('flag0');
		const flag1 = $(state.element).data('flag1');
		const flag2 = $(state.element).data('flag2');

		const flagPic = `<picture><source srcset="${flag2}" type="image/svg+xml"><source srcset="${flag1}" type="image/svg+xml"><img src="${flag0}" alt="Ülkenin bayrağı" class="flag-img"></picture>`;
		return $(`<span>${flagPic}${state.text}</span>`);
	}

	#initializeomponent() {
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
				noResults: () => 'No country found'
			},
			templateResult: this.#formatCountryOption,
			templateSelection: this.#formatCountryOption,
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
			}
		});

		// Arama input placeholder (Select2 v4 için built-in yok)
		$countrySelect.on('select2:open', () => {
			const $search = $('.select2-container--open .select2-search__field');
			$search.attr('placeholder', 'Type to search for a country...');
			$search.attr({ 'aria-label': 'Search country', inputmode: 'search' }).trigger('focus');
		});
	}

	#loadData(countries) {
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
}

export const countrySelect = new CountrySelect();
