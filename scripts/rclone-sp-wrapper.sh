#!/bin/bash
# rclone 挂载包装：从 cookies.json 读 Cookie，注入 webdav 头，
# 并同步写进 rclone.conf（chunker overlay 透传 webdav 头所必需）。
# 用法（一般由 systemd 调用）：
#   rclone-sp-wrapper.sh mount spchunked: /mnt/sharepoint --allow-other ...
# 环境变量：SP_COOKIE_FILE / SP_RCLONE_CONF / SP_RCLONE_REMOTE（默认 spcookie）
COOKIE_FILE="${SP_COOKIE_FILE:-/var/lib/sp-webdav/cookies.json}"
CONFIG_FILE="${SP_RCLONE_CONF:-/root/.config/rclone/rclone.conf}"
REMOTE="${SP_RCLONE_REMOTE:-spcookie}"

if [ ! -f "$COOKIE_FILE" ]; then
  echo "ERROR: Cookie file not found at $COOKIE_FILE." >&2
  exit 1
fi

COOKIES=$(python3 -c "
import json
with open('$COOKIE_FILE') as f:
    data = json.load(f)
print('; '.join([f\"{c['name']}={c['value']}\" for c in data['cookies']]))
")

python3 -c "
import re, json
with open('$COOKIE_FILE') as f:
    data = json.load(f)
cookies_str = '; '.join([f\"{c['name']}={c['value']}\" for c in data['cookies']])
headers_line = f'headers = Cookie,{cookies_str}'
remote = re.escape('$REMOTE')
with open('$CONFIG_FILE', 'r') as f:
    config = f.read()
if re.search(r'^(\[' + remote + r'\].*?\n)headers = .*', config, flags=re.MULTILINE|re.DOTALL):
    config = re.sub(r'^(\[' + remote + r'\].*?\n)headers = .*', lambda m: m.group(1) + headers_line, config, flags=re.MULTILINE|re.DOTALL)
else:
    config = re.sub(r'(\[' + remote + r'\].*?vendor = other)', lambda m: m.group(1) + '\n' + headers_line, config, flags=re.DOTALL)
with open('$CONFIG_FILE', 'w') as f:
    f.write(config)
" 2>/dev/null

exec /usr/bin/rclone "$@" --webdav-headers "Cookie,$COOKIES"
