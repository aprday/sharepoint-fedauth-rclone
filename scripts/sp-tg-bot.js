#!/usr/bin/env node
/**
 * SharePoint WebDAV 运维机器人 v2（多账号面板，公开脱敏版）
 * - 账号 profiles：SP_ACCOUNTS_DIR（默认 /etc/sp-webdav/accounts）下每个 *.env 一个账号；
 *   目录不存在时回落到单账号模式（读取 SP_ENV_FILE 或 /etc/default/sp-webdav）
 * - 命令（白名单聊天）：
 *     /accounts            列出所有账号
 *     /status [账号]       状态（省略=全部）
 *     /refresh [账号]      立即刷新 Cookie（省略=全部，逐个执行）
 *     /getpw [账号]        取当前密码
 *     /logs [账号] [n]     最近刷新日志
 *     /help
 * - 死人开关：每个账号心跳超过 SP_HEARTBEAT_MAX_HOURS 未更新即告警（12h 去重）
 * - 每日 09:05 (Asia/Shanghai) 全账号状态日报（SP_DAILY_DIGEST=0 可关）
 * 配置全部来自环境变量；服务自身凭据（TG_TOKEN/TG_CHAT_ID）在 service 的 EnvironmentFile，
 * 各账号凭据/路径在各自的 profile env 文件（chmod 600）。
 * 自测：node sp-tg-bot.js --selftest
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const env = process.env;
const TG_TOKEN = env.TG_TOKEN || '';
const TG_CHAT_ID = env.TG_CHAT_ID || '';
const ALLOWED = new Set((env.TG_ALLOWED_CHATS || TG_CHAT_ID).split(',').map(s => s.trim()).filter(Boolean));
const ACCOUNTS_DIR = env.SP_ACCOUNTS_DIR || '/etc/sp-webdav/accounts';
const MAX_HOURS = parseFloat(env.SP_HEARTBEAT_MAX_HOURS || '26');
const DIGEST = env.SP_DAILY_DIGEST !== '0';
const OFFSET_FILE = env.SP_BOT_OFFSET_FILE || '/var/lib/sp-webdav/bot-offset.txt';

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

// ---- profiles ----
function parseEnvFile(file) {
  const obj = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.replace(/\r$/, '');
    if (!t || t.trim().startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    obj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return obj;
}

function loadProfiles() {
  const profs = {};
  let files = [];
  try { files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.env')).sort(); } catch (e) {}
  if (files.length) {
    for (const f of files) {
      const full = path.join(ACCOUNTS_DIR, f);
      const cfg = parseEnvFile(full);
      cfg.__file = full;
      cfg.__name = f.replace(/\.env$/, '');
      profs[cfg.__name] = cfg;
    }
  } else {
    const legacy = env.SP_ENV_FILE || '/etc/default/sp-webdav';
    if (fs.existsSync(legacy)) {
      const cfg = parseEnvFile(legacy);
      cfg.__file = legacy;
      cfg.__name = 'default';
      profs.default = cfg;
    }
  }
  return profs;
}

const cfgGet = (cfg, k, d) => cfg[k] || d;

function profPaths(cfg) {
  const state = cfgGet(cfg, 'SP_STATE_DIR', '/var/lib/sp-webdav');
  return {
    cookie: cfgGet(cfg, 'SP_COOKIE_FILE', path.join(state, 'cookies.json')),
    hb: cfgGet(cfg, 'SP_HEARTBEAT_FILE', path.join(state, 'last-success.txt')),
    envf: cfgGet(cfg, 'SP_ENV_FILE', cfg.__file),
    log: cfgGet(cfg, 'SP_LOG_FILE', '/var/log/sp-webdav-cookie-refresh.log'),
    mount: cfgGet(cfg, 'SP_MOUNT_POINT', '/mnt/sharepoint'),
    svc: cfgGet(cfg, 'SP_RCLONE_SERVICE', 'rclone-sp'),
    refresh: cfgGet(cfg, 'SP_REFRESH_SCRIPT', '/opt/sp-webdav/scripts/sp-cookie-refresh.js'),
    host: cfgGet(cfg, 'SP_HOST_LABEL', env.SP_HOST_LABEL || os.hostname()),
  };
}

function statusFor(cfg) {
  const p = profPaths(cfg);
  const cookieAge = hoursSince(p.cookie);
  const hbAge = hoursSince(p.hb);
  const startDate = cfg.SP_PASSWORD_START_DATE || '未知';
  let days = '?';
  try { days = String(Math.floor((Date.now() - new Date(startDate + 'T00:00:00+08:00').getTime()) / 86400000)); } catch (e) {}
  const mount = sh(`df -h ${p.mount} 2>/dev/null | sed -n 2p`);
  const svc = sh(`systemctl is-active ${p.svc} 2>/dev/null`);
  const lastLog = sh(`tail -n 2 ${p.log} 2>/dev/null | sed 's/^/  /'`);
  return [
    `📊 [${cfg.__name}] ${cfg.SP_USERNAME || ''} @ ${p.host}`,
    `Cookie 年龄: ${cookieAge === null ? '无记录' : cookieAge.toFixed(1) + ' 小时'}`,
    `刷新心跳: ${hbAge === null ? '⚠️ 无记录' : hbAge.toFixed(1) + ' 小时前'}`,
    `密码周期: 第 ${days} 天（起点 ${startDate}，约90天到期自动换）`,
    `挂载服务: ${svc} | 挂载空间: ${mount || '未挂载'}`,
    `最近日志:`, lastLog,
  ].join('\n');
}

function runRefresh(cfg, chatId) {
  const p = profPaths(cfg);
  send(chatId, `⏳ [${cfg.__name}] 已触发 Cookie 刷新，完成后回报…`);
  const child = spawn('node', [p.refresh], { env: { ...process.env, ...cfg, SP_NOTIFY_FAILURE: '1' } });
  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  child.on('close', code => {
    const tailLines = out.split('\n').filter(Boolean).slice(-4).join('\n');
    send(chatId, code === 0
      ? `✅ [${cfg.__name}] 刷新成功\n${tailLines}`
      : `❌ [${cfg.__name}] 刷新失败 (exit ${code})\n${tailLines}`);
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
      try { fs.writeFileSync(OFFSET_FILE, String(offset)); } catch (e) {}
      const msg = up.message;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat.id);
      if (!ALLOWED.has(chatId)) { console.log(`ignore chat ${chatId}`); continue; }
      const tokens = msg.text.trim().split(/\s+/);
      const cmd = tokens[0];
      const profs = loadProfiles();
      const names = Object.keys(profs);
      let name = null;
      if (tokens[1] && profs[tokens[1]]) name = tokens[1];
      const targets = name ? [profs[name]] : Object.values(profs);
      console.log(`cmd ${cmd} from ${chatId} target=${name || 'ALL'}`);
      try {
        if (cmd === '/help' || cmd === '/start') {
          await send(chatId, `命令: /accounts | /status [账号] | /refresh [账号] | /getpw [账号] | /logs [账号] [n] | /help\n当前账号: ${names.join(', ') || '(无)'}`);
        } else if (cmd === '/accounts') {
          await send(chatId, '👥 账号列表:\n' + (names.map(n => `• ${n} — ${profs[n].SP_USERNAME || '?'}`).join('\n') || '(未配置任何 profile)'));
        } else if (cmd.startsWith('/status')) {
          await send(chatId, targets.map(statusFor).join('\n\n') + `\n时间: ${nowCST()}`);
        } else if (cmd.startsWith('/refresh')) {
          for (const t of targets) runRefresh(t, chatId);
        } else if (cmd.startsWith('/getpw')) {
          for (const t of targets) {
            const p = profPaths(t);
            try {
              const pw = fs.readFileSync(p.envf, 'utf8').match(/^SP_PASSWORD=(\S+)/m)[1];
              await send(chatId, `🔑 [${t.__name}] 当前密码: <code>${pw}</code>`);
            } catch (e) { await send(chatId, `🔑 [${t.__name}] 读取密码失败: ${e.message}`); }
          }
        } else if (cmd.startsWith('/logs')) {
          let n = 15;
          const extra = tokens[1] && !profs[tokens[1]] ? parseInt(tokens[1], 10) : (tokens[2] ? parseInt(tokens[2], 10) : NaN);
          if (!isNaN(extra) && extra > 0) n = Math.min(extra, 60);
          for (const t of targets) {
            const p = profPaths(t);
            const body = sh(`tail -n ${n} ${p.log} | sed 's/&/\\&amp;/g; s/</\\&lt;/g'`);
            await send(chatId, `📜 [${t.__name}]\n<code>${body}</code>`);
          }
        }
      } catch (e) {
        await send(chatId, `命令执行出错: ${e.message}`);
      }
    }
  }
}

async function observerLoop() {
  for (;;) {
    await sleep(3600000);
    for (const cfg of Object.values(loadProfiles())) {
      const p = profPaths(cfg);
      const hb = hoursSince(p.hb);
      if (hb === null || hb > MAX_HOURS) {
        const mark = p.hb + '.alerted';
        let alertedAt = 0;
        try { alertedAt = parseInt(fs.readFileSync(mark, 'utf8'), 10) || 0; } catch (e) {}
        if (Date.now() - alertedAt > 12 * 3600000) {
          fs.writeFileSync(mark, String(Date.now()));
          await send(TG_CHAT_ID, `💀 [${cfg.__name}] 心跳缺失：Cookie 刷新已 ${hb === null ? '从未成功' : hb.toFixed(1) + ' 小时'}未成功。\n请 /status ${cfg.__name} 检查或 /refresh ${cfg.__name} 重试。`);
        }
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
    if (DIGEST) {
      const blocks = Object.values(loadProfiles()).map(statusFor);
      await send(TG_CHAT_ID, `📅 每日日报（${blocks.length} 个账号）\n\n` + blocks.join('\n\n') + `\n时间: ${nowCST()}`);
    }
  }
}

if (process.argv.includes('--selftest')) {
  const profs = loadProfiles();
  console.log(Object.values(profs).map(statusFor).join('\n\n') || '(no profiles found)');
  process.exit(0);
}
console.log(`sp-tg-bot v2 started; accounts dir=${ACCOUNTS_DIR}; allowed chats: ${[...ALLOWED].join(',')}`);
pollLoop().catch(e => { console.error('pollLoop fatal', e); process.exit(1); });
observerLoop();
digestLoop();
