#!/usr/bin/env bash
# מתקין מודל מקומי (Ollama) ותמלול (Whisper) בלי הרשאות מנהל. רץ ברקע, מדפיס התקדמות.
set -u
H="$HOME"; APP="$H/ivr-ai"; MODEL="${LOCAL_MODEL:-qwen2.5:3b}"
mkdir -p "$H/ollama" "$H/models"
echo "[1/4] Ollama"
if [ ! -x "$H/ollama/bin/ollama" ]; then
  curl -fL https://github.com/ollama/ollama/releases/latest/download/ollama-linux-arm64.tar.zst | zstd -d | tar -x -C "$H/ollama" || { echo FAIL ollama; exit 1; }
  rm -rf "$H/ollama/lib/ollama/cuda"* "$H/ollama/lib/ollama/rocm"* 2>/dev/null
fi
cat > "$APP/run-ollama.sh" <<'RO'
#!/usr/bin/env bash
export OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS="$HOME/models" OLLAMA_KEEP_ALIVE=24h OLLAMA_NUM_PARALLEL=1
while true; do "$HOME/ollama/bin/ollama" serve >> "$HOME/ivr-ai/ollama.log" 2>&1; sleep 3; done
RO
cat > "$APP/run-stt.sh" <<'RS'
#!/usr/bin/env bash
cd "$HOME/ivr-ai"
while true; do python3 stt/server.py >> stt.log 2>&1; sleep 3; done
RS
cat > "$APP/local-start.sh" <<'LS'
#!/usr/bin/env bash
cd "$HOME/ivr-ai"
pgrep -f run-ollama.sh >/dev/null || setsid nohup ./run-ollama.sh >/dev/null 2>&1 < /dev/null &
pgrep -f run-stt.sh >/dev/null || setsid nohup ./run-stt.sh >/dev/null 2>&1 < /dev/null &
LS
chmod +x "$APP"/run-ollama.sh "$APP"/run-stt.sh "$APP"/local-start.sh
( crontab -l 2>/dev/null | grep -v 'local-start.sh'; echo "@reboot $APP/local-start.sh" ) | crontab - 2>/dev/null || true
"$APP/local-start.sh"; sleep 5
echo "[2/4] model $MODEL"
OLLAMA_HOST=127.0.0.1:11434 "$H/ollama/bin/ollama" pull "$MODEL" || { echo FAIL pull; exit 1; }
echo "[3/4] whisper"
python3 -m pip install --user --break-system-packages -q faster-whisper || { echo FAIL pip; exit 1; }
pkill -f run-stt.sh; pkill -f stt/server.py; sleep 1
python3 - <<'PY' || { echo FAIL whisper-model; exit 1; }
import os
from faster_whisper import WhisperModel
WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8")
PY
"$APP/local-start.sh"; sleep 15
echo "[4/4] warmup"
curl -s localhost:11434/api/chat -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"שלום\"}],\"stream\":false,\"options\":{\"num_predict\":8}}" | cut -c1-200
echo; echo "STT=$(curl -s localhost:8123/)"
echo DONE
