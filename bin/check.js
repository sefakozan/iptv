#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const { default: countries } = await import('../docs/countries.json', {
	with: { type: 'json' },
});

const args = process.argv.slice(2);
if (args.length !== 1) {
	console.error(`arguman hatasi!.. (country|empty)`);
	process.exit(1);
}

if (args[0] === 'empty') {
	// country object to lowercase str array
	const countryCodes = countries.filter((item) => !item.disabled).map((item) => item.code.toLowerCase());
	// get all files name from docs/s dir and remove m3u create str array
	const files = await readdir(join(process.cwd(), 'docs', 's'));
	const m3uFiles = files.filter((file) => extname(file) === '.m3u').map((file) => file.replace('.m3u', ''));

	for (const cc of countryCodes) {
		if (!m3uFiles.includes(cc)) {
			console.log(cc);
		}
	}
} else if (args[0] === 'country') {
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
				method: 'HEAD',
				signal: AbortSignal.timeout(timeout),
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
				},
			});

			if (response.status !== 200) return false;
			return true;
		} catch {
			return false;
		}
	}
} else {
	console.error(`arguman hatasi!.. (country|empty)`);
}
