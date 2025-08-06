#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { merger } from "iptv-util";

const { default: countries } = await import("../docs/countries.json", {
	assert: { type: "json" },
});

// İlk iki elemanı atla (node ve betik yolu)
const args = process.argv.slice(2);

const country = args[0].toLowerCase();

if (!country) {
	console.error(`arguman olarak ulke vermelisiniz!.. (tr|us|uk|es|fr|de|ru|az|ar|it|in|cn)`);
	process.exit(1);
}

console.log("country:", country);
if (country.length !== 2) {
	console.error("ulke kodu 2 karekter olmali");
	process.exit(2);
}

const defaultLink = `https://raw.githubusercontent.com/iptv-org/iptv/refs/heads/gh-pages/countries/${country}.m3u`;
const liveTVCollectorLink = await GetLiveTVCollectorLink(country);

const isCodeExist = await isCountryExist(defaultLink);

if (!isCodeExist) {
	console.error("ulke kodu tanimli degil");
	process.exit(3);
}

// __filename benzeri: Mevcut dosyanın yolunu al
const __filename = fileURLToPath(import.meta.url);
// __dirname benzeri: Mevcut dosyanın dizin yolunu al
const __dirname = dirname(__filename);

// console.log("Dosya yolu:", __filename);
// console.log("Dizin yolu:", __dirname);

const target = resolve(__dirname, "..", "docs", "s", `${country}.m3u`);
const langRawFolder = resolve(__dirname, "..", "raw-streams", country);
const readme = resolve(langRawFolder, "README.md");
const sort = resolve(langRawFolder, "SORT.md");

const sortArr = await getNonCommentedLines(sort);
const linkArr = await getNonCommentedLines(readme);
const textArr = await getM3UFileContents(langRawFolder);

if (!linkArr.includes(defaultLink)) {
	linkArr.push(defaultLink);
}

if (!linkArr.includes(liveTVCollectorLink) && liveTVCollectorLink) {
	linkArr.push(defaultLink);
}

const fullList = await merger(...linkArr, ...textArr);
const cleanList = await fullList.check(10000, true);

//sort işlemi
if (sortArr.length > 0) {
	cleanList.links.sort((a, b) => {
		let aval = 0;
		let bval = 0;

		for (const str of sortArr) {
			if (a.title.includes(str)) aval = 100;
			if (b.title.includes(str)) bval = 100;
		}

		return bval - aval;
	});
}

const cleanText = cleanList.toText();
await writeTarget(target, cleanText);

async function getM3UFileContents(directoryPath) {
	try {
		// Dizindeki tüm dosyaları oku
		const files = await readdir(directoryPath);

		// Sadece .m3u uzantılı dosyaları filtrele
		const m3uFiles = files.filter((file) => extname(file).toLowerCase() === ".m3u");

		// Her .m3u dosyasının içeriğini oku
		const results = await Promise.all(
			m3uFiles.map(async (file) => {
				const filePath = join(directoryPath, file);
				const content = await readFile(filePath, "utf8");
				return content;
			}),
		);

		return results;
	} catch (error) {
		console.error("Hata:", error.message);
		return [];
	}
}

async function getNonCommentedLines(filePath) {
	try {
		// Dosyayı asenkron olarak oku (utf8 formatında)
		const content = await readFile(filePath, "utf8");

		// Satırlara böl ve # ile başlamayanları filtrele
		//const lineArr = text.split(/\s*\r*\n+\s*/gm);
		const lines = content.split(/\s*\r*\n+\s*/gm).filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

		return lines;
	} catch (error) {
		console.error("Hata:", error.message);
		return [];
	}
}

async function writeTarget(filePath, data) {
	try {
		// Dosyaya yaz (üzerine yazar)
		await writeFile(filePath, data, "utf8");
		console.log(`Dosya başarıyla yazıldı: ${filePath}`);
	} catch (error) {
		console.error("Hata:", error.message);
		throw error;
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

async function GetLiveTVCollectorLink(country) {
	let link = "";

	//https://raw.githubusercontent.com/bugsfreeweb/LiveTVCollector/refs/heads/main/LiveTV/Turkey/LiveTV.m3u
	//const isCodeExist = await isCountryExist(defaultLink);

	for (const el of countries) {
		if (el.code.toLowerCase() === country.toLowerCase()) {
			const name = el.name;
			link = `https://raw.githubusercontent.com/bugsfreeweb/LiveTVCollector/refs/heads/main/LiveTV/${name}/LiveTV.m3u`;
			const isCodeExist = await isCountryExist(link);
			if (isCodeExist) {
				return link;
			}

			if (!el.alternatives) return link;

			for (const altName of el.alternatives) {
				link = `https://raw.githubusercontent.com/bugsfreeweb/LiveTVCollector/refs/heads/main/LiveTV/${altName}/LiveTV.m3u`;
				const isCodeExist = await isCountryExist(link);
				if (isCodeExist) {
					return link;
				}
			}
		}
	}

	return link;
}
