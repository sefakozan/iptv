/* ============================================================================
   AppConfig - Uygulama yapılandırması ve ülke verisi yükleme
   ============================================================================ */

export class AppConfig {
	/** @type {Readonly<{ serviceWorkerPath:string, playlistUri:string, playlistFallbackUrl1:string, flagUrl:string, flagFallbackUrl1:string, flagFallbackUrl2:string, countriesUri:string }>} */
	config = Object.freeze({
		serviceWorkerPath: 'pwa-service-worker.js',
		playlistUri: 's/', // local listeler
		playlistFallbackUrl1: 'https://raw.githubusercontent.com/iptv-org/iptv/refs/heads/gh-pages/countries/',
		flagUrl: 'https://twemoji.maxcdn.com/v/14.0.2/svg/',
		flagFallbackUrl1: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/',
		flagFallbackUrl2: 'https://abs-0.twimg.com/emoji/v2/svg/',
		countriesUri: './data/countries.json',
		fetchTimeoutMs: 15000,
		fetchCacheMode: 'no-store', // @PROD prod’da 'default' yap
		cacheBust: true, // @PROD prod’da false yap
	});

	/** @type {Array<{name:string, code:string, languages?:string[], flag?:string, alternatives?:string[], default?:boolean, sort?:string[], imgs?:string[], disabled?:boolean}>} */
	countries = [
		{
			name: 'Turkey',
			code: 'TR',
			languages: ['tur'],
			flag: '🇹🇷',
			sort: ['ATV', 'Habertürk'],
			imgs: [],
		},
		{
			name: 'United States',
			code: 'US',
			languages: ['eng', 'spa'],
			flag: '🇺🇸',
			alternatives: ['USA'],
			default: true,
			sort: ['CNN', 'NBC'],
			imgs: [],
		},
	];

	#countryMap = new Map(); // CODE -> country
	#initialized = false;
	#initPromise = null;

	isInitialized() {
		return this.#initialized;
	}

	// Idempotent init: tekrar çağrılırsa aynı promise döner
	async initialize() {
		if (this.#initPromise) return this.#initPromise;

		this.#initPromise = (async () => {
			let loaded;
			try {
				loaded = await this.#fetchJsonWithTimeout(this.config.countriesUri, 15000);
			} catch (err) {
				console.warn('AppConfig: countries.json yüklenemedi, fallback veriler kullanılacak.', err);
				loaded = this.countries;
			}

			this.countries = this.#normalizeCountries(Array.isArray(loaded) ? loaded : this.countries);
			this.#rebuildIndex();
			this.#initialized = true;
			return this.countries;
		})();

