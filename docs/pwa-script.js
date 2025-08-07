// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
	window.addEventListener('load', () => {
		navigator.serviceWorker
			.register('./sw.js')
			.then((registration) => {
				console.log('✅ PWA Service Worker registered successfully:', registration);

				// Check for updates
				registration.addEventListener('updatefound', () => {
					const newWorker = registration.installing;
					newWorker.addEventListener('statechange', () => {
						if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
							// Show update notification
							console.log('🔄 New version available, refresh to update');
							showUpdateNotification();
						}
					});
				});
			})
			.catch((error) => {
				console.log('❌ PWA Service Worker registration failed:', error);
			});
	});
}

// Show update notification
function showUpdateNotification() {
	const notification = document.createElement('div');
	notification.style.cssText = `
		position: fixed;
		top: 20px;
		right: 20px;
		background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
		color: white;
		padding: 1rem 1.5rem;
		border-radius: 12px;
		box-shadow: 0 10px 25px rgba(0,0,0,0.15);
		z-index: 10000;
		font-family: "Inter", sans-serif;
		font-size: 0.9rem;
		cursor: pointer;
		transition: all 0.3s ease;
	`;
	notification.innerHTML = `
		<div style="display: flex; align-items: center; gap: 0.75rem;">
			<i class="fas fa-download" style="font-size: 1.1rem;"></i>
			<div>
				<div style="font-weight: 600;">Update Available</div>
				<div style="font-size: 0.8rem; opacity: 0.9;">Click to refresh and update</div>
			</div>
		</div>
	`;

	notification.addEventListener('click', () => {
		window.location.reload();
	});

	document.body.appendChild(notification);

	// Auto-hide after 10 seconds
	setTimeout(() => {
		if (notification.parentNode) {
			notification.style.transform = 'translateX(100%)';
			setTimeout(() => notification.remove(), 300);
		}
	}, 10000);
}

// Install PWA prompt handling
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
	console.log('💿 PWA install prompt available');
	e.preventDefault();
	deferredPrompt = e;
	showHeaderInstallButton();
	showInstallButton();
});

// Show header install button
function showHeaderInstallButton() {
	const headerInstallBtn = document.getElementById('headerInstallBtn');
	if (headerInstallBtn) {
		// Always show for testing - remove d-none if exists
		headerInstallBtn.classList.remove('d-none');
		headerInstallBtn.style.display = 'inline-flex';

		headerInstallBtn.addEventListener('click', async () => {
			if (deferredPrompt) {
				deferredPrompt.prompt();
				const { outcome } = await deferredPrompt.userChoice;
				console.log(`PWA install prompt outcome: ${outcome}`);

				if (outcome === 'accepted') {
					headerInstallBtn.classList.add('d-none');
					// Hide bottom install button too
					const bottomInstallBtn = document.querySelector('[style*="bottom: 20px"]');
					if (bottomInstallBtn) bottomInstallBtn.remove();
				}

				deferredPrompt = null;
			} else {
				// Fallback if no install prompt available
				alert('PWA install not available in this browser or already installed!');
			}
		});
	}
}

// Show install button (bottom floating)
function showInstallButton() {
	const installBtn = document.createElement('button');
	installBtn.style.cssText = `
		position: fixed;
		bottom: 20px;
		right: 20px;
		background: linear-gradient(135deg, #10b981 0%, #059669 100%);
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
	`;
	installBtn.innerHTML = `
		<i class="fas fa-download"></i>
		Install App
	`;

	installBtn.addEventListener('click', async () => {
		if (deferredPrompt) {
			deferredPrompt.prompt();
			const { outcome } = await deferredPrompt.userChoice;
			console.log(`PWA install prompt outcome: ${outcome}`);
			deferredPrompt = null;
			installBtn.remove();
		}
	});

	installBtn.addEventListener('mouseenter', () => {
		installBtn.style.transform = 'translateY(-2px)';
		installBtn.style.boxShadow = '0 15px 35px rgba(0,0,0,0.2)';
	});

	installBtn.addEventListener('mouseleave', () => {
		installBtn.style.transform = 'translateY(0)';
		installBtn.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
	});

	document.body.appendChild(installBtn);

	// Auto-hide after 15 seconds
	setTimeout(() => {
		if (installBtn.parentNode) {
			installBtn.style.transform = 'translateY(100px)';
			setTimeout(() => installBtn.remove(), 300);
		}
	}, 15000);
}

$(document).ready(() => {
	// Show header install button immediately for testing
	showHeaderInstallButton();
});
