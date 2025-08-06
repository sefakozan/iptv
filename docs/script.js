// Global variables
let countriesData = [];
let channelsData = [];
let hls = null;
const cache = new Map();

// Initialize when document is ready
$(document).ready(() => {
	// Initialize Select2 for country selection
	$("#countrySelect").select2({
		placeholder: "Select a country",
		allowClear: false,
		language: {
			searching: () => "Type to search for a country...",
			inputTooShort: () => "Type to search for a country...",
			noResults: () => "No country found",
		},
		templateResult: (state) => {
			if (!state.id) return state.text;
			const flagUrl = $(state.element).data("flag");
			if (flagUrl) {
				return $('<span><img src="' + flagUrl + '" /> ' + state.text + "</span>");
			}
			return state.text;
		},
		templateSelection: (state) => {
			if (!state.id) return state.text;
			const flagUrl = $(state.element).data("flag");
			if (flagUrl) {
				// Aspect ratio bozulmasın diye style ekliyoruz
				return $(
					'<span><img src="' +
						flagUrl +
						'" style="width:1.5em;height:auto;aspect-ratio:4/3;vertical-align:middle;margin-right:0.5em;border-radius:0.2em;box-shadow:0 1px 2px rgba(0,0,0,0.08);" /> ' +
						state.text +
						"</span>",
				);
			}
			return state.text;
		},
	});

	// Select2 search input placeholder
	$("#countrySelect").on("select2:open", () => {
		setTimeout(() => {
			const searchBox = document.querySelector(".select2-search__field");
			if (searchBox) {
				searchBox.placeholder = "Type to search for a country...";
			}
		}, 0);
	});

	// Load countries data
	loadCountries();

	// Event handlers
	$("#countrySelect").on("change", handleCountryChange);
	$("#channelList").on("change", handleChannelChange);

	// Settings panel event handlers
	$("#settingsBtn").on("click", showSettingsPanel);
	$("#closeSettingsBtn").on("click", hideSettingsPanel);
	$("#saveSettingsBtn").on("click", saveSettings);

	// Global klavye event handler'ları
	$(document).on("keydown", (e) => {
		// Tab tuşu ile rastgele ülke seç
		if (e.key === "Tab") {
			e.preventDefault();

			// Ülke seçenek listesinden rastgele birini seç
			const countrySelect = $("#countrySelect");
			const options = countrySelect.find("option").not(":first"); // İlk boş option'ı hariç tut

			if (options.length > 0) {
				const randomOptionIndex = Math.floor(Math.random() * options.length);
				const randomOption = options.eq(randomOptionIndex);
				countrySelect.val(randomOption.val()).trigger("change");
			}

			return;
		}

		// Sağ-sol ok tuşları ile ülke değiştirme (global)
		if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
			if (countriesData.length === 0) return; // Ülke yoksa çık

			e.preventDefault();
			const currentValue = $("#countrySelect").val();
			const options = $("#countrySelect").find("option").not(":first"); // İlk boş option'ı hariç tut
			let currentIndex = -1;

			// Mevcut seçili ülkenin index'ini bul
			options.each(function (index) {
				if ($(this).val() === currentValue) {
					currentIndex = index;
					return false;
				}
			});

			let newIndex;
			if (e.key === "ArrowLeft") {
				// Sol ok: önceki ülke
				newIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
			} else {
				// Sağ ok: sonraki ülke
				newIndex = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
			}

			const newValue = options.eq(newIndex).val();
			$("#countrySelect").val(newValue).trigger("change");
		}
		// Alt-üst ok tuşları ile kanal değiştirme (global)
		else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			const channelList = $("#channelList");
			const availableOptions = channelList.find("option").filter(function () {
				return $(this).val() !== "";
			});

			if (availableOptions.length === 0) return; // Kanal yoksa çık

			e.preventDefault();
			const currentValue = channelList.val();
			let currentIndex = -1;

			// Mevcut seçili kanalın filtrelenmiş listede index'ini bul
			availableOptions.each(function (index) {
				if ($(this).val() === currentValue) {
					currentIndex = index;
					return false;
				}
			});

			let newIndex;
			if (e.key === "ArrowUp") {
				// Yukarı ok: önceki kanal
				newIndex = currentIndex > 0 ? currentIndex - 1 : availableOptions.length - 1;
			} else {
				// Aşağı ok: sonraki kanal
				newIndex = currentIndex < availableOptions.length - 1 ? currentIndex + 1 : 0;
			}

			const newValue = availableOptions.eq(newIndex).val();
			channelList.val(newValue).trigger("change");
		}
	});
});

