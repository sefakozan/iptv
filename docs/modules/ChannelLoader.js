import { appConfig } from './AppConfig.js';

/**
 * ChannelLoader
 * - Fetches and parses country-based M3U playlists
 * - Caches results per country
 */
class ChannelLoader {
	CountryCache = new Map();

	/**
	 * Load playlist for a country
	 * @param {string} countryCode ISO country code (any case)
	 * @param {boolean} [randomSort=false] return shuffled copy
	 * @returns {Promise<Array<{id:string,name:string,url:string,logo?:string}>>}
	 */
	async load(countryCode, randomSort = false) {
		const code = String(countryCode || '')
			.trim()
			.toUpperCase();
		if (!code) throw new Error('ChannelLoader.load: countryCode is required');

		// Return from cache fast
		if (this.CountryCache.has(code)) {
			const cached = this.CountryCache.get(code) || [];
			return randomSort ? this.#shuffle([...cached]) : cached;
		}

		// Build URLs via AppConfig (handles lowercasing and bases)
		const urls = appConfig.getPlaylistUrl(code);
		if (!urls) throw new Error(`Unknown country code: ${code}`);

		const m3uContent = await this.#fetchTextWithFallback(urls.primary, urls.fallback);
		const channels = this.parseM3U(m3uContent);
		this.CountryCache.set(code, channels);
		return randomSort ? this.#shuffle([...channels]) : channels;
	}

	/** Fisher–Yates shuffle */
	#shuffle(deck) {
		for (let i = deck.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[deck[i], deck[j]] = [deck[j], deck[i]];
		}
		return deck;
	}

	/** Fetch text from primary, fall back to secondary, with timeout and cache mode */
	async #fetchTextWithFallback(primary, fallback) {
		const { fetchTimeoutMs, fetchCacheMode, cacheBust } = appConfig.getConfig();
		const controller = new AbortController();
		const to = setTimeout(() => controller.abort('timeout'), Math.max(1, Number(fetchTimeoutMs) || 15000));
		const doFetch = async (url) => {
			const finalUrl = cacheBust ? `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}` : url;
			const res = await fetch(finalUrl, {
				method: 'GET',
				cache: fetchCacheMode || 'no-store',
				headers: { Accept: 'text/plain' },
				signal: controller.signal
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		};
		try {
			try {
				return await doFetch(primary);
			} catch {
				return await doFetch(fallback);
			}
		} finally {
			clearTimeout(to);
		}
	}

	// Parse M3U playlist format
	parseM3U(m3uContent) {
		try {
			const channels = [];
			const IptvUtil = globalThis.IptvUtil;
			const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

			const playlist = IptvUtil.parser(m3uContent);
			for (const item of playlist.links || []) {
				if (!this.isValidChannelUrl(item?.url)) continue;
				const title = item?.title?.trim();
				if (title) {
					channels.push({
						id: genId(),
						name: title,
						url: item.url,
						logo: item?.extinf?.['tvg-logo'] || ''
					});
				}
			}

			console.log(`ChannelLoader: parsed ${channels.length} channels`);
			return channels;
		} catch (error) {
			console.error('ChannelLoader.parseM3U error:', error);
			return [];
		}
	}

	// Validate channel URL
	isValidChannelUrl(url) {
		if (!url || typeof url !== 'string') return false;
		if (!url.includes('.m3u8')) return false;
		if (url.startsWith('http:')) return false; // Prefer HTTPS
		try {
			new URL(url);
			return true;
		} catch {
			return false;
		}
	}
}

export const channelLoader = new ChannelLoader();
