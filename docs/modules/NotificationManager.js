// NotificationManager.js
// IPTV Player - Advanced Notification Management System
// Optimized Bootstrap Toast Implementation

import { appConfig } from './AppConfig.js';

/**
 * @typedef {Object} NotificationOptions
 * @property {number} [delay] - Toast display duration in milliseconds
 * @property {boolean} [autohide=true] - Whether the toast auto-hides
 * @property {boolean} [animation=true] - Whether to use animation
 * @property {boolean} [isTop=false] - Show toast at top position
 * @property {{ text: string, callback: () => void }} [action] - Action button configuration
 */

/**
 * @typedef {Object} TypeConfig
 * @property {string} icon - Font Awesome icon class
 * @property {string} headerClass - Bootstrap header background class
 */

/**
 * @typedef {Object} NotificationConfig
 * @property {number} defaultDelay - Default toast duration
 * @property {string} position - Toast container position (e.g., 'top-0 end-0')
 * @property {boolean} autohide - Default autohide setting
 * @property {boolean} animation - Default animation setting
 */

/**
 * @enum {string}
 */
const NOTIFICATION_TYPES = Object.freeze({
	SUCCESS: 'success',
	ERROR: 'error',
	WARNING: 'warning',
	INFO: 'info',
	LOADING: 'loading',
	PRIMARY: 'primary'
});

/**
 * NotificationManager - Bootstrap Toast helper (module-level singleton via export)
 */
export class NotificationManager {
	/** @type {HTMLElement|null} */
	#toastContainer = null;

	/** @type {NotificationConfig} */
	#config;

