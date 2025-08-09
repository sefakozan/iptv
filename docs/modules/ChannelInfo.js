class ChannelInfo {
	// Kanal bilgi panelini güncelle
	updateChannelInfo(message, channel = null) {
		try {
			const $channelInfo = $('#channelInfo');

			if (!channel) {
				$channelInfo.html(`<p class="mb-0">${message}</p>`);
				return;
			}

			const logoHtml = channel.logo
				? `<img src="${channel.logo}" 
                     alt="Logo" 
                     style="max-height:38px; max-width:60px; object-fit:contain; 
                            filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5)); 
                            background:#23272f; border-radius:0.3rem; flex-shrink:0;" 
                     onerror="this.style.display='none'">`
				: '';

			$channelInfo.html(`
                <div style="display:flex; align-items:center; gap:1rem; min-height:40px;">
                    ${logoHtml}
                    <div style="flex:1 1 0; min-width:0;">
                        <div style="font-weight:600; font-size:1.1rem;">${channel.name}</div>
                        <div class="url-clip" 
                             title="${channel.url}" 
                             style="color:#8fd3ff; font-size:0.98rem; word-break:break-all;">
                            ${channel.url}
                        </div>
                    </div>
                </div>
            `);
		} catch (error) {
			console.error('Updating channel info', error);
		}
	}
}

export const channelInfo = new ChannelInfo();
