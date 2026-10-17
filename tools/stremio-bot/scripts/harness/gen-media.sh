#!/bin/sh
# Makes the harness's test files in $1: a 1920x800 24 fps film-like MKV (H.264 about 8 Mbit/s with grain, a keyframe every 5 s,
# AAC stereo plus AC-3 5.1) and a self-signed certificate for localhost. Usage: gen-media.sh DIR [seconds=240]
set -e
dir=${1:?directory}
secs=${2:-240}
mkdir -p "$dir"
[ -f "$dir/cert.pem" ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
ffmpeg -y -v error -f lavfi -i "testsrc2=size=1920x800:rate=24,noise=alls=14:allf=t" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" -f lavfi -i "sine=frequency=220:sample_rate=48000" -t "$secs" \
  -map 0:v -map 1:a -map 2:a -c:v libx264 -preset veryfast -b:v 8M -maxrate 12M -bufsize 16M -g 120 -keyint_min 120 -sc_threshold 0 -pix_fmt yuv420p \
  -c:a:0 aac -b:a:0 160k -ac:a:0 2 -c:a:1 ac3 -b:a:1 384k -ac:a:1 6 "$dir/film.mkv"
ls -l "$dir/film.mkv"