// Load countries from JSON file
async function loadCountries() {
	try {
		console.log("Loading countries...");
		const response = await fetch("countries.json");
		countriesData = await response.json();
		console.log("Countries loaded:", countriesData.length);

		// Populate country select
		const countrySelect = $("#countrySelect");
		countriesData.forEach((country) => {
			// Bayrak url'si flagcdn.io üzerinden
			const code = country.code.toLowerCase();
			// UK için özel flag
			const flagCode = code === "uk" ? "gb" : code;
			const flagUrl = `https://flagcdn.com/w20/${flagCode}.png`;
			countrySelect.append(new Option(`${country.name} (${country.code.toUpperCase()})`, code));
			// Option elementine data-flag ekle
			countrySelect.find(`option[value='${code}']`).attr("data-flag", flagUrl);
		});

		// Populate settings panel default country select
		console.log("Populating default country select...");
		populateDefaultCountrySelect();

		// Wait a bit for Select2 to be fully ready, then load default country
		setTimeout(() => {
			console.log("Loading default country...");
			loadDefaultCountry();
		}, 100);
	} catch (error) {
		console.error("Error loading countries:", error);
		alert("Failed to load countries data");
	}
}

// Handle country selection change
function handleCountryChange() {
	const selectedCountry = $(this).val();
	console.log("Country changed to:", selectedCountry);

	if (selectedCountry) {
		$("#channelList").prop("disabled", false).html('<option value="">Loading channels...</option>');
		$("#channelInfo").html('<p class="mb-0">No channel selected</p>');
		stopStream();

		// Automatically load channels for the selected country
		console.log("Loading channels for:", selectedCountry);
		loadChannels();
	} else {
		$("#channelList").prop("disabled", true).html('<option value="">Select a country first</option>');
	}
}