		return this.#initPromise;
	}

	// Yardımcı: JSON fetch + timeout + cache-bypass
	async #fetchJsonWithTimeout(url, timeoutMs = this.config.fetchTimeoutMs) {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort('timeout'), timeoutMs);
		try {
			const finalUrl = this.config.cacheBust ? `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}` : url;

			const res = await fetch(finalUrl, {
				signal: controller.signal,
				cache: this.config.fetchCacheMode,
				credentials: 'same-origin',
				headers: { Accept: 'application/json' },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
			return await res.json();
		} finally {
			clearTimeout(t);
		}
	}

	// Ülke verilerini normalize et
	#normalizeCountries(countries) {
		const out = [];
		for (const c of countries) {
			if (!c || !c.name) continue;

			const name = String(c.name).trim();
			const code = String(c.code || '')
				.trim()
				.toUpperCase();
			const disabled = Boolean(c.disabled);

			// Flag zorunlu değil; img URL’leri flag’den türetilir (imgs yoksa)
			const flag = typeof c.flag === 'string' ? c.flag : undefined;

			let imgs = Array.isArray(c.imgs) ? c.imgs.filter(Boolean) : [];
			if (imgs.length === 0 && flag) imgs = this.#buildFlagImgs(flag);

			out.push({
				name,
				code,
				disabled,
				languages: Array.isArray(c.languages) ? c.languages : [],
				flag,
				alternatives: Array.isArray(c.alternatives) ? c.alternatives : [],
				default: Boolean(c.default),
				sort: Array.isArray(c.sort) ? c.sort : [],
				imgs,
			});
		}

		// En az bir default yoksa US veya ilkini default yap
		if (!out.some((x) => x.default)) {
			const idxUS = out.findIndex((x) => x.code === 'US');
			if (idxUS >= 0) out[idxUS].default = true;
			else if (out.length > 0) out[0].default = true;
		}

		return out;
	}

	// Flag’dan (emoji) Twemoji URL’leri üret
	#buildFlagImgs(flag) {
		if (!flag || typeof flag !== 'string') return [];
		try {
			const codePoints = Array.from(flag)
				.map((ch) => ch.codePointAt(0).toString(16))
				.join('-');
			return [`${this.config.flagUrl}${codePoints}.svg`, `${this.config.flagFallbackUrl1}${codePoints}.svg`, `${this.config.flagFallbackUrl2}${codePoints}.svg`];
		} catch {
			return [];
		}
	}

	#rebuildIndex() {
		this.#countryMap.clear();
		for (const c of this.countries) {
			this.#countryMap.set(c.code, c);
		}
	}

	// Getter’lar
	getConfig() {
		return this.config;
	}

	getCountries() {
		return this.countries;
	}

	getCountryByCode(code) {
		if (!code) return undefined;
		return this.#countryMap.get(String(code).toUpperCase());
	}

	getDefaultCountry() {
		return this.countries.find((c) => c.default) || this.countries[0];
	}

	// Playlist URL (local + fallback)
	getPlaylistUrl(code) {
		const c = this.getCountryByCode(code);
		if (!c) return undefined;
		const lc = c.code.toLowerCase();
		const primary = `${this.config.playlistUri}${lc}.m3u`;
		const fallback = `${this.config.playlistFallbackUrl1}${lc}.m3u`;
		return { primary, fallback };
	}

	// Tarayıcı özellikleri
	getBrowserSupport() {
		const hasWindow = typeof window !== 'undefined';
		const hasNavigator = typeof navigator !== 'undefined';
		const hasDocument = typeof document !== 'undefined';

		const hasIptvUtil = hasWindow && typeof window.IptvUtil !== 'undefined';

		const hasHlsLib = hasWindow && typeof window.Hls !== 'undefined';
		const hlsVersion = hasHlsLib && window.Hls?.version ? window.Hls.version : false;

		const hasBootstrap = hasWindow && !!window.bootstrap;
		const bootstrapVersion = hasBootstrap && window.bootstrap?.Modal?.VERSION ? window.bootstrap.Modal.VERSION : false;

		const hasJq = hasWindow && typeof window.$ !== 'undefined';
		const jqueryVersion = hasJq ? window.$.fn?.jquery : false;

		let hasLocalStorage = false;
		try {
			if (hasWindow && 'localStorage' in window) {
				localStorage.setItem('test', 'test');
				localStorage.removeItem('test');
				hasLocalStorage = true;
			}
		} catch {
			hasLocalStorage = false;
		}

		const isMobile = hasNavigator && /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
		const isDarkMode = hasWindow && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

		const touchPoints = (hasNavigator && (Number(navigator.maxTouchPoints) || Number(navigator.msMaxTouchPoints))) || 0;
		const isTouchDevice = (hasWindow && 'ontouchstart' in window) || touchPoints > 0;

		const isWasm = typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function';

		const isAppInstalled =
			(hasWindow && window.matchMedia?.('(display-mode: standalone)').matches) ||
			(hasNavigator && navigator.standalone) ||
			(hasDocument && document.referrer?.includes('android-app://'));

		return {
			IptvUtil: hasIptvUtil,
			hasHLS: hlsVersion,
			hasServiceWorker: hasNavigator && 'serviceWorker' in navigator,
			hasLocalStorage,
			isMobile,
			bootstrap: bootstrapVersion,
			jquery: jqueryVersion,
			isDarkMode,
			isTouchDevice,
			isWebAssemblySupported: isWasm,
			isAppInstalled,
		};
	}
}

// Tek örnek + init sözü (geriye dönük alias ile)
export const appConfig = new AppConfig();
await appConfig.initialize();

// Dev: Console/test için global erişim
if (typeof window !== 'undefined') {
	if (!('appConfig' in window)) window.appConfig = appConfig;
}
