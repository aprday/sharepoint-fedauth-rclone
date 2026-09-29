# SharePoint × FedAuth Cookie × rclone：把无 API 权限的 SharePoint 辐射成网盘

适用场景：Microsoft 365 教育版（或任何**禁用应用注册 / 拿不到 API 权限、也没有应用密码入口**的租户）下的 SharePoint Online 站点文档库，通过浏览器 Cookie 认证 + WebDAV + rclone，挂载为本地目录 / 网盘，并支持 **>2GB 大文件分片中转上传**。

思路来源：nodeseek 论坛 post-453115、post-743495（Cookie 版 WebDAV 挂载 SharePoint），本仓库是可复用的完整工程化实现。

## 方案概览

```
cron / systemd timer（每 12 小时）
   └─ scripts/sp-cookie-refresh.js
        │  puppeteer-extra + stealth，无头 Chromium 模拟登录 Microsoft
        ├─ 提取 FedAuth + rtFa Cookie → 写入 cookies.json
        ├─ 同步把 Cookie 头写进 rclone.conf 的 webdav remote
        └─ 非阻塞重启 rclone 挂载服务（失败仅重试提醒，不刷屏）

rclone systemd 服务
   └─ webdav remote（vendor=other + Cookie 头）→ 挂载点
        └─ chunker overlay remote（1900M 分片）→ 突破单文件 2GB 限制

scripts/sp-password-reminder.sh（每日 cron）
   └─ 密码使用满 85 天起 Telegram 提醒：租户约 90 天强制改密
```

## 为什么走 Cookie 而不是官方 API

- 教育版租户通常**禁用应用注册 / client credentials**，Graph API 路线走不通；
- 账号安全信息页打不开、**没有"应用密码"入口**（MFA 由租户托管）；
- SharePoint Online 的 WebDAV 接口天然接受 `FedAuth` + `rtFa` Cookie 认证，
  只要能用浏览器登录，就能把站点辐射成网盘。

代价与对策见下表：

| 限制 | 表现 | 对策 |
| --- | --- | --- |
| 无 API | 无法用 Graph / client secret | 无头浏览器模拟登录取 Cookie |
| 单文件 2GB | WebDAV PUT >2GB 直接失败 | chunker remote 分片（1900M） |
| Cookie 会过期 | FedAuth 经验寿命 5~14 天 | 每 12h 自动刷新并热更新 rclone 配置 |
| 90 天强制改密 | 改密页导致自动登录失败 | 第 85 天起每日提醒，人工改密后更新 env |
| 登录页/网络抖动 | ERR_NETWORK_CHANGED、字段找不到 | 3 次重试 + 截图留证 + 失败静默重试 |

## 目录结构

```
config/example.env               全部可调参数（凭据一律环境变量注入）
scripts/sp-cookie-refresh.js     Cookie 刷新主脚本（无头登录 + 热更新 rclone）
scripts/sp-change-password.js    租户强制改密页的自动改密辅助脚本
scripts/sp-password-reminder.sh  密码 90 天生命周期提醒（Telegram）
scripts/rclone-sp-wrapper.sh     rclone 挂载包装：读 cookies.json 注入 Cookie 头
scripts/install-deps.sh          Debian/Ubuntu 依赖一键安装
systemd/rclone-sp.service        挂载服务（chunker overlay + vfs 缓存）
systemd/sp-cookie-refresh.service/.timer  Cookie 刷新定时单元（也可用 cron）
docs/troubleshooting.md          常见故障速查（含真实踩坑记录）
```

## 快速开始

1. **装依赖**：`bash scripts/install-deps.sh`（Debian 11/12 验证过），或手工：
   `nodejs npm python3 fuse3 rclone` + `npm i -g puppeteer-extra puppeteer-extra-plugin-stealth`
   + 无头 Chromium（推荐 `npx playwright install --with-deps chromium`，把其 chrome 路径填进 `SP_CHROMIUM_PATH`）。
