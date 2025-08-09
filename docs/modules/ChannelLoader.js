import { appConfig } from './AppConfig.js';

class ChannelLoader {
	CountryCache = new Map();

	async load(countryCode, randomSort = false) {
		let channels = [];

		if (this.CountryCache.has(countryCode)) {
			channels = this.CountryCache.get(countryCode);
			if (randomSort) {
				return this.#shuffle([...channels]);
			}
		}

		const _playlistUri = appConfig.config.playlistUri;
		const _playlistFallbackUrl1 = appConfig.config.playlistFallbackUrl1;

		const primaryUrl = `${_playlistUri}${countryCode}.m3u`;
		const fallbackUrl = `${_playlistFallbackUrl1}${countryCode}.m3u`;

		let response = await fetch(primaryUrl, { method: 'HEAD' }).catch(() => '');
		if (!response?.ok) {
			response = await fetch(fallbackUrl, { method: 'HEAD' });

			if (!response.ok) {
				throw new Error(`Both primary and fallback URLs failed for ${countryCode}`);
			}
		}

		const m3uContent = await response.text();
		channels = parseM3U(m3uContent);
		this.CountryCache.set(countryCode, channels);

		if (randomSort) {
			return shuffle([...channels]);
		}
		return channels;
	}

	#shuffle(deck) {
		for (let i = deck.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[deck[i], deck[j]] = [deck[j], deck[i]];
		}
		return deck;
	}

	// Parse M3U playlist format
	parseM3U(m3uContent) {
		try {
			const channels = [];

			// Use IptvUtil if available, otherwise fallback to simple parsing
			if (typeof IptvUtil !== 'undefined' && IptvUtil.parser) {
				const playlist = IptvUtil.parser(m3uContent);

				for (const item of playlist.links) {
					if (!this.isValidChannelUrl(item.url)) continue;

					if (item.title?.trim()) {
						channels.push({
							id: Utils.generateId(),
							name: item.title.trim(),
							url: item.url,
							logo: item?.extinf?.['tvg-logo'] || ''
						});
					}
				}
			} else {
				// Fallback simple M3U parsing
				const lines = m3uContent.split('\n');

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i].trim();

					if (line.startsWith('#EXTINF:')) {
						const nextLine = lines[i + 1]?.trim();

						if (nextLine && isValidChannelUrl(nextLine)) {
							const titleMatch = line.match(/,(.+)$/);
							const logoMatch = line.match(/tvg-logo="([^"]+)"/);

							if (titleMatch?.[1]?.trim()) {
								channels.push({
									id: Utils.generateId(),
									name: titleMatch[1].trim(),
									url: nextLine,
									logo: logoMatch?.[1] || ''
								});
							}
						}
					}
				}
			}

			console.log(`Parsed ${channels.length} valid channels from M3U`);
			return channels;
		} catch (error) {
			console.error(error, 'Parsing M3U content');
			return [];
		}
	}

	// Validate channel URL
	isValidChannelUrl(url) {
		if (!url || typeof url !== 'string') return false;
		if (!url.includes('.m3u8')) return false;
		if (url.startsWith('http:')) return false; // Prefer HTTPS

		try {
			new URL(string);
			return true;
		} catch {
			return false;
		}
	}
}

export const channelLoader = new ChannelLoader();
