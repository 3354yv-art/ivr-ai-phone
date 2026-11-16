#!/bin/bash
# מודל מקומי בשרת (Ollama), בלי sudo: מתקין לתיקיית הבית, מפעיל, מוריד מודל ומודד מהירות בעברית.
set -u
ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) A=arm64;; *) A=amd64;; esac
echo "LL cpu=$(nproc) mem=$(free -g | awk '/Mem:/{print $2"G total, "$7"G free"}') arch=$A disk=$(df -h ~ | awk 'NR==2{print $4}')"
mkdir -p ~/ollama
if [ ! -x ~/ollama/bin/ollama ]; then
  curl -fsSL "https://ollama.com/download/ollama-linux-$A.tgz" -o /tmp/ollama.tgz && tar xzf /tmp/ollama.tgz -C ~/ollama && rm -f /tmp/ollama.tgz && echo "LL installed" || { echo "LL install-fail"; exit 0; }
fi
if ! curl -s -m 3 localhost:11434/api/tags >/dev/null; then
  (OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE=24h setsid nohup ~/ollama/bin/ollama serve >/tmp/ollama.log 2>&1 </dev/null &)
  sleep 5
fi
curl -s -m 3 localhost:11434/api/tags >/dev/null && echo "LL serve=ok" || { echo "LL serve-fail $(tail -n 2 /tmp/ollama.log | tr '\n' ' ')"; exit 0; }
for M in ${MODELS:-qwen2.5:3b gemma3:4b}; do
  timeout 900 ~/ollama/bin/ollama pull "$M" >/dev/null 2>&1 || { echo "LL pull-fail $M"; continue; }
  # חימום, ואז מדידה
  curl -s -m 120 localhost:11434/api/chat -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"שלום\"}],\"stream\":false,\"options\":{\"num_predict\":5}}" >/dev/null
  S=$(date +%s%N)
  OUT=$(curl -s -m 120 localhost:11434/api/chat -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"system\",\"content\":\"ענה בעברית, בשני משפטים קצרים.\"},{\"role\":\"user\",\"content\":\"מה בירת צרפת ולמה היא מפורסמת?\"}],\"stream\":false,\"options\":{\"num_predict\":80,\"num_ctx\":2048}}")
  E=$(( ($(date +%s%N) - S) / 1000000 ))
  echo "LL $M ${E}ms | $(echo "$OUT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["message"]["content"].replace("\n"," ")[:140], "| tok/s", round(d.get("eval_count",0)/max(d.get("eval_duration",1)/1e9,0.001),1))' 2>/dev/null)"
done
