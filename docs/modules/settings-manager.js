/* ========================================================================
   IPTV Player - Settings Management System
   ======================================================================== */

// Settings Management
const SettingsManager = {
	// Storage key for settings
	STORAGE_KEY: 'iptvPlayerSettings',

	// Get all settings
	getSettings() {
		try {
			const stored = localStorage.getItem(this.STORAGE_KEY);
			return stored ? JSON.parse(stored) : {};
		} catch (error) {
			console.warn('Failed to load settings:', error);
			return {};
		}
	},

	// Save settings
	saveSettings(settings) {
		try {
			const currentSettings = this.getSettings();
			const updatedSettings = { ...currentSettings, ...settings };
			localStorage.setItem(this.STORAGE_KEY, JSON.stringify(updatedSettings));
			console.log('Settings saved:', updatedSettings);
			return true;
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.VALIDATION, 'Saving settings', true);
			return false;
		}
	},

	// Show settings modal (now modal)
	showSettingsModal() {
		// Update PWA status information
		this.updateModalStatus();
		// Bootstrap modal will handle the show
	},

	// Hide settings modal (now modal)
	hideSettingsModal() {
		// Bootstrap modal will handle the hide
	},

	// Update modal status information
	updateModalStatus() {
		try {
			// Check installation status
			const isInstalled = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone || document.referrer.includes('android-app://');

			const $installStatus = $('#installStatus');
			const $installBtn = $('#installAppBtn');

			if (isInstalled) {
				$installStatus.removeClass('bg-secondary bg-warning').addClass('bg-success').html('<i class="fas fa-check me-1"></i>Installed');
				$installBtn.addClass('d-none');
			} else {
				$installStatus.removeClass('bg-success bg-warning').addClass('bg-secondary').html('<i class="fas fa-download me-1"></i>Not Installed');
				// Show install button if PWA installation is available
				if (window.deferredPrompt || window.BeforeInstallPromptEvent) {
					$installBtn.removeClass('d-none');
				}
			}

			// Check Service Worker status
			const $swStatus = $('#swStatus');
			const $updateBtn = $('#updateSwBtn');

			if ('serviceWorker' in navigator) {
				navigator.serviceWorker.getRegistrations().then((registrations) => {
					if (registrations.length > 0) {
						const registration = registrations[0];

						// Check if there's an update available
						if (registration.waiting) {
							$swStatus.removeClass('bg-secondary bg-success').addClass('bg-warning').html('<i class="fas fa-exclamation me-1"></i>Update Available');
							$updateBtn.removeClass('d-none');
						} else {
							$swStatus.removeClass('bg-secondary bg-warning').addClass('bg-success').html('<i class="fas fa-check me-1"></i>Active');
							$updateBtn.addClass('d-none');
						}
					} else {
						$swStatus.removeClass('bg-success bg-warning').addClass('bg-warning').html('<i class="fas fa-exclamation me-1"></i>Not Active');
						$updateBtn.addClass('d-none');
					}
				});
			} else {
				$swStatus.removeClass('bg-success bg-warning').addClass('bg-secondary').html('<i class="fas fa-times me-1"></i>Not Supported');
				$updateBtn.addClass('d-none');
			}

			// Update last updated time
			const lastUpdate = new Date().toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'long',
				day: 'numeric',
			});
			$('#lastUpdated').text(lastUpdate);

			// Update header install button
			this.updateHeaderInstallButton(isInstalled);
		} catch (error) {
			console.warn('Error updating modal status:', error);
		}
	},

	// Update header install button based on installation status
	async updateHeaderInstallButton(isInstalled) {
		try {
			const $headerInstallBtn = $('#headerInstallBtn');
			const $btnIcon = $headerInstallBtn.find('i');
			const $btnText = $headerInstallBtn.find('.btn-text');

			if (isInstalled) {
				// App is installed - show version from service worker
				$btnIcon.removeClass('fas fa-download').addClass('fas fa-check-circle');

				// Get current version from service worker
				const currentVersion = await this.getServiceWorkerVersion();
				$btnText.text(currentVersion || 'v2.1.3');

				$headerInstallBtn.removeClass('btn-outline-light').addClass('btn-outline-success');
				$headerInstallBtn.prop('disabled', true);
				$headerInstallBtn.attr('title', 'App is installed');
			} else {
				// App is not installed - show install button
				$btnIcon.removeClass('fas fa-check-circle').addClass('fas fa-download');
				$btnText.text('Install App');
				$headerInstallBtn.removeClass('btn-outline-success').addClass('btn-outline-light');
				$headerInstallBtn.prop('disabled', false);
				$headerInstallBtn.attr('title', 'Install IPTV Player as PWA');

				// Show button only if installation is available
				if (window.deferredPrompt || window.BeforeInstallPromptEvent) {
					$headerInstallBtn.show();
				} else {
					$headerInstallBtn.hide();
				}
			}
		} catch (error) {
			console.warn('Error updating header install button:', error);
		}
	},

	// Handle PWA installation
	installPWA() {
		if (window.deferredPrompt) {
			window.deferredPrompt.prompt();
			window.deferredPrompt.userChoice.then((choiceResult) => {
				if (choiceResult.outcome === 'accepted') {
					console.log('PWA installation accepted');
					this.showToast('success', 'Installation Started', 'IPTV Player is being installed...');
					// Update status after installation
					setTimeout(() => this.updateModalStatus(), 1000);
				} else {
					this.showToast('info', 'Installation Cancelled', 'You can install the app later from browser menu.');
				}
				window.deferredPrompt = null;
			});
		} else {
			// Show manual installation instructions
			this.showToast(
				'info',
				'Manual Installation',
				`To install IPTV Player manually:<br>
				1. Click browser menu (⋮)<br>
				2. Select "Install App" or "Add to Home Screen"<br>
				3. Follow the installation prompts`,
				8000,
			);
		}
	},

	// Handle Service Worker update
	updateServiceWorker() {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.getRegistrations().then((registrations) => {
				if (registrations.length > 0) {
					const registration = registrations[0];
					if (registration.waiting) {
						// Tell the waiting SW to skip waiting
						registration.waiting.postMessage({ type: 'SKIP_WAITING' });

						// Show update message
						this.showToast('success', 'App Updated!', 'App updated successfully! Changes will be applied on next reload.', 5000);

						// Refresh page after a delay
						setTimeout(() => window.location.reload(), 2000);
					} else {
						// Force update check
						registration.update().then(() => {
							this.updateModalStatus();
						});
					}
				}
			});
		}
	},

	// Create and show Bootstrap toast
	showToast(type = 'info', title = '', message = '', delay = 5000, actions = null) {
		const toastId = `toast-${Date.now()}`;

		// Toast type classes
		const typeClasses = {
			success: 'bg-success text-white',
			error: 'bg-danger text-white',
			warning: 'bg-warning text-dark',
			info: 'bg-info text-white',
			primary: 'bg-primary text-white',
		};

		// Toast icons
		const typeIcons = {
			success: 'fas fa-check-circle',
			error: 'fas fa-exclamation-triangle',
			warning: 'fas fa-exclamation-circle',
			info: 'fas fa-info-circle',
			primary: 'fas fa-bell',
		};

		const closeButtonClass = type === 'warning' ? 'btn-close' : 'btn-close btn-close-white';

		let actionsHtml = '';
		const actionHandlers = {};
		if (actions && actions.length > 0) {
			actionsHtml = `
				<div class="mt-2 pt-2 border-top">
					${actions
						.map((action, index) => {
							const actionId = `${toastId}-action-${index}`;
							if (action.action && typeof action.action === 'function') {
								actionHandlers[actionId] = action.action;
							}
							return `
						<button type="button" class="btn btn-sm ${action.class || 'btn-outline-light'} me-2" 
								id="${actionId}">${action.text}</button>
					`;
						})
						.join('')}
				</div>
			`;
		}

		const toastHtml = `
			<div id="${toastId}" class="toast align-items-center ${typeClasses[type] || typeClasses.info} border-0 position-fixed" 
				 style="top: 20px; right: 20px; z-index: 9999; max-width: 400px; min-width: 300px;" role="alert" aria-live="assertive" aria-atomic="true">
				<div class="d-flex">
					<div class="toast-body">
						<div class="d-flex align-items-start">
							<i class="${typeIcons[type] || typeIcons.info} me-2 mt-1"></i>
							<div class="flex-grow-1">
								${title ? `<strong>${title}</strong><br>` : ''}
								${message}
								${actionsHtml}
							</div>
						</div>
					</div>
					<button type="button" class="${closeButtonClass} me-2 m-auto" 
							data-bs-dismiss="toast" aria-label="Close"></button>
				</div>
			</div>
		`;

		// Remove existing toasts of same type to prevent spam
		$(`.toast.${typeClasses[type].split(' ')[0]}`).each(function () {
			const existingToast = bootstrap.Toast.getInstance(this);
			if (existingToast) {
				existingToast.hide();
			}
		});

		$('body').append(toastHtml);
		const toastElement = document.getElementById(toastId);

		// Add action button event handlers
		Object.keys(actionHandlers).forEach((actionId) => {
			const button = document.getElementById(actionId);
			if (button) {
				button.addEventListener('click', () => {
					actionHandlers[actionId]();
					// Close the toast after action
					const toast = bootstrap.Toast.getInstance(toastElement);
					if (toast) {
						toast.hide();
					}
				});
			}
		});

		const bsToast = new bootstrap.Toast(toastElement, {
			delay: delay,
			autohide: delay > 0,
		});

		bsToast.show();

		// Clean up after hidden
		toastElement.addEventListener('hidden.bs.toast', () => {
			toastElement.remove();
		});

		return bsToast;
	},

	// Save current settings from modal UI
	saveCurrentSettings() {
		const defaultCountry = $('#defaultCountrySelect').val();
		const autoplayMuted = $('#autoplayMuted').is(':checked');
		const rememberVolume = $('#rememberVolume').is(':checked');

		const success = this.saveSettings({
			defaultCountry: defaultCountry || null,
			autoplayMuted: autoplayMuted,
			rememberVolume: rememberVolume,
			lastUpdated: Date.now(),
		});

		if (success) {
			this.showToast('success', '', 'Settings saved successfully!');
		}
	},

	// Reset settings to defaults
	resetToDefaults() {
		try {
			localStorage.removeItem(this.STORAGE_KEY);

			// Reset UI
			$('#defaultCountrySelect').val('');
			$('#autoplayMuted').prop('checked', true);
			$('#rememberVolume').prop('checked', false);

			// Show success message
			this.showToast('success', '', 'Settings reset to defaults!');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.STORAGE, 'Resetting settings', true);
		}
	},

	// Populate default country select
	populateDefaultCountrySelect(countries) {
		try {
			const $defaultCountrySelect = $('#defaultCountrySelect');
			const currentSettings = this.getSettings();

			$defaultCountrySelect.empty().append('<option value="">No default (manual selection)</option>');

			countries.forEach((country) => {
				if (country.disabled) return;

				const option = new Option(country.name, country.code.toLowerCase());
				if (currentSettings.defaultCountry === country.code.toLowerCase()) {
					option.selected = true;
				}
				$defaultCountrySelect.append(option);
			});

			// Load audio preferences
			$('#autoplayMuted').prop('checked', currentSettings.autoplayMuted !== false); // Default to true
			$('#rememberVolume').prop('checked', currentSettings.rememberVolume === true); // Default to false

			console.log('Populated default country select and loaded audio preferences');
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.UI, 'Populating settings');
		}
	},

	// Load and apply default settings
	async loadDefaultSettings() {
		try {
			const settings = this.getSettings();
			const { defaultCountry } = settings;

			if (!defaultCountry) {
				// Fallback to US if no default
				$('#countrySelect').val('us').trigger('change');
				return;
			}

			// Check if default country exists in current data
			const countries = appState.getState('countries');
			const countryExists = countries.some((country) => country.code.toLowerCase() === defaultCountry.toLowerCase());

			if (countryExists) {
				console.log('Loading default country:', defaultCountry);
				$('#countrySelect').val(defaultCountry).trigger('change');
			} else {
				console.warn('Default country not found, falling back to US');
				$('#countrySelect').val('us').trigger('change');
			}
		} catch (error) {
			ErrorManager.handle(error, ErrorManager.ERROR_TYPES.VALIDATION, 'Loading default settings');
			// Fallback to US
			$('#countrySelect').val('us').trigger('change');
		}
	},

	// Initialize automatic PWA update checking
	initializeAutoUpdate() {
		// Check for updates every 30 seconds
		this.updateCheckInterval = setInterval(() => {
			this.checkForPWAUpdates();
		}, 30000);

		// Check immediately when the app becomes visible again
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) {
				setTimeout(() => this.checkForPWAUpdates(), 1000);
			}
		});

		// Initial check after 5 seconds
		setTimeout(() => this.checkForPWAUpdates(), 5000);
	},

	// Check for PWA updates automatically
	async checkForPWAUpdates() {
		try {
			if (!('serviceWorker' in navigator)) return;

			const registration = await navigator.serviceWorker.getRegistration();
			if (!registration) return;

			// Force update check
			await registration.update();

			// Check if there's a waiting service worker
			if (registration.waiting) {
				this.handleAvailableUpdate(registration);
			}

			// Listen for new service worker installing
			registration.addEventListener('updatefound', () => {
				const newWorker = registration.installing;
				if (!newWorker) return;

				newWorker.addEventListener('statechange', () => {
					if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
						this.handleAvailableUpdate(registration);
					}
				});
			});
		} catch (error) {
			console.log('PWA update check failed:', error);
		}
	},

	// Handle available PWA update
	handleAvailableUpdate(registration) {
		// Prevent multiple notifications for the same update
		if (this.updateNotificationShown) return;
		this.updateNotificationShown = true;

		this.showToast('primary', 'Update Available', 'A new version of the app is available!', 0, [
			{
				text: 'Update Now',
				action: () => {
					this.applyPWAUpdate(registration);
				},
			},
			{
				text: 'Later',
				action: () => {
					this.updateNotificationShown = false; // Allow notification again later
				},
			},
		]);
	},

	// Apply PWA update
	async applyPWAUpdate(registration) {
		try {
			if (registration.waiting) {
				// Tell the service worker to skip waiting and become active
				registration.waiting.postMessage({ type: 'SKIP_WAITING' });

				// Listen for the service worker to become active
				navigator.serviceWorker.addEventListener('controllerchange', async () => {
					// Get new version from service worker
					const newVersion = await this.getServiceWorkerVersion();

					this.showToast('success', 'Update Complete', `App updated successfully to ${newVersion || 'new version'}! The new version is now active.`, 0, [
						{
							text: 'Reload Page',
							action: () => {
								window.location.reload();
							},
						},
					]);

					// Update header button with new version
					setTimeout(() => {
						this.updateHeaderInstallButtonVersion(newVersion);
					}, 1000);
				});
			}
		} catch (error) {
			console.error('PWA update application failed:', error);
			this.showToast('error', 'Update Failed', 'Update failed. Please refresh the page manually.');
		}
	},

	// Get current service worker version
	async getServiceWorkerVersion() {
		try {
			if (!('serviceWorker' in navigator)) return null;

			const registration = await navigator.serviceWorker.getRegistration();
			if (!registration || !registration.active) return null;

			return new Promise((resolve) => {
				const messageChannel = new MessageChannel();
				messageChannel.port1.onmessage = (event) => {
					resolve(event.data?.version || null);
				};

				registration.active.postMessage({ type: 'GET_VERSION' }, [messageChannel.port2]);

				// Timeout after 2 seconds
				setTimeout(() => resolve(null), 2000);
			});
		} catch (error) {
			console.warn('Failed to get service worker version:', error);
			return null;
		}
	},

	// Update header install button with new version
	updateHeaderInstallButtonVersion(version) {
		try {
			const $headerInstallBtn = $('#headerInstallBtn');
			const $btnText = $headerInstallBtn.find('.btn-text');

			if (version && $headerInstallBtn.hasClass('btn-outline-success')) {
				$btnText.text(version);
				console.log(`Header button updated with new version: ${version}`);
			}
		} catch (error) {
			console.warn('Error updating header button version:', error);
		}
	},

	// Stop automatic update checking (cleanup)
	stopAutoUpdate() {
		if (this.updateCheckInterval) {
			clearInterval(this.updateCheckInterval);
			this.updateCheckInterval = null;
		}
	},
};
