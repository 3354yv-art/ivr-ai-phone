#!/bin/bash
# מפעיל את השרת אם הוא לא רץ, ומתקין בדיקה אוטומטית כל דקה (cron). לא נוגע בכתובת הזמנית.
APP="$HOME/ivr-ai"
cd "$APP" || exit 1
start() { pgrep -f run-server.sh >/dev/null || (setsid nohup ./run-server.sh >/dev/null 2>&1 </dev/null &); }
if [ "$1" = "cron" ]; then start; exit 0; fi
curl -fsSL https://raw.githubusercontent.com/3354yv-art/ivr-ai-phone/main/keepalive.sh -o "$APP/keepalive.sh" && chmod +x "$APP/keepalive.sh"
start
( crontab -l 2>/dev/null | grep -v 'keepalive.sh'; echo "* * * * * $APP/keepalive.sh cron" ) | crontab - 2>/dev/null && echo CRON=ok || echo CRON=fail
sleep 6
echo HEALTH=$(curl -s -m 5 localhost:3000/health || echo fail)
echo PORT6080=$(curl -s -m 5 -o /dev/null -w %{http_code} localhost:6080/admin)
