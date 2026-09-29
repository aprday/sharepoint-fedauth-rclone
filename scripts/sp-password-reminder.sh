#!/usr/bin/env bash
# 密码 90 天生命周期提醒：从 SP_PASSWORD_START_DATE 起满 SP_REMIND_AFTER_DAYS 天后，
# 每天经 Telegram 提醒手动改密（改密后更新 env 里的起点日期即可）。
# 依赖环境变量：SP_PASSWORD_START_DATE, TG_TOKEN, TG_CHAT_ID（可选 SP_USERNAME / SP_REMIND_AFTER_DAYS）
set -euo pipefail

START_DATE="${SP_PASSWORD_START_DATE:?set SP_PASSWORD_START_DATE=YYYY-MM-DD}"
REMIND_AFTER_DAYS="${SP_REMIND_AFTER_DAYS:-85}"
TG_TOKEN="${TG_TOKEN:?set TG_TOKEN}"
TG_CHAT_ID="${TG_CHAT_ID:?set TG_CHAT_ID}"
ACCOUNT_LABEL="${SP_USERNAME:-SharePoint 账号}"

TODAY=$(TZ=Asia/Shanghai date +%F)
START_TS=$(date -d "$START_DATE" +%s)
TODAY_TS=$(date -d "$TODAY" +%s)
DAYS=$(( (TODAY_TS - START_TS) / 86400 ))

if [ "$DAYS" -lt "$REMIND_AFTER_DAYS" ]; then
  exit 0
fi

TEXT=$(cat <<EOF
⚠️ SharePoint 密码即将过期提醒

账号: $ACCOUNT_LABEL
上次改密日期: $START_DATE
已使用: ${DAYS} 天
租户策略约 90 天强制改密，到期后 Cookie 自动刷新会失败。

建议今天手动登录 Microsoft 修改密码（或直接跑 sp-change-password.js），
完成后更新 /etc/default/sp-webdav 中的 SP_PASSWORD 与 SP_PASSWORD_START_DATE。
EOF
)
export TEXT

python3 - <<PY
import os, urllib.parse, urllib.request
text = os.environ["TEXT"]
token = os.environ["TG_TOKEN"]
chat_id = os.environ["TG_CHAT_ID"]
url = "https://api.telegram.org/bot" + token + "/sendMessage?" + urllib.parse.urlencode({"chat_id": chat_id, "text": text})
urllib.request.urlopen(url, timeout=20).read()
PY
