#!/bin/bash
# משווה מודלים של Groq: זמן תשובה ונכונות בשאלות ידע בעברית. לא מדפיס מפתחות.
cd ~/ivr-ai; set -a; . ./.env 2>/dev/null; set +a
K=$(echo "$GROQ_API_KEY" | tr ', ' '\n\n' | grep gsk_ | head -1)
[ -z "$K" ] && K=$(python3 -c "import json;print(json.load(open('data/pool.json'))[0]['key'])" 2>/dev/null)
for M in openai/gpt-oss-120b moonshotai/kimi-k2-instruct-0905 llama-3.3-70b-versatile qwen/qwen3-32b meta-llama/llama-4-maverick-17b-128e-instruct; do
  for Q in "מי זה אברהם פריד?" "מה זה החזון איש?"; do
    EX=""; [ "$M" = "openai/gpt-oss-120b" ] && EX=',"reasoning_effort":"low"'; [ "$M" = "qwen/qwen3-32b" ] && EX=',"reasoning_effort":"none"'
    S=$(date +%s%N)
    R=$(curl -s -m 20 https://api.groq.com/openai/v1/chat/completions -H "Authorization: Bearer $K" -H 'content-type: application/json' -d "{\"model\":\"$M\",\"max_tokens\":200$EX,\"messages\":[{\"role\":\"system\",\"content\":\"ענה בעברית בשני משפטים. אם אינך בטוח, אמור שאינך יודע.\"},{\"role\":\"user\",\"content\":\"$Q\"}]}")
    E=$(( ($(date +%s%N) - S) / 1000000 ))
    echo "MT $M | ${E}ms | $Q | $(echo "$R" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print((d.get("choices",[{}])[0].get("message",{}).get("content") or d.get("error",{}).get("message","?")).replace("\n"," ")[:170])' 2>/dev/null)"
  done
done
