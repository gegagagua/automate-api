#!/bin/bash
INPUT=$(cat)
FILE=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j?.tool_input?.file_path||j?.tool_response?.filePath||'')}catch(e){}" "$INPUT" 2>/dev/null)
if echo "$FILE" | grep -q "automate-api"; then
  pkill -f "node /root/automate-api/index.js" 2>/dev/null || true
  sleep 0.5
  cd /root/automate-api
  nohup node index.js >> /tmp/automate-api.log 2>&1 &
  echo "server restarted (PID $!)"
else
  echo "skip (not automate-api file)"
fi
