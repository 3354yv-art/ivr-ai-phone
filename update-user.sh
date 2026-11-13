#!/bin/bash
# עדכון קוד בלבד: לא נוגע בכתובת הזמנית ולא ב-.env. השרת עולה מחדש לבד.
set -e
cd ~/ivr-ai
curl -fsSL https://codeload.github.com/3354yv-art/ivr-ai-phone/tar.gz/refs/heads/main | tar xz --strip-components=1 -C ~/ivr-ai --wildcards '*/src' '*/stt' '*/package.json'
pkill -f "node [s]rc/server.js" || true
sleep 6
echo HEALTH=$(curl -s localhost:3000/health)
