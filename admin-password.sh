#!/bin/bash
# רץ ב-Cloud Shell של אורקל. מבקש סיסמה בהקלדה נסתרת, מצפין אותה כאן, ושולח לשרת רק את ההצפנה.
set -e
read -rsp "בחר סיסמה לניהול: " P </dev/tty; echo
read -rsp "הקלד שוב: " P2 </dev/tty; echo
echo "אורך הסיסמה שהוקלדה: ${#P} תווים"
[ "$P" = "$P2" ] && [ ${#P} -ge 8 ] || { echo "הסיסמות שונות או קצרות מ-8 תווים"; exit 1; }
H=$(ADMPW="$P" python3 -c "import os,hashlib;s=os.urandom(16);print(s.hex()+':'+hashlib.scrypt(os.environ['ADMPW'].encode(),salt=s,n=16384,r=8,p=1,dklen=64).hex())")
unset P P2
I=$(oci compute instance list --compartment-id $OCI_TENANCY --lifecycle-state RUNNING --query 'data[0].id' --raw-output)
CMD=$(oci instance-agent command create --compartment-id $OCI_TENANCY --target "{\"instanceId\":\"$I\"}" --display-name admpw --timeout-in-seconds 300 --content "{\"source\":{\"sourceType\":\"TEXT\",\"text\":\"cd ~/ivr-ai; grep -v '^ADMIN_HASH=' .env > .env.new; echo 'ADMIN_HASH=$H' >> .env.new; mv .env.new .env; chmod 600 .env; pkill -f 'node [s]rc/server.js' || true; sleep 6; echo HEALTH=\$(curl -s localhost:3000/health)\"},\"output\":{\"outputType\":\"TEXT\"}}" --query 'data.id' --raw-output)
for n in $(seq 1 60); do S=$(oci instance-agent command-execution get --command-id $CMD --instance-id $I --query 'data."lifecycle-state"' --raw-output); case $S in SUCCEEDED|FAILED|TIMED_OUT|CANCELED) break;; esac; sleep 8; done
oci instance-agent command-execution get --command-id $CMD --instance-id $I --query 'data.content.text' --raw-output | tail -n 3
echo "הסיסמה נשמרה. שם המשתמש: יהונתן"
