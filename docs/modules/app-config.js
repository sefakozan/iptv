/* ========================================================================
   IPTV Player - Application Configuration
   ======================================================================== */

// Application Configuration
const APP_CONFIG = {
	cache: {
		enabled: true,
		maxSize: 100,
		ttl: 600000, // 10 minutes
	},
	video: {
		autoplay: true,
		defaultVolume: 0.8,
	},
	ui: {
		animationDuration: 300,
		searchDelay: 200,
		loadingDelay: 100,
	},
	api: {
		countryPlaylistUrl: 'https://sefakozan.github.io/iptv/s/',
		countryPlaylistFallbackUrl: 'https://raw.githubusercontent.com/iptv-org/iptv/refs/heads/gh-pages/countries/',
		flagUrl: 'https://twemoji.maxcdn.com/v/14.0.2/svg/',
		flagFallbackUrl1: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/',
		flagFallbackUrl2: 'https://abs-0.twimg.com/emoji/v2/svg/',

		// https://twemoji.maxcdn.com/v/14.0.2/svg/1f1fa-1f1f8.svg
		// https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f1fa-1f1f8.svg
		// https://abs-0.twimg.com/emoji/v2/svg/1f1fa-1f1f8.svg
	},
};
