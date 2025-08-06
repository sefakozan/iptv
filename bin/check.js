#!/usr/bin/env node
const { default: countries } = await import("../docs/countries.json", {
	with: { type: "json" },
});

for (const item of countries) {
	const code = item.code.toLocaleLowerCase();
	const defaultLink = `https://raw.githubusercontent.com/iptv-org/iptv/refs/heads/gh-pages/countries/${code}.m3u`;
	const isExist = await isCountryExist(defaultLink);

	if (!isExist && item.disabled !== true) {
		console.log(code);
	}
}

async function isCountryExist(url, timeout = 8000) {
	try {
		const response = await fetch(url, {
			method: "HEAD",
			signal: AbortSignal.timeout(timeout),
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
			},
		});

		if (response.status !== 200) return false;
		return true;
	} catch {
		return false;
	}
}
