export class AppConfig {
	/** @type {AppConfig|null} */
	static #instance = null;

	config = Object.freeze({
		serviceWorkerPath: 'pwa-service-worker.js',
		// 'https://sefakozan.github.io/iptv/s/'
		playlistUri: 's/',
		playlistFallbackUrl1: 'https://raw.githubusercontent.com/iptv-org/iptv/refs/heads/gh-pages/countries/',
		flagUrl: 'https://twemoji.maxcdn.com/v/14.0.2/svg/',
		flagFallbackUrl1: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/',
		flagFallbackUrl2: 'https://abs-0.twimg.com/emoji/v2/svg/',
		countriesUri: './data/countries.json',
	});

	countries = [
		{
			name: 'Turkey',
			code: 'TR',
			languages: ['tur'],
			flag: '🇹🇷',
			sort: ['ATV', 'Habertürk'],
			imgs: [''],
		},
		{
			name: 'United States',
			code: 'US',
			languages: ['eng', 'spa'],
			flag: '🇺🇸',
			alternatives: ['USA'],
			default: true,
			sort: ['CNN', 'NBC'],
			imgs: [''],
		},
	];

	/**
	 * @private Use AppConfig.getInstance() instead
	 */
	constructor() {
		if (AppConfig.#instance) {
			throw new Error('AppConfig is a singleton. Use AppConfig.getInstance()');
		}
	}

	/**
	 * Get singleton instance
	 * @returns {AppConfig}
	 */
	static getInstance() {
		if (!AppConfig.#instance) {
			AppConfig.#instance = new AppConfig();
			window.iptv_ac = AppConfig.#instance;
		}
		return AppConfig.#instance;
	}

	async initialize() {
		try {
			const response = await fetch(this.config.countriesUri, {
				signal: AbortSignal.timeout(15000),
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			this.countries = await response.json();
		} catch {
			const response = await fetch(this.config.countriesUri, {
				signal: AbortSignal.timeout(15000),
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			this.countries = await response.json();
		}

		for (const country of this.countries) {
			country.imgs = [];

			const codePoints = Array.from(country.flag)
				.map((char) => char.codePointAt(0).toString(16))
				.join('-');

			country.imgs.push(`${this.config.flagUrl}${codePoints}.svg`);
			country.imgs.push(`${this.config.flagFallbackUrl1}${codePoints}.svg`);
			country.imgs.push(`${this.config.flagFallbackUrl2}${codePoints}.svg`);
		}
	}

	getBrowserSupport() {
		const BrowserSupport = {
			IptvUtil: IptvUtil !== undefined,
			hasHLS: Hls ? Hls.version : false,
			hasServiceWorker: 'serviceWorker' in navigator,
			hasLocalStorage: (() => {
				try {
					localStorage.setItem('test', 'test');
					localStorage.removeItem('test');
					return true;
				} catch {
					return false;
				}
			})(),
			isMobile: /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
			bootstrap: bootstrap ? bootstrap.Modal.VERSION : false,
			jquery: $ ? $.fn.jquery : false,
			isDarkMode: window?.matchMedia('(prefers-color-scheme: dark)').matches,
			isTouchDevice: 'ontouchstart' in window || navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0,
			isWebAssemblySupported: typeof WebAssembly?.instantiate === 'function',
			isAppInstalled: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone || document.referrer.includes('android-app://'),
		};
		return BrowserSupport;
	}
}

export const CountryPromise = AppConfig.getInstance().initialize();
