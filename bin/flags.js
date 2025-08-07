#!/usr/bin/env node

/**
 * Flag conversion utilities for IPTV player
 * Converts country codes and flag emojis to Twitter emoji SVG URLs
 */

const { default: countries } = await import('../docs/countries.json', {
	with: { type: 'json' },
});

for (const country of countries) {
	const flagUrl1 = cc2flag(country.code, false);
	const flagUrl2 = emoji2flag(country.flag);
	if (flagUrl1 !== flagUrl2) {
		console.log(`Mismatch for ${country.name}`);
	}
}

/**
 * Convert country code to Twitter emoji flag URL with fallback options
 * @param {string} countryCode - 2-letter country code (e.g., 'TR', 'US')
 * @param {boolean} useLocal - Use local fallback if available (default: false)
 * @returns {string} Twitter emoji SVG URL or local fallback
 */
function cc2flag(countryCode, useLocal = false) {
	if (!countryCode || countryCode.length !== 2) {
		return '';
	}

	// Convert country code to uppercase
	const code = countryCode.toUpperCase();

	// Regional Indicator Symbol offset
	const offset = 0x1f1e6 - 0x41; // U+1F1E6 (A) - 0x41 (A)

	// Get Unicode code points for each character
	const first = code.charCodeAt(0) + offset;
	const second = code.charCodeAt(1) + offset;

	// Convert to hex strings (lowercase)
	const firstHex = first.toString(16);
	const secondHex = second.toString(16);

	// Local fallback option (if you decide to download later)
	if (useLocal) {
		return `./assets/flags/${code.toLowerCase()}.svg`;
	}

	// Twitter CDN (recommended for IPTV - fast & always updated)
	return `https://abs-0.twimg.com/emoji/v2/svg/${firstHex}-${secondHex}.svg`;
}

/**
 * Convert flag emoji to Twitter emoji flag URL
 * @param {string} flagEmoji - Flag emoji (e.g., '🇹🇷', '🇺🇸')
 * @returns {string} Twitter emoji SVG URL
 */
function emoji2flag(flagEmoji) {
	if (!flagEmoji) return '';

	// Convert flag emoji to array of code points
	const codePoints = Array.from(flagEmoji).map((char) => char.codePointAt(0).toString(16));

	// Join with hyphens for Twitter URL format
	return `https://abs-0.twimg.com/emoji/v2/svg/${codePoints.join('-')}.svg`;
}

// Export functions for module usage
//export { cc2flag, emoji2flag };