// Load channels for selected country
async function loadChannels() {
	const selectedCountry = $("#countrySelect").val();
	if (!selectedCountry) return;

	try {
		// Show loading state
		$("#channelList").prop("disabled", true).html('<option value="">Loading channels...</option>');

		let m3uUrl = `https://sefakozan.github.io/iptv/s/${selectedCountry}.m3u`;

		const res = await fetch(m3uUrl, { method: "HEAD" });
		if (!res.ok) {
			m3uUrl = `https://raw.githubusercontent.com/iptv-org/iptv/refs/heads/gh-pages/countries/${selectedCountry}.m3u`;
		}

		// Fetch M3U data

		if (cache.has(m3uUrl)) {
			channelsData = cache.get(m3uUrl);
		} else {
			// Fetch M3U data
			const response = await fetch(m3uUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch M3U data: ${response.status}`);
			}

			const m3uData = await response.text();

			// Parse M3U data
			channelsData = parseM3U(m3uData);

			// Cache the channels data
			cache.set(m3uUrl, channelsData);
		}

		// Populate channel list
		const channelList = $("#channelList");
		const channelSearch = $("#channelSearch");
		channelList.empty();

		channelsData.forEach((channel, index) => {
			const option = new Option(channel.name, index);
			if (channel.logo) {
				// Set logo as background image for the option
				$(option).css({
					"background-image": `url(${channel.logo})`,
					"background-repeat": "no-repeat",
					"background-position": "8px center",
					"background-size": "24px 24px",
					"padding-left": "40px",
				});
			}
			channelList.append(option);
		});

		// Enable channel list and search
		channelList.prop("disabled", false);
		channelSearch.prop("disabled", false).val("");

		// Otomatik olarak ilk kanalı sadece ilk yüklemede seçme
		if (window._iptvFirstLoad === undefined) {
			window._iptvFirstLoad = false;
			// İlk yüklemede hiçbir kanal seçilmesin
			channelList.val("").trigger("change");
		} else {
			// Sonraki ülke değişimlerinde ilk kanalı seç
			if (channelsData.length > 0) {
				channelList.val("0").trigger("change");
			} else {
				alert("No channels found for this country");
			}
		}
	} catch (error) {
		console.error("Error loading channels:", error);
		alert(`Failed to load channels: ${error.message}`);
		// Reset UI
		$("#channelList").prop("disabled", false).html('<option value="">Select a country first</option>');
		$("#channelSearch").prop("disabled", true).val("");
	}
	// Channel search filtering
	$("#channelSearch").on("input", function () {
		const q = $(this).val().toLowerCase();
		const channelList = $("#channelList");
		channelList.empty();
		let found = false;
		channelsData.forEach((channel, index) => {
			if (channel.name.toLowerCase().includes(q)) {
				const option = new Option(channel.name, index);
				if (channel.logo) {
					// Set logo as background image for the option
					$(option).css({
						"background-image": `url(${channel.logo})`,
						"background-repeat": "no-repeat",
						"background-position": "8px center",
						"background-size": "24px 24px",
						"padding-left": "40px",
					});
				}
				channelList.append(option);
				found = true;
			}
		});
		if (!found) {
			channelList.append(new Option("No channel found", ""));
		}
		// Otomatik ilk kanal seçimi (varsa)
		if (channelList[0].options.length > 0 && channelList[0].options[0].value !== "") {
			channelList.val(channelList[0].options[0].value).trigger("change");
		} else {
			$("#channelInfo").html('<p class="mb-0">No channel selected</p>');
			stopStream();
		}
	});
}

// Parse M3U data
function parseM3U(m3uData) {
	const channels = [];
	const playlist = IptvUtil.parser(m3uData);

	for (const item of playlist.links) {
		if (!item.url?.includes(".m3u8")) continue;
		if (item.url?.startsWith("http\:")) continue;
		try {
			// Validate URL
			new URL(item.url);
		} catch {
			continue;
		}

		if (item.title) {
			channels.push({
				name: item.title,
				url: item.url,
				logo: item?.extinf["tvg-logo"] || "",
			});
		}
	}

	return channels;
}

// Handle channel selection change
function handleChannelChange() {
	const selectedIndices = $(this).val();

	if (selectedIndices) {
		// Get the first selected index (in case multiple are selected)
		const selectedIndex = parseInt(selectedIndices);
		const channel = channelsData[selectedIndex];

		// Display channel info: logo, name, and url on the same row
		let logoHtml = "";
		if (channel.logo) {
			logoHtml = `<img src="${channel.logo}" alt="Logo" style="max-height:38px;max-width:60px;object-fit:contain;filter:drop-shadow(0 2px 6px #0008);background:#23272f;border-radius:0.3em;flex-shrink:0;" onerror="this.style.display='none'">`;
		}
		$("#channelInfo").html(`
            <div style="display:flex;align-items:center;gap:1em;min-height:40px;">
                ${logoHtml}
                <div style="flex:1 1 0;min-width:0;">
                    <span style="font-weight:600;font-size:1.1em;">${channel.name}</span>
                    <span class="url-clip" title="${channel.url}" style="color:#8fd3ff;font-size:0.98em;">${channel.url}</span>
                </div>
            </div>
        `);
		// Otomatik olarak kanalı çal
		playStream();
	} else {
		$("#channelInfo").html('<p class="mb-0">No channel selected</p>');
		stopStream();
	}
}

// Play selected stream
function playStream() {
	const selectedIndices = $("#channelList").val();
	if (!selectedIndices) return;

	// Get the first selected index (in case multiple are selected)
	const selectedIndex = parseInt(selectedIndices);
	const channel = channelsData[selectedIndex];
	const video = document.getElementById("videoPlayer");

	// Stop any existing stream
	stopStream();

	if (Hls.isSupported()) {
		hls = new Hls();
		hls.loadSource(channel.url);
		hls.attachMedia(video);
		hls.on(Hls.Events.MANIFEST_PARSED, () => {
			video
				.play()
				.then(() => {})
				.catch((error) => {
					console.error("Error playing video:", error);
				});
		});
		hls.on(Hls.Events.ERROR, (_, data) => {
			console.error("HLS error:", data);
			console.error(`Streaming error: ${data.type} - ${data.details}`);
		});
	} else if (video.canPlayType("application/vnd.apple.mpegurl")) {
		// For Safari
		video.src = channel.url;
		video.addEventListener("loadedmetadata", () => {
			video.play();
		});
	} else {
		alert("HLS is not supported in your browser");
	}
}

// Stop current stream
function stopStream() {
	const video = document.getElementById("videoPlayer");

	if (hls) {
		hls.destroy();
		hls = null;
	}

	video.pause();
	video.src = "";
}

// Settings Panel Functions
function showSettingsPanel() {
	console.log("Settings panel opening...");
	$("#settingsPanel").slideDown(300);
}

function hideSettingsPanel() {
	$("#settingsPanel").slideUp(300);
}

function saveSettings() {
	console.log("Save settings clicked");
	const defaultCountry = $("#defaultCountrySelect").val();
	console.log("Selected default country:", defaultCountry);

	// Save to localStorage
	if (defaultCountry) {
		localStorage.setItem("iptvDefaultCountry", defaultCountry);
		console.log("Saved to localStorage:", defaultCountry);
		alert("Settings saved! The default country will be selected on next page load.");
	} else {
		localStorage.removeItem("iptvDefaultCountry");
		console.log("Removed from localStorage");
		alert("Settings saved! No default country will be selected.");
	}

	hideSettingsPanel();
}

function loadDefaultCountry() {
	const defaultCountry = localStorage.getItem("iptvDefaultCountry");
	console.log("Loading default country:", defaultCountry);

	if (defaultCountry && countriesData.length > 0) {
		// Check if the country still exists in the data
		const countryExists = countriesData.some((country) => country.code.toLowerCase() === defaultCountry.toLowerCase());
		console.log("Country exists:", countryExists);
		if (countryExists) {
			// Use Select2's proper way to set value
			$("#countrySelect").val(defaultCountry.toLowerCase()).trigger("change");
			console.log("Set default country:", defaultCountry.toLowerCase());
			return;
		}
	}

	// Fallback to US if no default is set or default country doesn't exist
	console.log("Fallback to US");
	$("#countrySelect").val("us").trigger("change");
}

function populateDefaultCountrySelect() {
	console.log("populateDefaultCountrySelect called");
	const defaultCountrySelect = $("#defaultCountrySelect");
	const currentDefault = localStorage.getItem("iptvDefaultCountry");
	console.log("Current default from localStorage:", currentDefault);

	// Clear existing options except the first one
	defaultCountrySelect.find("option:not(:first)").remove();

	// Add country options
	countriesData.forEach((country) => {
		const option = new Option(country.name, country.code.toLowerCase());
		if (currentDefault && country.code.toLowerCase() === currentDefault.toLowerCase()) {
			option.selected = true;
		}
		defaultCountrySelect.append(option);
	});
	console.log("Default country select populated with", countriesData.length, "countries");
}
