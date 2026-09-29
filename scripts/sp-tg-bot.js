#!/usr/bin/env node
/**
 * SharePoint WebDAV 运维机器人（公开脱敏版）
 * - Telegram long-polling 面板：/status /refresh /getpw /logs /help
 * - 死人开关：心跳文件超过 SP_HEARTBEAT_MAX_HOURS 未更新则告警（12h 内不重复）
 * - 每日 09:05 (Asia/Shanghai) 状态日报（SP_DAILY_DIGEST=0 可关）
 * 仅响应 TG_CHAT_ID / TG_ALLOWED_CHATS 白名单内的聊天。
 * 配置全部来自环境变量（systemd EnvironmentFile 或 source env 后手动运行）。
 * 自测：node sp-tg-bot.js --selftest 只打印 /status 内容不启动轮询。
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const env = process.env;
const TG_TOKEN = env.TG_TOKEN || '';
const TG_CHAT_ID = env.TG_CHAT_ID || '';
const ALLOWED = new Set((env.TG_ALLOWED_CHATS || TG_CHAT_ID).split(',').map(s => s.trim()).filter(Boolean));
const HOST_LABEL = env.SP_HOST_LABEL || os.hostname();
const STATE_DIR = env.SP_STATE_DIR || '/var/lib/sp-webdav';
const HEARTBEAT_FILE = env.SP_HEARTBEAT_FILE || path.join(STATE_DIR, 'last-success.txt');
const ALERT_MARK = path.join(STATE_DIR, 'heartbeat-alerted.txt');
const OFFSET_FILE = path.join(STATE_DIR, 'bot-offset.txt');
const COOKIE_FILE = env.SP_COOKIE_FILE || path.join(STATE_DIR, 'cookies.json');
const LOG_FILE = env.SP_LOG_FILE || '/var/log/sp-webdav-cookie-refresh.log';
const ENV_FILE = env.SP_ENV_FILE || '/etc/default/sp-webdav';
const MOUNT = env.SP_MOUNT_POINT || '/mnt/sharepoint';
const RCLONE_SERVICE = env.SP_RCLONE_SERVICE || 'rclone-sp';
const REFRESH_SCRIPT = env.SP_REFRESH_SCRIPT || '/opt/sp-webdav/scripts/sp-cookie-refresh.js';
const MAX_HOURS = parseFloat(env.SP_HEARTBEAT_MAX_HOURS || '26');
const DIGEST = env.SP_DAILY_DIGEST !== '0';
const SCRIPTS_DIR = path.dirname(fs.realpathSync(__filename));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowCST = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function tg(apiPath, payload) {
  return new Promise((resolve) => {
    if (!TG_TOKEN) return resolve(null);
    const data = Buffer.from(JSON.stringify(payload));
    const req = https.request(`https://api.telegram.org/bot${TG_TOKEN}/${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end(data);
  });
}
const send = (chatId, text) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 20000 }).trim(); } catch (e) { return `(exec error: ${String(e.message).split('\n')[0]})`; }
}

function hoursSince(file) {
  try {
    const t = new Date(fs.readFileSync(file, 'utf8').trim()).getTime();
    if (isNaN(t)) return null;
    return (Date.now() - t) / 3600000;
  } catch (e) { return null; }
}

function buildStatus() {
  const cookieAge = hoursSince(COOKIE_FILE);
  const hbAge = hoursSince(HEARTBEAT_FILE);
  let startDate = '';
  try {
    const mm = fs.readFileSync(ENV_FILE, 'utf8').match(/^SP_PASSWORD_START_DATE=(\S+)/m);
    startDate = mm ? mm[1] : '未知';
  } catch (e) { startDate = '未知'; }
  let days = '';
  try {
    days = String(Math.floor((Date.now() - new Date(startDate + 'T00:00:00+08:00').getTime()) / 86400000));
  } catch (e) { days = '?'; }
  const mount = sh(`df -h ${MOUNT} 2>/dev/null | sed -n 2p`);
  const svc = sh(`systemctl is-active ${RCLONE_SERVICE} 2>/dev/null`);
  const timer = sh(`systemctl is-active sp-cookie-refresh.timer 2>/dev/null`);
  const lastLog = sh(`tail -n 3 ${LOG_FILE} 2>/dev/null | sed 's/^/  /'`);
  return [
    `📊 SharePoint 网盘状态 @ ${HOST_LABEL}`,
    `Cookie 年龄: ${cookieAge === null ? '无记录' : cookieAge.toFixed(1) + ' 小时'}`,
    `刷新心跳: ${hbAge === null ? '⚠️ 无记录' : hbAge.toFixed(1) + ' 小时前'}`,
    `密码周期: 第 ${days} 天（起点 ${startDate}，约 90 天到期自动换）`,
    `挂载服务: ${svc} | 刷新timer: ${timer}`,
    `挂载空间: ${mount || '未挂载'}`,
    `最近日志:`, lastLog,
    `时间: ${nowCST()}`,
  ].join('\n');
}

function runRefresh(chatId) {
  send(chatId, '⏳ 已触发 Cookie 刷新，完成后回报结果…');
  const child = spawn('bash', ['-c', `. ${ENV_FILE} && SP_NOTIFY_FAILURE=1 node ${REFRESH_SCRIPT}`], { detached: false });
  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  child.on('close', code => {
    const tailLines = out.split('\n').filter(Boolean).slice(-4).join('\n');
    send(chatId, code === 0
      ? `✅ 刷新成功\n${tailLines}`
      : `❌ 刷新失败 (exit ${code})\n${tailLines}`);
  });
}

async function pollLoop() {
  let offset = 0;
  try { offset = parseInt(fs.readFileSync(OFFSET_FILE, 'utf8'), 10) || 0; } catch (e) {}
  for (;;) {
    const res = await tg('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] });
    if (!res || !res.ok) { await sleep(10000); continue; }
    for (const up of res.result) {
      offset = up.update_id + 1;
      fs.writeFileSync(OFFSET_FILE, String(offset));
      const msg = up.message;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat.id);
      if (!ALLOWED.has(chatId)) { console.log(`ignore chat ${chatId}`); continue; }
      const text = msg.text.trim();
      console.log(`cmd from ${chatId}: ${text}`);
      if (text.startsWith('/status')) {
        await send(chatId, buildStatus());
      } else if (text.startsWith('/refresh')) {
        runRefresh(chatId);
      } else if (text.startsWith('/getpw')) {
        try {
          const pw = fs.readFileSync(ENV_FILE, 'utf8').match(/^SP_PASSWORD=(\S+)/m)[1];
          await send(chatId, `🔑 当前密码: <code>${pw}</code>\n（仅白名单聊天可见）`);
        } catch (e) { await send(chatId, '读取密码失败: ' + e.message); }
      } else if (text.startsWith('/logs')) {
        const n = parseInt(text.split(/\s+/)[1], 10) || 15;
        await send(chatId, `<code>${sh(`tail -n ${Math.min(n, 60)} ${LOG_FILE} | sed 's/&/\\&amp;/g; s/</\\&lt;/g'`)}</code>`);
      } else if (text.startsWith('/help')) {
        await send(chatId, '命令: /status 状态 | /refresh 立即刷新Cookie | /getpw 取当前密码 | /logs [n] 最近日志 | /help');
      }
    }
  }
}

async function observerLoop() {
  for (;;) {
    await sleep(3600000);
    const hb = hoursSince(HEARTBEAT_FILE);
    if (hb === null || hb > MAX_HOURS) {
      let alertedAt = 0;
      try { alertedAt = parseInt(fs.readFileSync(ALERT_MARK, 'utf8'), 10) || 0; } catch (e) {}
      if (Date.now() - alertedAt > 12 * 3600000) {
        fs.writeFileSync(ALERT_MARK, String(Date.now()));
        await send(TG_CHAT_ID, `💀 心跳缺失：Cookie 刷新已 ${hb === null ? '从未成功' : hb.toFixed(1) + ' 小时'}未成功。\n请 /status 检查或 /refresh 重试；若连续失败看 /logs。`);
      }
    }
  }
}

async function digestLoop() {
  for (;;) {
    const now = new Date(Date.now() + 8 * 3600000);
    const hh = now.getUTCHours(), mm = now.getUTCMinutes();
    let waitMs = ((9 - hh + 24) % 24) * 3600000 - mm * 60000 + 5 * 60000;
    if (waitMs < 60000) waitMs += 86400000;
    await sleep(waitMs);
    if (DIGEST) await send(TG_CHAT_ID, '📅 每日日报\n' + buildStatus());
  }
}

if (process.argv.includes('--selftest')) {
  console.log(buildStatus());
  process.exit(0);
}
console.log(`sp-tg-bot started; allowed chats: ${[...ALLOWED].join(',')}`);
pollLoop().catch(e => { console.error('pollLoop fatal', e); process.exit(1); });
observerLoop();
digestLoop();
