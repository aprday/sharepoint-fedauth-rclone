# 故障速查（troubleshooting）

按"Telegram 报警文案 / 日志关键字 → 原因 → 处理"组织。所有路径以 `config/example.env` 的变量为准。

## 1. `Login failed - ended at: https://login.microsoftonline.com/.../login`

- **原因**：绝大多数是**密码到期（租户约 90 天强制改密）**，登录流落入"强制改密"页，脚本不会越过它；少数是账号被风控要求二次验证。
- **处理**：
  1. 跑 `scripts/sp-change-password.js` 自动改密，或浏览器手动改；
  2. 更新 `/etc/default/sp-webdav` 的 `SP_PASSWORD` 与 `SP_PASSWORD_START_DATE`；
  3. 手动执行一次 `sp-cookie-refresh.js` 验证，提醒周期自动从新起点算。
- **预防**：`sp-password-reminder.sh` 从第 85 天起每天提醒。

## 2. `Username field not found after 3 attempts`

- **原因**：VPS 到 `login.microsoftonline.com` 链路抖动（Oracle Cloud 出口常见 `ERR_NETWORK_CHANGED`），登录页没加载出来，不是凭据错误。
- **处理**：看 `$SP_SHOT_DIR/sp_login_attempt_*.png` 确认是浏览器网络错误页还是真·页面改版；抖动类等下个周期自愈（脚本已内置 3 次重试 + 失败 5 分钟后 retry 单元）。
- **若截图显示登录页 DOM 改版**：更新 `sp-cookie-refresh.js` 里的选择器（`input[name="loginfmt"]`、`#idSIButton9` 等）。

## 3. `Browser was not found at the configured executablePath (/usr/bin/chromium)`

- **原因**：系统 chromium 被卸载/升级，或 playwright 浏览器版本目录变化（如 `chromium-1223` 升版后旧路径失效）。
- **处理**：`node -e "console.log(require('playwright-core').chromium.executablePath())"` 或 `ls /root/.cache/ms-playwright/` 找新路径，更新 `SP_CHROMIUM_PATH`。

## 4. Cookie 刚刷新但 WebDAV / 挂载仍 401

- **原因**：rclone 进程还持有旧 Cookie 头；chunker overlay 不会自己读 cookies.json。
- **处理**：确认刷新脚本成功执行了"热更新 rclone.conf + 重启服务"两步；手动 `systemctl restart $SP_RCLONE_SERVICE`。

## 5. 上传 >2GB 失败

- **原因**：SharePoint WebDAV 单文件上限 2GB。
- **处理**：大文件走 chunker remote（`spchunked:`，1900M 分片，落地为 `.001/.002…`）；注意 **chunker 不支持断点续传**，<2GB 文件建议走直连 webdav remote（`spcookie:`）以保留续传能力。

## 6. 挂载目录内容陈旧 / 卡死

- webdav 后端不支持 change notify，`--poll-interval` 无效，靠 `--dir-cache-time` 与重启服务刷新；
- 卡死时 `fusermount -uz 挂载点` 后 `systemctl restart rclone-sp`；
- 上传中转吃磁盘：关注 `--vfs-cache-max-size` 与所在分区余量。

## 7. 内存里一堆僵尸 Chromium

- 脚本启动/结束时会自动清理（>5 个才杀）；手动：`pkill -f 'chrom.*puppeteer'`。

## 8. Telegram 半夜刷屏误报

- 首败静默：cron/timer 里设 `SP_NOTIFY_FAILURE=0`，由 5 分钟后的 retry 单元做"二次失败才报警"；
- 链路抖动类报警通常在 retry 成功后自停。

## 9. 锁文件残留导致刷新不执行

- 日志出现 `Another refresh process is running` 但实际没有进程：删除 `$SP_LOCK_FILE`（脚本自身也会对 stale PID 自动清锁）。

## 10. 多账号互相干扰

- 每个账号必须独立：`SP_COOKIE_FILE`、rclone remote 名、systemd 服务实例、挂载点；
- 复制 service 文件改名（如 `rclone-sp-b.service`）并在其 `EnvironmentFile` 指向各自的 env 文件。


## 11. 自动改密（rotation）相关
- `Password rotation rejected by tenant policy`：新密码不满足复杂度或与近期密码重复；看截图目录 `sp_rotate_rejected.png` 的拒绝原因，调整 `generatePassword()` 字符集；
- `Password-change page without 3 fields`：改密页改版；看 `sp_rotate_unexpected.png`，更新 `handleForcedPasswordChange()` 选择器；
- 改密成功后旧密码立即失效，手动登录 Web 请用 Telegram 推送的新密码或机器人 `/getpw`。

## 12. 机器人（sp-tg-bot）相关
- 命令无回应：`systemctl status sp-tg-bot` 与 `journalctl -u sp-tg-bot -n 20`；确认发消息的 chat id 在 `TG_CHAT_ID` / `TG_ALLOWED_CHATS` 白名单内；
- 机器人与 cron 通知互不冲突：机器人只消费 getUpdates，通知走 sendMessage 通道。

## 13. 部署坑（实战教训）
- 经 heredoc/远程管道写出的配置文件要除 CRLF（`sed -i 's/\r$//'`），否则 env 值带 `\r` 引发离奇故障（systemd 单元名、node argv 都会中招）；
- `. /etc/default/xxx` 只设置 shell 变量，传给子进程前必须 `set -a` … `set +a`；
- timer 加 `Persistent=true` 后 enable 时会立刻补跑一次过期任务，属预期行为。