/**
 * PWA Manager - Progressive Web App Integration
 *
 * Modern ES6+ PWA management system with service worker integration,
 * install prompt handling, update notifications, and offline capabilities.
 *
 * Features:
 * - Service Worker Registration & Management
 * - PWA Install Prompt Handling
 * - Update Notifications
 * - Offline Support Detection
 * - Modern UI Components
 * - Comprehensive Error Handling
 *
 * @author IPTV Player Team
 * @version 2.0.0
 */

// =============================================================================
// Core PWA State Management
// =============================================================================

/**
 * Global PWA application state
 */
class PWAState {
	constructor() {
		this.serviceWorker = null;
		this.deferredPrompt = null;
		this.isInstalled = false;
		this.isOnline = navigator.onLine;
		this.updateAvailable = false;
		this.installPromptShown = false;

		// Configuration
		this.config = {
			serviceWorkerPath: './sw.js',
			updateCheckInterval: 60000, // 1 minute
			notificationTimeout: 10000,
			installButtonTimeout: 15000,
			maxRetries: 3,
			retryDelay: 2000,
		};

		// Event listeners storage
		this.eventListeners = new Map();

		// Initialize state
		this.init();
	}

	/**
	 * Initialize PWA state
	 */
	init() {
		this.checkInstallStatus();
		this.setupNetworkListeners();
		console.log('🚀 PWA State initialized');
	}

	/**
	 * Check if app is installed
	 */
	checkInstallStatus() {
		// Check if running in standalone mode
		this.isInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true || document.referrer.includes('android-app://');
	}

	/**
	 * Setup network status listeners
	 */
	setupNetworkListeners() {
		window.addEventListener('online', () => {
			this.isOnline = true;
			console.log('🌐 Application is online');
			this.notifyNetworkStatus(true);
		});

		window.addEventListener('offline', () => {
			this.isOnline = false;
			console.log('📡 Application is offline');
			this.notifyNetworkStatus(false);
		});
	}