2. **写配置**：`cp config/example.env /etc/default/sp-webdav && chmod 600 /etc/default/sp-webdav`，
   填入账号、站点 URL、Telegram 等。
3. **rclone remote**：在 `rclone.conf` 建两个 remote：
   - `[spcookie]` type=webdav, url=站点文档库 URL, vendor=other（Cookie 头由脚本自动写入）；
   - `[spchunked]` type=chunker, remote=spcookie:, chunk_size=1900M。
4. **部署服务**：复制 `systemd/*` 到 `/etc/systemd/system/`，`systemctl enable --now rclone-sp`。
5. **定时刷新**：二选一
   - systemd timer：`systemctl enable --now sp-cookie-refresh.timer`（每 12h）；
   - cron（带"首败静默、5 分钟后重试再报"的降噪写法）：
     `0 */12 * * * . /etc/default/sp-webdav && SP_NOTIFY_FAILURE=0 /usr/local/bin/sp-cookie-refresh.js || (sleep 300 && . /etc/default/sp-webdav && /usr/local/bin/sp-cookie-refresh.js)`
6. **改密提醒**：cron 加 `0 10 * * * . /etc/default/sp-webdav && /usr/local/bin/sp-password-reminder.sh`。

## 多账号并行

同一台 VPS 可挂 N 个 SharePoint 账号：每个账号独立一套
`SP_COOKIE_FILE / SP_RCLONE_REMOTE / SP_RCLONE_SERVICE / 挂载点 / systemd 实例`，
脚本全部由环境变量驱动，互不干扰。

## 安全须知

- 仓库内**不含任何凭据**；密码、Telegram token 只存在于服务器 `chmod 600` 的 env 文件；
- `cookies.json` 等价于登录态，与密码同级保护；
- 改密后只需更新 env 里的 `SP_PASSWORD` 与 `SP_PASSWORD_START_DATE`，其余自动恢复。

## 其它项目复用清单

想在自己的项目里用 SharePoint 当存储后端，最小依赖只有三件事：
1. 一个能持续保鲜的 `FedAuth/rtFa` Cookie（直接拷 `scripts/sp-cookie-refresh.js`）；
2. 一个带 Cookie 头的 WebDAV 客户端（rclone 任意 remote 类型皆可复用）；
3. 大于 2GB 的文件走 chunker 或自行分片（见 `docs/troubleshooting.md`）。


## v4 运维增强（2026-09-29）

### Telegram 机器人面板（scripts/sp-tg-bot.js）
白名单聊天内命令：
- `/status` Cookie 年龄 / 心跳 / 密码周期 / 挂载空间 / 服务状态
- `/refresh` 立即触发一次 Cookie 刷新并回报结果
- `/getpw` 取当前密码（自动改密后用它拿新密码）
- `/logs [n]` 最近刷新日志
- `/help` 命令列表

内置 watchdog：心跳文件超过 `SP_HEARTBEAT_MAX_HOURS`（默认 26h）未更新即报警（12h 内去重）；
每天 09:05 发状态日报（`SP_DAILY_DIGEST=0` 可关）。

### 密码到期自愈
刷新脚本检测到租户"强制改密页"时自动：生成随机 16 位新密码 → 完成改密 →
原子更新 env 文件的 `SP_PASSWORD` / `SP_PASSWORD_START_DATE` → 记入历史（保留最近 8 个）→
Telegram 推送新密码 → 同次运行继续取 Cookie，全程零人工。
强制改密页结构已在真实教育版租户验证（3 个密码框 + `#idSIButton9`）。

### 心跳与通知降噪
- 刷新成功写 `SP_HEARTBEAT_FILE`，由机器人 watchdog 观测（覆盖"cron/机器静默死亡"盲区）
- 失败时推送登录页截图（sendPhoto），链路抖动还是页面改版一眼可辨
- 首败静默（`SP_NOTIFY_FAILURE=0`）+ 5 分钟后 retry，仅二次失败才报警