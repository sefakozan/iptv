import { channelInfo } from './ChannelInfo.js';
import { channelSelect } from './ChannelSelect.js';
import { notificationManager } from './NotificationManager.js';

/* ========================================================================
   IPTV Player - Video Player Management
   ======================================================================== */

// Video Player Management
class VideoManager {
	// Video player state
	isInitialized = false;
	currentHls = null;

	// Initialize video manager
	initialize() {
		try {
			const video = document.getElementById('videoPlayer');
			if (!video) {
				throw new Error('Video player element not found');
			}

			// Set up video element properties
			this.setupVideoElement(video);

			// Add video event listeners
			//this.setupVideoEventListeners(video);

			// Check HLS support
			this.checkHLSSupport();

			this.isInitialized = true;
			console.log('Video Manager initialized successfully');
		} catch (error) {
			console.error('Video Manager initialization failed:', error);
		}
	}

	// Setup video element properties
	setupVideoElement(video) {
		try {
			// Set default properties
			video.controls = true;
			video.preload = 'metadata';
			video.crossOrigin = 'anonymous';
			// Autoplay policy friendly defaults
			video.autoplay = true;
			video.muted = true; // muted autoplay works across browsers
			video.playsInline = true;
			video.setAttribute('playsinline', '');
			video.setAttribute('webkit-playsinline', '');
			video.setAttribute('muted', '');

			// Apply saved settings
			// const settings = SettingsManager.getSettings();
			// if (settings.autoplayMuted !== false) {
			// 	video.muted = true;
			// }

			// if (settings.rememberVolume && typeof settings.volume === 'number') {
			// 	video.volume = Math.max(0, Math.min(1, settings.volume));
			// }

			// if (typeof settings.muted === 'boolean') {
			// 	video.muted = settings.muted;
			// }

			console.log('Video element configured');
		} catch (error) {
			console.warn('Failed to setup video element:', error);
		}
	}

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
	}

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

				notificationManager.warning('warning', 'Limited Support', 'Your browser may not support all video formats. Please try a modern browser like Chrome, Firefox, or Safari.');
			}
		} catch (error) {
			console.warn('Failed to check HLS support:', error);
		}
	}

	// Load and play channel by index
	loadChannel(channelIndex) {
		try {
			if (!this.isInitialized) {
				throw new Error('Video Manager not initialized');
			}

			const channel = channelSelect.currentChannels[channelIndex];

			console.log('Loading channel:', channel.name, 'URL:', channel.url);
			channelInfo.updateChannelInfo('', channel);

			this.loadChannelByUrl(channel.url);
		} catch (error) {
			console.error('Loading channel', error);
		}
	}

	// Load and play channel by URL
	loadChannelByUrl(channelUrl) {
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
			this.showLoadingSpinner('#videoPlayer');

			// Setup HLS playback
			if (Hls.isSupported()) {
				this.setupHLSPlayback(channelUrl, video);
			} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
				this.setupNativePlayback(channelUrl, video);
			} else {
				throw new Error('HLS playback not supported in this browser');
			}
		} catch (error) {
			this.hideLoadingSpinner('#videoPlayer');
			console.error('Loading channel', error);
		}
	}

	// Setup HLS.js playback
	setupHLSPlayback(url, video) {
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
					if (error?.name === 'NotAllowedError') {
						this.#installOneTimeGesture(video);
						notificationManager.info('Tap to play', 'Press any key or tap once to start the video.');
					} else {
						notificationManager.info('Manual Play Required', 'Click the play button to start the video.');
					}
				});
			});

			this.currentHls.on(Hls.Events.ERROR, (_, data) => {
				console.error('HLS Error:', data);
				if (data.fatal) {
					this.handleHLSError(data);
				}
			});

			// TODO Store reference for cleanup
			//appState.setState('currentHls', this.currentHls);
		} catch (error) {
			throw new Error(`HLS setup failed: ${error.message}`);
		}
	}

	// Setup native HLS playback (Safari)
	setupNativePlayback(url, video) {
		try {
			video.src = url;

			video.addEventListener(
				'loadedmetadata',
				() => {
					console.log('Native HLS loaded, starting playback');
					video.play().catch((error) => {
						console.warn('Autoplay failed:', error);
						if (error?.name === 'NotAllowedError') {
							this.#installOneTimeGesture(video);
							notificationManager.info('Tap to play', 'Press any key or tap once to start the video.');
						} else {
							notificationManager.info('Manual Play Required', 'Click the play button to start the video.');
						}
					});
				},
				{ once: true }
			);

			video.load();
		} catch (error) {
			throw new Error(`Native HLS setup failed: ${error.message}`);
		}
	}

	// Handle HLS errors
	handleHLSError(data) {
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
					// TODO show user
					console.error('Unrecoverable error, destroying HLS instance');
					this.stopPlayback();
					break;
			}
		} catch (error) {
			console.error('Error handling HLS error:', error);
		}
	}
	// Play selected channel (alias for loadChannel)
	async playChannel(channelIndex) {
		return this.loadChannel(channelIndex);
	}

	// Stop current playback
	stopPlayback() {
		try {
			const video = document.getElementById('videoPlayer');

			// Clean up HLS instance
			if (this.currentHls) {
				this.currentHls.destroy();
				this.currentHls = null;
			}

			// Clean up video element
			if (video) {
				video.pause();
				video.src = '';
				video.load();
			}

			// Hide loading spinner
			this.hideLoadingSpinner('#videoPlayer');

			console.log('Playback stopped');
		} catch (error) {
			console.error('Stopping playback', error);
		}
	}

	// Clear video player
	clearVideo() {
		try {
			this.stopPlayback();
			channelInfo.updateChannelInfo('Select a channel to start watching');
			// TODO
			//appState.setState('currentChannel', null);
			console.log('Video player cleared');
		} catch (error) {
			console.warn('Failed to clear video:', error);
		}
	}

	// Toggle fullscreen
	toggleFullscreen() {
		try {
			const video = document.getElementById('videoPlayer');
			if (!video) return;

			if (!document.fullscreenElement) {
				video.requestFullscreen().catch((error) => {
					console.warn('Fullscreen request failed:', error);
					notificationManager.warning('Fullscreen Failed', 'Unable to enter fullscreen mode.');
				});
			} else {
				document.exitFullscreen().catch((error) => {
					console.warn('Exit fullscreen failed:', error);
				});
			}
		} catch (error) {
			console.warn('Fullscreen toggle failed:', error);
		}
	}

	// Toggle mute
	toggleMute() {
		try {
			const video = document.getElementById('videoPlayer');
			if (!video) return;

			video.muted = !video.muted;
			console.log('Video muted:', video.muted);

			// Persisting volume can be wired to Settings if needed
		} catch (error) {
			console.warn('Failed to toggle mute:', error);
		}
	}

	/**
	 * Install a one-time user gesture listener to resume autoplay
	 * @param {HTMLVideoElement} video
	 */
	#installOneTimeGesture(video) {
		const resume = () => {
			cleanup();
			video.play().catch(() => {});
		};
		const cleanup = () => {
			['pointerdown', 'keydown', 'touchend'].forEach((t) => document.removeEventListener(t, resume, { capture: true }));
		};
		['pointerdown', 'keydown', 'touchend'].forEach((t) => document.addEventListener(t, resume, { once: true, capture: true }));
	}
	// Handle window resize
	handleResize() {
		try {
			// Can be used for responsive video adjustments
			console.log('Window resized, video player may need adjustments');
		} catch (error) {
			console.warn('Failed to handle resize:', error);
		}
	}

	// Check if video manager is ready
	isReady() {
		return this.isInitialized && document.getElementById('videoPlayer') !== null;
	}

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
	}

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

	// Show loading spinner for specific elements
	showLoadingSpinner(targetSelector = '#videoPlayer') {
		try {
			const $target = $(targetSelector);
			if ($target.length === 0) return;

			// Remove existing spinner
			$target.find('.loading-spinner').remove();

			// Create spinner overlay
			const spinnerHtml = `
				<div class="loading-spinner position-absolute top-50 start-50 translate-middle text-light" 
					 style="z-index: 1000;">
					<div class="spinner-border" role="status">
						<span class="visually-hidden">Loading...</span>
					</div>
					<div class="mt-2 small">Loading video...</div>
				</div>
			`;

			// Add relative positioning if not set
			if ($target.css('position') === 'static') {
				$target.css('position', 'relative');
			}

			$target.append(spinnerHtml);
		} catch (error) {
			console.warn('Failed to show loading spinner:', error);
		}
	}

	// Hide loading spinner
	hideLoadingSpinner(targetSelector = '#videoPlayer') {
		try {
			$(targetSelector)
				.find('.loading-spinner')
				.fadeOut(200, function () {
					$(this).remove();
				});
		} catch (error) {
			console.warn('Failed to hide loading spinner:', error);
		}
	}
}

export const videoManager = new VideoManager();
