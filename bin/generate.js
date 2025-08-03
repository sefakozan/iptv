#!/usr/bin/env node
import { readdir, readFile, writeFile } from "fs/promises";
import { merger } from "iptv-util";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";

// İlk iki elemanı atla (node ve betik yolu)
const args = process.argv.slice(2);

const lang = args[0];

if (!lang) {
	console.error(`arguman olarak dil vermelisiniz!.. (tr|uk|us|az)`);
}

console.log("lang:", lang);

// __filename benzeri: Mevcut dosyanın yolunu al
const __filename = fileURLToPath(import.meta.url);
// __dirname benzeri: Mevcut dosyanın dizin yolunu al
const __dirname = dirname(__filename);

// console.log("Dosya yolu:", __filename);
// console.log("Dizin yolu:", __dirname);

const target = resolve(__dirname, "..", "docs", `${lang}.m3u`);
const langRawFolder = resolve(__dirname, "..", "raw-streams", lang);
const readme = resolve(langRawFolder, "README.md");

const linkArr = await getNonCommentedLines(readme);
const textArr = await getM3UFileContents(langRawFolder);

const fullList = await merger(...linkArr, ...textArr);
const cleanList = await fullList.check();

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
		const lines = content.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

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