	constructor() {
		this.#config = {
			defaultDelay: 5000,
			position: 'bottom-0 end-0',
			autohide: true,
			animation: true
		};
		this.#initialize();
	}

	#initialize() {
		try {
			this.#createToastContainer();
			this.#log('info', '📢 NotificationManager initialized');
		} catch (error) {
			this.#log('error', '❌ NotificationManager initialization failed', error);
		}
	}

	#createToastContainer() {
		this.#toastContainer = document.getElementById('toastContainer');
		if (!this.#toastContainer) {
			this.#toastContainer = document.createElement('div');
			this.#toastContainer.id = 'toastContainer';
			this.#toastContainer.className = `toast-container position-fixed ${this.#config.position} p-3`;
			this.#toastContainer.style.zIndex = '9999';
			document.body.appendChild(this.#toastContainer);
		}
	}

	/**
	 * Show a notification toast
	 * @param {'success'|'error'|'warning'|'info'|'loading'|'primary'} type
	 * @param {string} title
	 * @param {string} message
	 * @param {NotificationOptions} [options={}]
	 * @returns {bootstrap.Toast|null}
	 */
	show(type, title, message, options = {}) {
		try {
			if (!this.#isValidInput(type, title, message)) {
				throw new TypeError('Invalid parameters: type, title, and message must be non-empty strings');
			}

			if (!this.#toastContainer) this.#createToastContainer();
			if (options.isTop) this.setPosition('top-0 end-0');

			const toast = this.#createToastElement(type, title, message, options);
			this.#toastContainer.appendChild(toast);

			const bsToast = new bootstrap.Toast(toast, {
				delay: options.delay ?? this.#config.defaultDelay,
				autohide: options.autohide ?? (type !== NOTIFICATION_TYPES.LOADING && this.#config.autohide),
				animation: options.animation ?? this.#config.animation
			});

			toast.addEventListener('hidden.bs.toast', () => toast.remove());

			if (options.action) {
				const actionBtn = toast.querySelector('.toast-action-btn');
				if (actionBtn) {
					actionBtn.addEventListener('click', () => {
						options.action.callback?.();
						bsToast.hide();
					});
				}
			}

			bsToast.show();
			return bsToast;
		} catch (error) {
			this.#log('error', '❌ Failed to show notification', error);
			this.#log('info', `[${String(type).toUpperCase()}] ${title}: ${message}`);
			return null;
		}
	}

	#createToastElement(type, title, message, options) {
		const toastId = this.#generateId('toast');
		const typeConfig = this.#getTypeConfig(type);
		const actionHtml = options.action
			? `<button type="button" class="btn btn-sm btn-outline-primary toast-action-btn ms-2">${this.#sanitizeHtml(options.action.text || 'Action')}</button>`
			: '';

		const toastHtml = `
      <div id="${toastId}" class="toast" role="alert" aria-live="assertive" aria-atomic="true">
        <div class="toast-header ${typeConfig.headerClass}">
          <i class="${typeConfig.icon} me-2"></i>
          <strong class="me-auto">${this.#sanitizeHtml(title)}</strong>
          <small class="text-muted">${this.#getTimeString()}</small>
          <button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
        <div class="toast-body">
          ${this.#sanitizeHtml(message)}
          ${actionHtml}
        </div>
      </div>
    `;

		const tempDiv = document.createElement('div');
		tempDiv.innerHTML = toastHtml;
		return /** @type {HTMLElement} */ (tempDiv.firstElementChild);
	}

	#getTypeConfig(type) {
		const configs = {
			[NOTIFICATION_TYPES.SUCCESS]: { icon: 'fas fa-check-circle text-success', headerClass: 'bg-success-subtle' },
			[NOTIFICATION_TYPES.ERROR]: { icon: 'fas fa-exclamation-circle text-danger', headerClass: 'bg-danger-subtle' },
			[NOTIFICATION_TYPES.WARNING]: { icon: 'fas fa-exclamation-triangle text-warning', headerClass: 'bg-warning-subtle' },
			[NOTIFICATION_TYPES.INFO]: { icon: 'fas fa-info-circle text-info', headerClass: 'bg-info-subtle' },
			[NOTIFICATION_TYPES.LOADING]: { icon: 'fas fa-spinner fa-spin text-primary', headerClass: 'bg-primary-subtle' },
			[NOTIFICATION_TYPES.PRIMARY]: { icon: 'fas fa-bell', headerClass: 'bg-primary text-white' }
		};
		return configs[type] || configs[NOTIFICATION_TYPES.INFO];
	}

	#sanitizeHtml(str) {
		const div = document.createElement('div');
		div.textContent = String(str);
		return div.innerHTML;
	}

	#getTimeString() {
		return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
	}

	#generateId(prefix) {
		return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
	}

	#isValidInput(type, title, message) {
		return typeof type === 'string' && type && typeof title === 'string' && title && typeof message === 'string' && message;
	}

	#log(level, message, ...args) {
		console[level](message, ...args);
	}

	success(title, message, options = {}) {
		return this.show(NOTIFICATION_TYPES.SUCCESS, title, message, options);
	}
	error(title, message, options = {}) {
		return this.show(NOTIFICATION_TYPES.ERROR, title, message, options);
	}
	warning(title, message, options = {}) {
		return this.show(NOTIFICATION_TYPES.WARNING, title, message, options);
	}
	info(title, message, options = {}) {
		return this.show(NOTIFICATION_TYPES.INFO, title, message, options);
	}
	loading(title, message, options = {}) {
		return this.show(NOTIFICATION_TYPES.LOADING, title, message, { ...options, autohide: false });
	}
	primary(title, message, options = {}) {
		return this.show(NOTIFICATION_TYPES.PRIMARY, title, message, { ...options, autohide: false });
	}
	persistent(type, title, message, options = {}) {
		return this.show(type, title, message, { ...options, autohide: false });
	}

	clearAll() {
		try {
			const toasts = this.#toastContainer?.querySelectorAll('.toast') ?? [];
			for (const toast of toasts) {
				const bsToast = bootstrap.Toast.getInstance(toast);
				bsToast ? bsToast.hide() : toast.remove();
			}
		} catch (error) {
			this.#log('error', '❌ Failed to clear notifications', error);
		}
	}

	setPosition(position) {
		try {
			if (!this.#toastContainer) return;
			this.#toastContainer.className = `toast-container position-fixed ${position} p-3`;
			this.#toastContainer.style.zIndex = '9999';
			this.#config.position = position;
		} catch (error) {
			this.#log('error', '❌ Failed to update notification position', error);
		}
	}

	getCount() {
		return this.#toastContainer?.querySelectorAll('.toast').length ?? 0;
	}

	online() {
		this.success("You're Back Online", 'Internet connection restored.');
	}
	offline() {
		this.warning('Connection Lost', 'Your internet connection has been lost. Please check your network.');
	}
	installed() {
		this.primary('App Installed', 'Your app is installed and ready to use from your home screen!');
	}
	updated() {
		this.success('App Updated!', 'App updated successfully! Changes will be applied on next reload.', { delay: 5000 });
	}
	manual() {
		this.info(
			'Manual Installation',
			`To install IPTV Player manually:<br>1. Click browser menu (⋮)<br>2. Select "Install App" or "Add to Home Screen"<br>3. Follow the installation prompts`,
			{ delay: 8000, isTop: true }
		);
	}
}

export const notificationManager = new NotificationManager();

// Dev’de global erişim (export adıyla, window.iptv altında)
if (appConfig.isDevelopment && typeof window !== 'undefined') {
	window.iptv = window.iptv || {};
	window.iptv.notificationManager = notificationManager;
}
