# 多账号：一个机器人面板管理 N 个 SharePoint

目标形态：**一台 VPS + 一个 TG 机器人**，管任意多个 SharePoint/OneDrive 账号；每个账号独立的
Cookie、rclone remote、挂载点、systemd 实例、改密自愈与心跳告警，互不干扰。

## 布局约定

```
/etc/sp-webdav/accounts/<名字>.env     每账号一份完整配置（chmod 600，字段同 config/example.env）
/etc/default/sp-webdav                 机器人服务自身配置：TG_TOKEN / TG_CHAT_ID / SP_ACCOUNTS_DIR 等
/var/lib/sp-webdav/<名字>/               每账号的 cookies.json、心跳、截图（由 profile 里 SP_STATE_DIR 指定）
/opt/sp-webdav/                          git clone 的本仓库（脚本唯一来源）
```

profile env 必须包含：`SP_USERNAME / SP_PASSWORD / SP_SITE_URL / SP_CHROMIUM_PATH /`
`SP_STATE_DIR=/var/lib/sp-webdav/<名字> / SP_COOKIE_FILE / SP_HEARTBEAT_FILE / SP_SHOT_DIR /`
`SP_LOG_FILE=/var/log/sp-<名字>-cookie-refresh.log / SP_ENV_FILE=/etc/sp-webdav/accounts/<名字>.env /`
`SP_RCLONE_CONF / SP_RCLONE_REMOTE=spcookie-<名字> / SP_CHUNKER_REMOTE=spchunked-<名字> /`
`SP_RCLONE_SERVICE=rclone-sp@<名字> / SP_MOUNT_POINT / TG_TOKEN / TG_CHAT_ID / SP_PASSWORD_START_DATE`。
（改密自愈会把新密码写回 `SP_ENV_FILE`，所以该字段必须指向 profile 自身。）

## 机器人命令（v2 起支持账号参数）

- `/accounts`：列出全部账号
- `/status`：全部账号状态；`/status fudan`：只看一个
- `/refresh`：全部逐个刷新；`/refresh fudan`：只刷一个（完成后回报结果）
- `/getpw [账号]`：取当前密码（自动改密后在这里拿新密码）
- `/logs [账号] [n]`：最近日志
- 心跳 watchdog 与每日 09:05 日报均按账号逐条巡检/汇总

## 新增一个账号（约 10 分钟）

1. 建 profile：
   `cp config/example.env /etc/sp-webdav/accounts/<名字>.env && chmod 600 $_`，按上面清单填值。
2. rclone remote（两个）：
   `rclone config` 或直接编辑 `SP_RCLONE_CONF`：
   - `[spcookie-<名字>]` type=webdav url=<文档库URL> vendor=other（headers 行由刷新脚本自动维护）
   - `[spchunked-<名字>]` type=chunker remote=spcookie-<名字>: chunk_size=1900M
3. 装单元并启动（模板已参数化）：
   ```
   systemctl daemon-reload
   systemctl enable --now rclone-sp@<名字>.service
   systemctl enable --now sp-cookie-refresh@<名字>.timer
   ```
4. 首跑验证：
   ```
   set -a; . /etc/sp-webdav/accounts/<名字>.env; set +a
   SP_NOTIFY_FAILURE=0 node /opt/sp-webdav/scripts/sp-cookie-refresh.js
   ls $SP_MOUNT_POINT
   ```
   成功后在 TG 发 `/status <名字>` 应看到心跳 0.0h。
5. 完事。日报/watchdog/改密自愈自动纳入该账号，无需改代码。

## 单元对照（模板 vs 旧单账号单元）

- `sp-cookie-refresh@.service/.timer` + `sp-cookie-refresh-retry@.service` 取代旧的非模板单元；
  旧单元可停用：`systemctl disable --now sp-cookie-refresh.timer`
- `rclone-sp@.service` 取代旧 `rclone-sp.service` / 自定义挂载单元；
  存量账号可继续用旧单元，但建议迁移以便统一（`systemctl enable --now rclone-sp@fudan` 前先停旧服务）
- `sp-tg-bot.service` 全局只跑一个实例（多机器人 token 反而抢 getUpdates）

## 容量与隔离注意

- 每账号一个无头 Chromium 登录会话，刷新错峰：timer 的 `RandomizedDelaySec` 已打散，账号多时可再调大；
- `--vfs-cache-max-size` 按磁盘余量分配（挂载缓存默认在系统盘）；
- 某账号被租户风控/改密失败只影响自己：告警带 `[名字]` 前缀，其余账号照常。
