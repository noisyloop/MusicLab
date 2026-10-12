#!/usr/bin/env sh
# Generate audio fixtures for the browser smoke tests (needs ffmpeg).
# Usage: e2e/make-fixtures.sh <work-dir>
set -e
DIR="${1:?usage: make-fixtures.sh <work-dir>}"
mkdir -p "$DIR/audio"
cd "$DIR/audio"
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=220:duration=2" -ac 2 tone.wav
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=3" beep.ogg
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=330:duration=1.5" t.flac
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=550:duration=1" t.mp3
head -c 2000 /dev/urandom > bad.mp3
echo "fixtures in $DIR/audio"
