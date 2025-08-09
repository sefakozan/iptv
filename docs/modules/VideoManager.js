/* ========================================================================
   IPTV Player - Video Player Management
   ======================================================================== */

// Video Player Management
const VideoManager = {
	// Video player state
	isInitialized: false,
	currentHls: null,

	// Initialize video manager
	initialize() {
		try {
			console.log('Initializing Video Manager...');

			const video = document.getElementById('videoPlayer');
			if (!video) {
				throw new Error('Video player element not found');
			}

			// Set up video element properties
			this.setupVideoElement(video);

			// Add video event listeners
			this.setupVideoEventListeners(video);

			// Check HLS support
			this.checkHLSSupport();

			this.isInitialized = true;
			console.log('Video Manager initialized successfully');
		} catch (error) {
			console.error('Video Manager initialization failed:', error);
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.CRITICAL, 'Video Manager initialization');
		}
	},

	// Setup video element properties
	setupVideoElement(video) {
		try {
			// Set default properties
			video.controls = true;
			video.preload = 'metadata';
			video.crossOrigin = 'anonymous';

			// Apply saved settings
			const settings = SettingsManager.getSettings();
			if (settings.autoplayMuted !== false) {
				video.muted = true;
			}

			if (settings.rememberVolume && typeof settings.volume === 'number') {
				video.volume = Math.max(0, Math.min(1, settings.volume));
			}

			if (typeof settings.muted === 'boolean') {
				video.muted = settings.muted;
			}

			console.log('Video element configured');
		} catch (error) {
			console.warn('Failed to setup video element:', error);
		}
	},

	// Setup video event listeners
	setupVideoEventListeners(video) {
		try {
			// Loading events
			video.addEventListener('loadstart', () => {
				console.log('Video loading started');
				UIManager.showLoadingSpinner('#videoPlayer');
			});

			video.addEventListener('canplay', () => {
				console.log('Video can start playing');
				UIManager.hideLoadingSpinner('#videoPlayer');
			});

			video.addEventListener('playing', () => {
				console.log('Video is playing');
				UIManager.hideLoadingSpinner('#videoPlayer');
			});

			video.addEventListener('waiting', () => {
				console.log('Video is buffering');
				UIManager.showLoadingSpinner('#videoPlayer');
			});

			// Error handling
			video.addEventListener('error', (e) => {
				console.error('Video error:', e);
				UIManager.hideLoadingSpinner('#videoPlayer');
				ErrorManager.handle(new Error(`Video error: ${video.error?.message || 'Unknown error'}`), ErrorManager.ERROR_TYPES.PLAYBACK, 'Video playback error', true);
			});

			// Volume change handling
			video.addEventListener('volumechange', () => {
				const settings = SettingsManager.getSettings();
				if (settings.rememberVolume) {
					SettingsManager.saveSettings({
						volume: video.volume,
						muted: video.muted
					});
				}
			});

			// Time update for progress
			video.addEventListener('timeupdate', () => {
				// Can be used for progress tracking if needed
			});

			console.log('Video event listeners attached');
		} catch (error) {
			console.warn('Failed to setup video event listeners:', error);
		}
	},

	// Check HLS support
	checkHLSSupport() {
		try {
			const hlsSupported = Hls.isSupported();
			const nativeSupported = document.createElement('video').canPlayType('application/vnd.apple.mpegurl');

			console.log('HLS Support Check:');
			console.log('- HLS.js supported:', hlsSupported);
			console.log('- Native HLS supported:', !!nativeSupported);

			if (!hlsSupported && !nativeSupported) {
				console.warn('HLS playback not supported in this browser');
				SettingsManager.showToast('warning', 'Limited Support', 'Your browser may not support all video formats. Please try a modern browser like Chrome, Firefox, or Safari.');
			}
		} catch (error) {
			console.warn('Failed to check HLS support:', error);
		}
	},

	// Load and play channel by index
	loadChannel(channelIndex) {
		try {
			if (!this.isInitialized) {
				throw new Error('Video Manager not initialized');
			}

			// Get channel data from app state
			const channels = appState.getState('channels');
			if (!channels || channels.length === 0) {
				throw new Error('No channels available');
			}

			const index = parseInt(channelIndex);
			if (isNaN(index) || index < 0 || index >= channels.length) {
				throw new Error('Invalid channel index');
			}

			const channel = channels[index];
			console.log('Loading channel:', channel.name, 'URL:', channel.url);

			// Store current channel
			appState.setState('currentChannel', channel);

			// Update UI first
			UIManager.updateChannelInfo('Loading channel...', channel);

			this.loadChannelByUrl(channel.url, channel);
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.PLAYBACK, 'Loading channel', true);
		}
	},

	// Load and play channel by URL
	loadChannelByUrl(channelUrl, channelInfo = null) {
		try {
			if (!this.isInitialized) {
				throw new Error('Video Manager not initialized');
			}

			console.log('Loading channel:', channelUrl);

			// Stop current playback
			this.stopPlayback();

			const video = document.getElementById('videoPlayer');
			if (!video) {
				throw new Error('Video player element not found');
			}

			// Show loading
			UIManager.showLoadingSpinner('#videoPlayer');

			// Setup HLS playback
			if (Hls.isSupported()) {
				this.setupHLSPlayback(channelUrl, video, channelInfo);
			} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
				this.setupNativePlayback(channelUrl, video, channelInfo);
			} else {
				throw new Error('HLS playback not supported in this browser');
			}
		} catch (error) {
			UIManager.hideLoadingSpinner('#videoPlayer');
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.PLAYBACK, 'Loading channel', true);
		}
	},

	// Setup HLS.js playback
	setupHLSPlayback(url, video, channelInfo) {
		try {
			this.currentHls = new Hls({
				enableWorker: true,
				lowLatencyMode: true,
				backBufferLength: 90,
				maxBufferLength: 30,
				maxMaxBufferLength: 600
			});

			this.currentHls.loadSource(url);
			this.currentHls.attachMedia(video);

			// Handle HLS events
			this.currentHls.on(Hls.Events.MANIFEST_PARSED, () => {
				console.log('HLS manifest parsed, starting playback');
				video.play().catch((error) => {
					console.warn('Autoplay failed:', error);
					SettingsManager.showToast('info', 'Manual Play Required', 'Click the play button to start the video.');
				});
			});

			this.currentHls.on(Hls.Events.ERROR, (_, data) => {
				console.error('HLS Error:', data);
				if (data.fatal) {
					this.handleHLSError(data, url);
				}
			});

			// Store reference for cleanup
			appState.setState('currentHls', this.currentHls);
		} catch (error) {
			throw new Error(`HLS setup failed: ${error.message}`);
		}
	},

	// Setup native HLS playback (Safari)
	setupNativePlayback(url, video, channelInfo) {
		try {
			video.src = url;

			video.addEventListener(
				'loadedmetadata',
				() => {
					console.log('Native HLS loaded, starting playback');
					video.play().catch((error) => {
						console.warn('Autoplay failed:', error);
						SettingsManager.showToast('info', 'Manual Play Required', 'Click the play button to start the video.');
					});
				},
				{ once: true }
			);

			video.load();
		} catch (error) {
			throw new Error(`Native HLS setup failed: ${error.message}`);
		}
	},

	// Handle HLS errors
	handleHLSError(data, url) {
		try {
			console.error('Fatal HLS error, attempting recovery:', data);

			switch (data.type) {
				case Hls.ErrorTypes.NETWORK_ERROR:
					console.log('Network error, trying to recover...');
					this.currentHls.startLoad();
					break;
				case Hls.ErrorTypes.MEDIA_ERROR:
					console.log('Media error, trying to recover...');
					this.currentHls.recoverMediaError();
					break;
				default:
					console.log('Unrecoverable error, destroying HLS instance');
					this.stopPlayback();
					ErrorManager.handle(new Error(`HLS Fatal Error: ${data.type} - ${data.details}`), ErrorManager.ERROR_TYPES.PLAYBACK, 'HLS playback error', true);
					break;
			}
		} catch (error) {
			console.error('Error handling HLS error:', error);
		}
	},
	// Play selected channel (alias for loadChannel)
	async playChannel(channelIndex) {
		return this.loadChannel(channelIndex);
	},

	// Stop current playback
	stopPlayback() {
		try {
			const video = document.getElementById('videoPlayer');

			// Clean up HLS instance
			if (this.currentHls) {
				this.currentHls.destroy();
				this.currentHls = null;
			}

			// Also clean up legacy appState.hls
			if (appState.hls) {
				appState.hls.destroy();
				appState.hls = null;
			}

			// Clean up video element
			if (video) {
				video.pause();
				video.src = '';
				video.load();
			}

			// Hide loading spinner
			UIManager.hideLoadingSpinner('#videoPlayer');

			console.log('Playback stopped');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.PLAYBACK, 'Stopping playback');
		}
	},

	// Clear video player
	clearVideo() {
		try {
			this.stopPlayback();
			UIManager.updateChannelInfo('Select a channel to start watching');
			appState.setState('currentChannel', null);
			console.log('Video player cleared');
		} catch (error) {
			console.warn('Failed to clear video:', error);
		}
	},

	// Toggle fullscreen
	toggleFullscreen() {
		try {
			const video = document.getElementById('videoPlayer');
			if (!video) return;

			if (!document.fullscreenElement) {
				video.requestFullscreen().catch((error) => {
					console.warn('Fullscreen request failed:', error);
					SettingsManager.showToast('warning', 'Fullscreen Failed', 'Unable to enter fullscreen mode.');
				});
			} else {
				document.exitFullscreen().catch((error) => {
					console.warn('Exit fullscreen failed:', error);
				});
			}
		} catch (error) {
			console.warn('Fullscreen toggle failed:', error);
		}
	},

	// Toggle mute
	toggleMute() {
		try {
			const video = document.getElementById('videoPlayer');
			if (!video) return;

			video.muted = !video.muted;
			console.log('Video muted:', video.muted);

			// Save setting if remember volume is enabled
			const settings = SettingsManager.getSettings();
			if (settings.rememberVolume) {
				SettingsManager.saveSettings({ muted: video.muted });
			}
		} catch (error) {
			console.warn('Failed to toggle mute:', error);
		}
	},

	// Handle window resize
	handleResize() {
		try {
			// Can be used for responsive video adjustments
			console.log('Window resized, video player may need adjustments');
		} catch (error) {
			console.warn('Failed to handle resize:', error);
		}
	},

	// Check if video manager is ready
	isReady() {
		return this.isInitialized && document.getElementById('videoPlayer') !== null;
	},

	// Get current playback state
	getPlaybackState() {
		try {
			const video = document.getElementById('videoPlayer');
			if (!video) return null;

			return {
				playing: !video.paused,
				muted: video.muted,
				volume: video.volume,
				currentTime: video.currentTime,
				duration: video.duration,
				hasHLS: !!this.currentHls,
				readyState: video.readyState,
				networkState: video.networkState
			};
		} catch (error) {
			console.warn('Failed to get playback state:', error);
			return null;
		}
	},

	// Cleanup video manager
	cleanup() {
		try {
			console.log('Cleaning up Video Manager...');

			// Stop playback
			this.stopPlayback();

			// Remove event listeners (if needed)
			const video = document.getElementById('videoPlayer');
			if (video) {
				// Clone and replace to remove all event listeners
				const newVideo = video.cloneNode(true);
				video.parentNode.replaceChild(newVideo, video);
			}

			// Reset state
			this.isInitialized = false;
			this.currentHls = null;

			console.log('Video Manager cleanup completed');
		} catch (error) {
			console.warn('Video Manager cleanup failed:', error);
		}
	}
};
