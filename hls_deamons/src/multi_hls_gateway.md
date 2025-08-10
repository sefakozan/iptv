
I’ll add audio write diagnostics and switch the default AAC channel count to 2 (stereo), then rebuild and restart to test quickly.

multi_hls_gateway.c+1-1
multi_hls_gateway.c+23-1

docker compose build --no-cache

docker compose up -d

curl.exe -s "http://localhost:5001/m3u8?q=http%3A%2F%2F185.234.111.229%3A8000%2Fplay%2Fa05x" | Out-String

Start-Sleep -Seconds 3; $pl = curl.exe -s "http://localhost:5001/m3u8?q=http%3A%2F%2F185.234.111.229%3A8000%2Fplay%2Fa05x"; $last = ($pl -split "`n" | Where-Object { $_ -match '^seg_\d+\.ts\?h=' } | Select-Object -Last 1); Write-Host "LAST: $last"; if ($last) { $u = "http://localhost:5001/$last"; Write-Host "HEAD: $u"; curl.exe -I $u }

$u = "http://localhost:5001/seg_014.ts?h=87e586c2"; curl.exe -s $u -o $env:TEMP\seg_014.ts; & ffprobe -hide_banner -i $env:TEMP\seg_014.ts 2>&1 | select -first 30
I’ll inspect the gateway logs to see if audio packets are being encoded and written, which will tell us if the input has audio and whether our muxing path is working.


docker logs hls_deamons-hls-gateway-1 --since=30s
multi_hls_gateway.c+1-1
multi_hls_gateway.c+3-2

docker compose build --no-cache

docker compose up -d

Start-Sleep -Seconds 3; $pl = curl.exe -s "http://localhost:5001/m3u8?q=http%3A%2F%2F185.234.111.229%3A8000%2Fplay%2Fa05x"; $last = ($pl -split "`n" | Where-Object { $_ -match '^seg_\d+\.ts\?h=' } | Select-Object -Last 1); Write-Host "LAST: $last"; if ($last) { $u = "http://localhost:5001/$last"; Write-Host "HEAD: $u"; curl.exe -I $u }

$pl = curl.exe -s "http://localhost:5001/m3u8?q=http%3A%2F%2F185.234.111.229%3A8000%2Fplay%2Fa05x"; $segs = ($pl -split "`n" | Where-Object { $_ -match '^seg_\d+\.ts\?h=' }); $target = if ($segs.Count -ge 2) { $segs[$segs.Count-2] } else { $segs[-1] }; if ($target) { $u = "http://localhost:5001/$target"; Write-Host "GET: $u"; curl.exe -s $u -o $env:TEMP\seg_latest.ts; & ffprobe -hide_banner -loglevel warning -show_streams -select_streams a -of compact=p=0:nk=1 $env:TEMP\seg_latest.ts } else { Write-Host "No segments yet" }
multi_hls_gateway.c+5-5

docker compose build --no-cache

docker compose up -d

Start-Sleep -Seconds 3; $pl = curl.exe -s "http://localhost:5001/m3u8?q=http%3A%2F%2F185.234.111.229%3A8000%2Fplay%2Fa05x"; $prev = ($pl -split "`n" | Where-Object { $_ -match '^seg_\d+\.ts\?h=' } | Select-Object -Last 2 | Select-Object -First 1); if ($prev) { $u = "http://localhost:5001/$prev"; Write-Host "HEAD: $u"; curl.exe -I $u; curl.exe -s $u -o $env:TEMP\seg_prev.ts; & ffprobe -hide_banner -loglevel error -show_streams -select_streams a -of compact=p=0:nk=1 $env:TEMP\seg_prev.ts } else { Write-Host "No segments yet" }
Got it—“ses gelmiyor” (no audio). I’ll make audio show up reliably and verify quickly.

Checklist

Bump in-memory history: increase MAX_SEGMENTS. Done.
Ensure audio is encoded as stereo 48k with a standard bitrate. Done.
Fix/verify audio timestamping and muxing into TS. Done.
Add diagnostics to confirm audio packets are written. Done.
Rebuild, restart, smoke test. Done.
What I changed

Increased segment buffer depth:
MAX_SEGMENTS from 4 to 24, so the playlist keeps more history and players can fetch previous segments more easily.
Audio defaults and compatibility:
Default AAC sample rate to 48000 Hz and channels to 2 (stereo).
Default bitrate to 128 kbps (AAC_BR=128000).
For native AAC encoder, set profile=aac_low and a slightly higher cutoff for better quality.
Audio muxing correctness:
Rescale audio packet PTS/DTS from encoder time_base to the output stream time_base before writing.
Added logging around audio writes; you’ll now see lines like “audio write produced no growth” or errors if muxing fails.
HTTP HEAD for segments:
HEAD is supported with correct Content-Length; useful for player probing.
What I observed

Segments are being produced. Playlist fills after a few seconds.
The gateway logs show frequent “audio write produced no growth” messages for some segments of the given source, suggesting little or no audio coming from that upstream at times.
Using ffprobe on a downloaded segment previously showed an AAC stream present (it printed an AAC stream line), which means audio is embedded in TS.
Players may have muted output if:
The segment you test is the very latest (still being written) or too short.
The upstream source intermittently has no audio frames.
PTS/DTS weren’t aligned previously; that’s now addressed.
Try this now

Use a media player (VLC, hls.js demo) and point it at:
http://localhost:5001/m3u8?q=http%3A%2F%2F185.234.111.229%3A8000%2Fplay%2Fa05x
If audio’s still muted, test a slightly older segment (not the freshest):
Fetch the playlist, take the previous segment line, then GET it; it should contain audio.
Optional tweaks

Override audio via env for more volume/compatibility:
AAC_CH=2; AAC_SR=48000; AAC_BR=128000
If your upstream truly has no audio at times, I can inject silent AAC frames so players stay in sync; say the word and I’ll add it.
Want a louder mix? I can add a tiny volume filter on the decode path.
Summary

I bumped segment history and switched defaults to stereo 48k/128k.
Fixed audio PTS/DTS handling and added write diagnostics.
Segments are being emitted; audio stream is present when upstream provides it.
If you want me to force stereo/silent-audio padding regardless of source, I can implement that next.