	/**
	 * Notify network status change
	 * @param {boolean} isOnline - Network status
	 */
	notifyNetworkStatus(isOnline) {
		const event = new CustomEvent('pwa:networkchange', {
			detail: { isOnline },
		});
		window.dispatchEvent(event);
	}
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * PWA utility functions
 */
const PWAUtils = {
	/**
	 * Create styled notification element
	 * @param {Object} options - Notification options
	 * @returns {HTMLElement} Notification element
	 */
	createNotification(options = {}) {
		const { title = 'Notification', message = '', type = 'info', icon = 'fas fa-info-circle', timeout = 10000, onClick = null } = options;

		const notification = document.createElement('div');
		notification.className = 'pwa-notification';

		const typeColors = {
			info: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
			success: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
			warning: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
			error: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
		};

		notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${typeColors[type]};
            color: white;
            padding: 1rem 1.5rem;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.15);
            z-index: 10000;
            font-family: "Inter", sans-serif;
            font-size: 0.9rem;
            cursor: ${onClick ? 'pointer' : 'default'};
            transition: all 0.3s ease;
            max-width: 320px;
            backdrop-filter: blur(10px);
        `;

		notification.innerHTML = `
            <div style="display: flex; align-items: center; gap: 0.75rem;">
                <i class="${icon}" style="font-size: 1.1rem; flex-shrink: 0;"></i>
                <div style="flex: 1;">
                    <div style="font-weight: 600; margin-bottom: 0.25rem;">${title}</div>
                    ${message ? `<div style="font-size: 0.8rem; opacity: 0.9;">${message}</div>` : ''}
                </div>
            </div>
        `;

		if (onClick) {
			notification.addEventListener('click', onClick);
		}

		// Add hover effect
		notification.addEventListener('mouseenter', () => {
			notification.style.transform = 'translateY(-2px)';
			notification.style.boxShadow = '0 15px 35px rgba(0,0,0,0.2)';
		});

		notification.addEventListener('mouseleave', () => {
			notification.style.transform = 'translateY(0)';
			notification.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
		});

		document.body.appendChild(notification);

		// Auto-hide
		if (timeout > 0) {
			setTimeout(() => {
				if (notification.parentNode) {
					notification.style.transform = 'translateX(100%)';
					notification.style.opacity = '0';
					setTimeout(() => notification.remove(), 300);
				}
			}, timeout);
		}

		return notification;
	},

	/**
	 * Create styled button element
	 * @param {Object} options - Button options
	 * @returns {HTMLElement} Button element
	 */
	createButton(options = {}) {
		const { text = 'Button', icon = '', type = 'primary', position = { bottom: '20px', right: '20px' }, onClick = null, className = '' } = options;

		const button = document.createElement('button');
		button.className = `pwa-button ${className}`;

		const typeStyles = {
			primary: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
			success: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
			warning: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
			danger: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
		};

		let positionStyle = 'position: fixed;';
		Object.entries(position).forEach(([key, value]) => {
			positionStyle += `${key}: ${value};`;
		});

		button.style.cssText = `
            ${positionStyle}
            background: ${typeStyles[type]};
            color: white;
            border: none;
            padding: 1rem 1.5rem;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.15);
            z-index: 10000;
            font-family: "Inter", sans-serif;
            font-size: 0.9rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 0.75rem;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.1);
        `;

		button.innerHTML = `
            ${icon ? `<i class="${icon}" style="font-size: 1rem;"></i>` : ''}
            <span>${text}</span>
        `;

		if (onClick) {
			button.addEventListener('click', onClick);
		}

		// Add hover and active effects
		button.addEventListener('mouseenter', () => {
			button.style.transform = 'translateY(-2px)';
			button.style.boxShadow = '0 15px 35px rgba(0,0,0,0.2)';
		});

		button.addEventListener('mouseleave', () => {
			button.style.transform = 'translateY(0)';
			button.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
		});

		button.addEventListener('mousedown', () => {
			button.style.transform = 'translateY(0)';
		});

		return button;
	},

	/**
	 * Throttle function execution
	 * @param {Function} func - Function to throttle
	 * @param {number} delay - Throttle delay in milliseconds
	 * @returns {Function} Throttled function
	 */
	throttle(func, delay) {
		let timeoutId;
		let lastExecTime = 0;

		return function (...args) {
			const currentTime = Date.now();

			if (currentTime - lastExecTime > delay) {
				func.apply(this, args);
				lastExecTime = currentTime;
			} else {
				clearTimeout(timeoutId);
				timeoutId = setTimeout(
					() => {
						func.apply(this, args);
						lastExecTime = Date.now();
					},
					delay - (currentTime - lastExecTime),
				);
			}
		};
	},

	/**
	 * Debounce function execution
	 * @param {Function} func - Function to debounce
	 * @param {number} delay - Debounce delay in milliseconds
	 * @returns {Function} Debounced function
	 */
	debounce(func, delay) {
		let timeoutId;

		return function (...args) {
			clearTimeout(timeoutId);
			timeoutId = setTimeout(() => func.apply(this, args), delay);
		};
	},
};

// =============================================================================
// Error Management System
// =============================================================================

/**
 * PWA error manager
 */
class PWAErrorManager {
	constructor() {
		this.errors = [];
		this.maxErrors = 50;
		this.retryAttempts = new Map();
	}

	/**
	 * Log error with context
	 * @param {Error|string} error - Error to log
	 * @param {string} context - Error context
	 * @param {Object} metadata - Additional metadata
	 */
	logError(error, context = 'Unknown', metadata = {}) {
		const errorEntry = {
			timestamp: new Date().toISOString(),
			error: error instanceof Error ? error.message : error,
			stack: error instanceof Error ? error.stack : null,
			context,
			metadata,
			id: this.generateErrorId(),
		};

		this.errors.push(errorEntry);

		// Keep only recent errors
		if (this.errors.length > this.maxErrors) {
			this.errors = this.errors.slice(-this.maxErrors);
		}

		// Log to console with formatting
		console.error(`❌ PWA Error [${context}]:`, error, metadata);

		// Trigger error event
		const event = new CustomEvent('pwa:error', {
			detail: errorEntry,
		});
		window.dispatchEvent(event);
	}

	/**
	 * Generate unique error ID
	 * @returns {string} Error ID
	 */
	generateErrorId() {
		return Date.now().toString(36) + Math.random().toString(36).substr(2);
	}

	/**
	 * Get recent errors
	 * @param {number} limit - Number of errors to return
	 * @returns {Array} Recent errors
	 */
	getRecentErrors(limit = 10) {
		return this.errors.slice(-limit);
	}

	/**
	 * Clear error log
	 */
	clearErrors() {
		this.errors = [];
		console.log('🧹 PWA error log cleared');
	}

	/**
	 * Handle retry logic
	 * @param {string} operation - Operation name
	 * @param {Function} func - Function to retry
	 * @param {number} maxRetries - Maximum retry attempts
	 * @param {number} delay - Delay between retries
	 * @returns {Promise} Operation result
	 */
	async withRetry(operation, func, maxRetries = 3, delay = 1000) {
		const attempts = this.retryAttempts.get(operation) || 0;

		try {
			const result = await func();
			this.retryAttempts.delete(operation); // Reset on success
			return result;
		} catch (error) {
			if (attempts < maxRetries) {
				this.retryAttempts.set(operation, attempts + 1);
				this.logError(error, `${operation} (attempt ${attempts + 1}/${maxRetries})`);

				await new Promise((resolve) => setTimeout(resolve, delay));
				return this.withRetry(operation, func, maxRetries, delay);
			} else {
				this.retryAttempts.delete(operation);
				this.logError(error, `${operation} (final attempt failed)`);
				throw error;
			}
		}
	}
}

// =============================================================================
// Service Worker Manager
// =============================================================================

/**
 * Service Worker management system
 */
class ServiceWorkerManager {
	constructor(errorManager) {
		this.errorManager = errorManager;
		this.registration = null;
		this.updateCheckInterval = null;
		this.isRegistered = false;
	}

	/**
	 * Register service worker
	 * @param {string} swPath - Service worker file path
	 * @returns {Promise<ServiceWorkerRegistration>} Registration promise
	 */
	async register(swPath = './sw.js') {
		if (!('serviceWorker' in navigator)) {
			throw new Error('Service Worker not supported in this browser');
		}

		try {
			const registration = await this.errorManager.withRetry('sw-registration', () => navigator.serviceWorker.register(swPath));

			this.registration = registration;
			this.isRegistered = true;

			console.log('✅ Service Worker registered successfully:', registration);

			// Setup event listeners
			this.setupUpdateListener();
			this.setupControllerListener();
			this.startUpdateCheck();

			// Trigger registration event
			const event = new CustomEvent('pwa:sw-registered', {
				detail: { registration },
			});
			window.dispatchEvent(event);

			return registration;
		} catch (error) {
			this.errorManager.logError(error, 'Service Worker Registration');
			throw error;
		}
	}

	/**
	 * Setup update listener
	 */
	setupUpdateListener() {
		if (!this.registration) return;

		this.registration.addEventListener('updatefound', () => {
			const newWorker = this.registration.installing;

			if (newWorker) {
				newWorker.addEventListener('statechange', () => {
					if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
						console.log('🔄 New version available');
						this.showUpdateNotification();
						try {
							window.location.reload();
						} catch (error) {
							this.errorManager.logError(error, 'New version intalled!.. Auto relode not working!...');
						}

						// Trigger update event
						const event = new CustomEvent('pwa:update-available', {
							detail: { newWorker },
						});
						window.dispatchEvent(event);
					}
				});
			}
		});
	}

	/**
	 * Setup controller change listener
	 */
	setupControllerListener() {
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			console.log('🔄 Service Worker controller changed');

			// Trigger controller change event
			const event = new CustomEvent('pwa:sw-controller-change');
			window.dispatchEvent(event);
		});
	}

	/**
	 * Start periodic update checks
	 * @param {number} interval - Check interval in milliseconds
	 */
	startUpdateCheck(interval = 60000) {
		if (this.updateCheckInterval) {
			clearInterval(this.updateCheckInterval);
		}

		this.updateCheckInterval = setInterval(() => {
			this.checkForUpdate();
		}, interval);
	}

	/**
	 * Check for service worker update
	 */
	async checkForUpdate() {
		if (!this.registration) return;

		try {
			await this.registration.update();
			console.log('🔍 Checked for Service Worker update');
		} catch (error) {
			this.errorManager.logError(error, 'Service Worker Update Check');
		}
	}

	/**
	 * Show update notification
	 */
	showUpdateNotification() {
		PWAUtils.createNotification({
			title: 'Update Available',
			message: 'Click to refresh and update to the latest version',
			type: 'info',
			icon: 'fas fa-download',
			onClick: () => {
				window.location.reload();
			},
		});
	}

	/**
	 * Unregister service worker
	 */
	async unregister() {
		if (!this.registration) return false;

		try {
			const result = await this.registration.unregister();
			this.registration = null;
			this.isRegistered = false;

			if (this.updateCheckInterval) {
				clearInterval(this.updateCheckInterval);
				this.updateCheckInterval = null;
			}

			console.log('🗑️ Service Worker unregistered');
			return result;
		} catch (error) {
			this.errorManager.logError(error, 'Service Worker Unregistration');
			throw error;
		}
	}
}

// =============================================================================
// Install Prompt Manager
// =============================================================================

/**
 * PWA install prompt management
 */
class InstallPromptManager {
	constructor(errorManager) {
		this.errorManager = errorManager;
		this.deferredPrompt = null;
		this.installButton = null;
		this.headerButton = null;
		this.isInstallable = false;
		this.promptShown = false;

		this.setupEventListeners();
	}

	/**
	 * Setup install prompt event listeners
	 */
	setupEventListeners() {
		window.addEventListener('beforeinstallprompt', (e) => {
			console.log('💿 PWA install prompt available');
			e.preventDefault();

			this.deferredPrompt = e;
			window.deferredPrompt = e; // Make it globally accessible
			this.isInstallable = true;

			this.showInstallUI();

			// Trigger installable event
			const event = new CustomEvent('pwa:installable', {
				detail: { prompt: e },
			});
			window.dispatchEvent(event);
		});

		window.addEventListener('appinstalled', () => {
			console.log('🎉 PWA was installed successfully');
			this.deferredPrompt = null;
			this.isInstallable = false;
			this.hideInstallUI();

			// Trigger installed event
			const event = new CustomEvent('pwa:installed');
			window.dispatchEvent(event);

			// Show success notification
			PWAUtils.createNotification({
				title: 'App Installed!',
				message: 'IPTV Player has been installed successfully',
				type: 'success',
				icon: 'fas fa-check-circle',
			});
		});
	}

	/**
	 * Show install UI elements
	 */
	showInstallUI() {
		this.showHeaderInstallButton();

		// Show floating install button after delay
		// setTimeout(() => {
		// 	if (this.isInstallable && !this.promptShown) {
		// 		this.showFloatingInstallButton();
		// 	}
		// }, 5000);
	}

	/**
	 * Hide install UI elements
	 */
	hideInstallUI() {
		if (this.headerButton) {
			this.headerButton.style.display = 'none';
		}

		if (this.installButton?.parentNode) {
			this.installButton.remove();
		}
	}

	/**
	 * Show header install button
	 */
	showHeaderInstallButton() {
		const headerInstallBtn = document.getElementById('headerInstallBtn');
		if (headerInstallBtn) {
			this.headerButton = headerInstallBtn;

			// Remove any hiding classes and show button
			headerInstallBtn.classList.remove('d-none');
			headerInstallBtn.style.display = 'inline-flex';

			// Remove existing listeners
			const newButton = headerInstallBtn.cloneNode(true);
			headerInstallBtn.parentNode.replaceChild(newButton, headerInstallBtn);
			this.headerButton = newButton;

			// Add click listener
			newButton.addEventListener('click', async () => {
				await this.promptInstall();
			});

			console.log('📌 Header install button shown');
		}
	}

	/**
	 * Show floating install button
	 */
	showFloatingInstallButton() {
		if (this.installButton?.parentNode) {
			return; // Already shown
		}

		this.installButton = PWAUtils.createButton({
			text: 'Install App',
			icon: 'fas fa-download',
			type: 'success',
			position: { bottom: '20px', right: '20px' },
			onClick: async () => {
				await this.promptInstall();
			},
			className: 'pwa-install-button',
		});

		document.body.appendChild(this.installButton);

		// Auto-hide after timeout
		setTimeout(() => {
			if (this.installButton?.parentNode && this.isInstallable) {
				this.installButton.style.transform = 'translateY(100px)';
				this.installButton.style.opacity = '0';
				setTimeout(() => {
					if (this.installButton?.parentNode) {
						this.installButton.remove();
					}
				}, 300);
			}
		}, 15000);

		console.log('🎯 Floating install button shown');
	}

	/**
	 * Prompt for installation
	 * @returns {Promise<string>} Install outcome
	 */
	async promptInstall() {
		if (!this.deferredPrompt) {
			// Fallback message
			PWAUtils.createNotification({
				title: 'Install Not Available',
				message: 'PWA install is not available in this browser or already installed',
				type: 'warning',
				icon: 'fas fa-exclamation-triangle',
			});
			return 'not_available';
		}

		try {
			this.promptShown = true;

			// Show the install prompt
			this.deferredPrompt.prompt();

			// Wait for user choice
			const { outcome } = await this.deferredPrompt.userChoice;

			console.log(`PWA install prompt outcome: ${outcome}`);

			if (outcome === 'accepted') {
				this.hideInstallUI();

				PWAUtils.createNotification({
					title: 'Installing...',
					message: 'IPTV Player is being installed',
					type: 'info',
					icon: 'fas fa-spinner fa-spin',
				});
			}

			// Trigger prompt result event
			const event = new CustomEvent('pwa:install-prompt-result', {
				detail: { outcome },
			});
			window.dispatchEvent(event);

			this.deferredPrompt = null;
			return outcome;
		} catch (error) {
			this.errorManager.logError(error, 'Install Prompt');

			PWAUtils.createNotification({
				title: 'Install Error',
				message: 'Failed to show install prompt',
				type: 'error',
				icon: 'fas fa-exclamation-triangle',
			});

			throw error;
		}
	}

	/**
	 * Check if app can be installed
	 * @returns {boolean} Can install status
	 */
	canInstall() {
		return this.isInstallable && this.deferredPrompt !== null;
	}
}

// =============================================================================
// Main PWA Manager
// =============================================================================

/**
 * Main PWA application manager
 */
class PWAManager {
	constructor() {
		this.state = new PWAState();
		this.errorManager = new PWAErrorManager();
		this.serviceWorkerManager = new ServiceWorkerManager(this.errorManager);
		this.installPromptManager = new InstallPromptManager(this.errorManager);

		this.isInitialized = false;

		// Bind methods
		this.init = this.init.bind(this);
		this.destroy = this.destroy.bind(this);
	}

	/**
	 * Initialize PWA manager
	 * @returns {Promise<void>}
	 */
	async init() {
		if (this.isInitialized) {
			console.warn('⚠️ PWA Manager already initialized');
			return;
		}

		try {
			console.log('🚀 Initializing PWA Manager...');

			// Initialize service worker
			if ('serviceWorker' in navigator) {
				await this.serviceWorkerManager.register(this.state.config.serviceWorkerPath);
			} else {
				console.warn('⚠️ Service Worker not supported');
			}

			// Setup global error handling
			this.setupErrorHandling();

			// Setup performance monitoring
			this.setupPerformanceMonitoring();

			this.isInitialized = true;

			console.log('✅ PWA Manager initialized successfully');

			// Trigger initialization event
			const event = new CustomEvent('pwa:initialized', {
				detail: {
					state: this.state,
					canInstall: this.installPromptManager.canInstall(),
				},
			});
			window.dispatchEvent(event);
		} catch (error) {
			this.errorManager.logError(error, 'PWA Manager Initialization');
			throw error;
		}
	}

	/**
	 * Setup global error handling
	 */
	setupErrorHandling() {
		// Handle unhandled promise rejections
		window.addEventListener('unhandledrejection', (event) => {
			this.errorManager.logError(event.reason, 'Unhandled Promise Rejection', {
				promise: event.promise,
				url: window.location.href,
			});
		});

		// Handle global errors
		window.addEventListener('error', (event) => {
			this.errorManager.logError(event.error || event.message, 'Global Error', {
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
				url: window.location.href,
			});
		});
	}

	/**
	 * Setup performance monitoring
	 */
	setupPerformanceMonitoring() {
		// Monitor page load performance
		if ('performance' in window) {
			window.addEventListener('load', () => {
				setTimeout(() => {
					const perfData = performance.timing;
					const loadTime = perfData.loadEventEnd - perfData.navigationStart;

					console.log(`📊 Page load time: ${loadTime}ms`);

					// Trigger performance event
					const event = new CustomEvent('pwa:performance', {
						detail: {
							loadTime,
							timing: perfData,
						},
					});
					window.dispatchEvent(event);
				}, 0);
			});
		}
	}

	/**
	 * Get PWA status information
	 * @returns {Object} PWA status
	 */
	getStatus() {
		return {
			isInitialized: this.isInitialized,
			isOnline: this.state.isOnline,
			isInstalled: this.state.isInstalled,
			canInstall: this.installPromptManager.canInstall(),
			serviceWorkerRegistered: this.serviceWorkerManager.isRegistered,
			updateAvailable: this.state.updateAvailable,
			errors: this.errorManager.getRecentErrors(5),
		};
	}

	/**
	 * Manually check for updates
	 * @returns {Promise<void>}
	 */
	async checkForUpdates() {
		await this.serviceWorkerManager.checkForUpdate();
	}

	/**
	 * Manually trigger install prompt
	 * @returns {Promise<string>} Install outcome
	 */
	async triggerInstall() {
		return await this.installPromptManager.promptInstall();
	}

	/**
	 * Destroy PWA manager
	 */
	async destroy() {
		if (!this.isInitialized) return;

		try {
			// Clear intervals
			if (this.serviceWorkerManager.updateCheckInterval) {
				clearInterval(this.serviceWorkerManager.updateCheckInterval);
			}

			// Hide install UI
			this.installPromptManager.hideInstallUI();

			// Clear error log
			this.errorManager.clearErrors();

			this.isInitialized = false;

			console.log('🧹 PWA Manager destroyed');
		} catch (error) {
			this.errorManager.logError(error, 'PWA Manager Destruction');
		}
	}
}

// =============================================================================
// Global Instance and Initialization
// =============================================================================

// Create global PWA manager instance
let pwaManager = null;

/**
 * Initialize PWA when DOM is ready
 */
function initializePWA() {
	try {
		pwaManager = new PWAManager();

		// Initialize when page loads
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => {
				pwaManager.init().catch((error) => {
					console.error('❌ Failed to initialize PWA:', error);
				});
			});
		} else {
			pwaManager.init().catch((error) => {
				console.error('❌ Failed to initialize PWA:', error);
			});
		}

		// Also show header install button immediately for testing
		if ($ && typeof $.fn.ready === 'function') {
			$(document).ready(() => {
				// Force show header install button for testing
				const headerBtn = document.getElementById('headerInstallBtn');
				if (headerBtn) {
					headerBtn.classList.remove('d-none');
					headerBtn.style.display = 'inline-flex';
				}
			});
		}
	} catch (error) {
		console.error('❌ Failed to create PWA Manager:', error);
	}
}

// Auto-initialize when script loads
initializePWA();

// Export for external access
if (typeof window !== 'undefined') {
	window.PWAManager = PWAManager;
	window.pwaManager = pwaManager;
}

// =============================================================================
// Export for Module Systems
// =============================================================================

if (typeof module !== 'undefined' && module.exports) {
	module.exports = {
		PWAManager,
		PWAState,
		PWAUtils,
		PWAErrorManager,
		ServiceWorkerManager,
		InstallPromptManager,
	};
}
