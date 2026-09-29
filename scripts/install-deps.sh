#!/bin/bash
# Debian 11/12 依赖一键安装（root 运行）
# 安装：nodejs/npm、python3、fuse3、rclone（官方版）、puppeteer-extra 全家桶、playwright chromium
set -euo pipefail

apt-get update
apt-get install -y python3 fuse3 curl unzip nodejs npm

# rclone 官方版（apt 源里的通常太旧）
curl -s https://rclone.org/install.sh | bash

# puppeteer 依赖装到全局，运行时用 NODE_PATH=$(npm root -g)
npm install -g puppeteer-extra puppeteer-extra-plugin-stealth

# 无头 Chromium：playwright 版本对 Microsoft 登录页兼容性最好
npx -y playwright install --with-deps chromium
CHROME_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())" 2>/dev/null || true)
if [ -n "$CHROME_PATH" ]; then
  echo "检测到 playwright chromium: $CHROME_PATH"
  echo "请把 SP_CHROMIUM_PATH=$CHROME_PATH 写进 /etc/default/sp-webdav"
else
  echo "未检测到 playwright chromium，可改用系统 chromium：apt-get install -y chromium"
fi

# 部署占位目录
mkdir -p /var/lib/sp-webdav/shots
install -d /usr/local/bin
echo "完成。下一步：cp scripts/* /usr/local/bin/ && cp config/example.env /etc/default/sp-webdav"
