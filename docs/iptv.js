// Copilot do not change this region
const AppData = {
	serviceWorkerPath: 'pwa-service-worker.js',
	// 'https://sefakozan.github.io/iptv/s/'
	playlistUri: 's/',
	playlistFallbackUrl1: 'https://raw.githubusercontent.com/iptv-org/iptv/refs/heads/gh-pages/countries/',
	flagUrl: 'https://twemoji.maxcdn.com/v/14.0.2/svg/',
	flagFallbackUrl1: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/',
	flagFallbackUrl2: 'https://abs-0.twimg.com/emoji/v2/svg/',
	countriesUri: 'countries.json',
	cachePlayList: true,
	defaultVolume: 0.8,
	autoplay: true,
};

const AppState = {
	currentCountry: null,
	currentChannel: null,
	channels: [],
	favorites: [],
	isLoading: false,
	videoPlayer: null,
	hlsInstance: null,
	registration: await navigator.serviceWorker.register(AppData.serviceWorkerPath),
	isFirstLoad: true,
	cache: new Map(),
	cachePlayList: true,
};

async function _loadCountries() {
	const response = await fetch(AppData.countriesUri, {
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	return await response.json();
}

export const AppUtil = {
	// Show toast message
	showNotification(type, title, message) {
		console.log(`[${type.toUpperCase()}] ${title}: ${message}`);
		// Use Bootstrap toast if available
		const toastHtml = `
				<div class="toast" role="alert">
					<div class="toast-header">
						<strong class="me-auto">${title}</strong>
						<button type="button" class="btn-close" data-bs-dismiss="toast"></button>
					</div>
					<div class="toast-body">${message}</div>
				</div>
			`;
	},
	// Validate URL
	isValidUrl(string) {
		try {
			new URL(string);
			return true;
		} catch {
			return false;
		}
	},
};

// Global error handler
const ErrorHandler = {
	handle(error, context = 'Unknown', showUser = false) {
		const errorMessage = Utils.formatError(error);
		console.error(`[ERROR] ${context}:`, error);

		if (showUser) {
			Utils.showToast('error', 'Error', errorMessage);
		}

		return {
			context,
			message: errorMessage,
			timestamp: new Date().toISOString(),
		};
	},
};

// Early browser feature detection

console.log(BrowserSupport);
// Event Manager
// country cahange
// channel change
// new version installed
// app installed
// favorites changed
// end region
