#!/usr/bin/env node
/**
 * SharePoint Cookie Refresher（公开脱敏版）
 * - 无头 Chromium 模拟登录 Microsoft，提取 FedAuth + rtFa
 * - 登录流落入"强制改密页"时自愈：自动生成新密码完成改密，
 *   原子更新 env 文件（SP_PASSWORD / SP_PASSWORD_START_DATE），
 *   记录密码历史，并经 Telegram 推送新密码
 * - Cookie 落盘 cookies.json，并热更新 rclone.conf 的 webdav remote 头
 * - 成功写心跳文件（供机器人/死人开关观测）；失败推送登录页截图
 * - 锁文件防并发；非阻塞重启 rclone 服务
 * - 导航 3 次重试（对抗 ERR_NETWORK_CHANGED 等链路抖动），失败留截图
 *
 * 全部敏感配置由环境变量注入，见 config/example.env
 * 依赖：npm i -g puppeteer-extra puppeteer-extra-plugin-stealth
 * 运行：NODE_PATH=$(npm root -g) node sp-cookie-refresh.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const env = process.env;
const siteUrl = (env.SP_SITE_URL || '').replace(/\/+$/, '');
if (!siteUrl || !env.SP_USERNAME || !env.SP_PASSWORD) {
  console.error('Missing required env: SP_SITE_URL / SP_USERNAME / SP_PASSWORD');
  process.exit(2);
}

const siteOrigin = new URL(siteUrl).origin;
const sitePath = new URL(siteUrl).pathname.replace(/\/+$/, '');
const stateDir = env.SP_STATE_DIR || '/var/lib/sp-webdav';

const CONFIG = {
  username: env.SP_USERNAME,
  password: env.SP_PASSWORD,
  siteUrl,
  docsUrl: (env.SP_DOCS_URL || `${siteUrl}/Shared%20Documents`),
  cookieFile: env.SP_COOKIE_FILE || '/var/lib/sp-webdav/cookies.json',
  logFile: env.SP_LOG_FILE || '/var/log/sp-webdav-cookie-refresh.log',
  lockFile: env.SP_LOCK_FILE || '/run/sp-webdav-cookie-refresh.lock',
  shotDir: env.SP_SHOT_DIR || path.join(stateDir, 'shots'),
  heartbeatFile: env.SP_HEARTBEAT_FILE || path.join(stateDir, 'last-success.txt'),
  envFile: env.SP_ENV_FILE || '/etc/default/sp-webdav',
  historyFile: env.SP_PASSWORD_HISTORY_FILE || path.join(stateDir, 'password-history.txt'),
  tgToken: env.TG_TOKEN || '',
  tgChatId: env.TG_CHAT_ID || '',
  hostLabel: env.SP_HOST_LABEL || os.hostname(),
  notifyOnFailure: env.SP_NOTIFY_FAILURE !== '0',
  chromiumPath: env.SP_CHROMIUM_PATH || '/usr/bin/chromium',
  rcloneConf: env.SP_RCLONE_CONF || '/root/.config/rclone/rclone.conf',
  rcloneRemote: env.SP_RCLONE_REMOTE || 'spcookie',
  rcloneService: env.SP_RCLONE_SERVICE || 'rclone-sp',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const escapeReg = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const onSite = u => u.includes(siteOrigin) && (!sitePath || u.includes(sitePath)) && !u.includes('login.microsoftonline.com');

const log = (msg, level) => {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level || 'INFO'}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (e) {}
};

function acquireLock() {
  try {
    if (fs.existsSync(CONFIG.lockFile)) {
      const pid = fs.readFileSync(CONFIG.lockFile, 'utf8').trim();
      try { process.kill(parseInt(pid, 10), 0); } catch (e) {
        fs.unlinkSync(CONFIG.lockFile);
        log(`Removed stale lock from PID ${pid}`, 'WARN');
        fs.writeFileSync(CONFIG.lockFile, process.pid.toString());
        return true;
      }
      log(`Another refresh process is running (PID: ${pid}), exiting`, 'WARN');
      return false;
    }
    fs.writeFileSync(CONFIG.lockFile, process.pid.toString());
    return true;
  } catch (e) {
    log(`Lock check error: ${e.message}`, 'WARN');
    return true;
  }
}

function releaseLock() {
  try { if (fs.existsSync(CONFIG.lockFile)) fs.unlinkSync(CONFIG.lockFile); } catch (e) {}
}

function tgRequest(apiPath, payload, contentType, body) {
  return new Promise((resolve) => {
    if (!CONFIG.tgToken || !CONFIG.tgChatId) return resolve(false);
    const data = body || Buffer.from(JSON.stringify(payload));
    const headers = contentType
      ? { 'Content-Type': contentType, 'Content-Length': data.length }
      : { 'Content-Type': 'application/json', 'Content-Length': data.length };
    const req = https.request(`https://api.telegram.org/bot${CONFIG.tgToken}/${apiPath}`, { method: 'POST', headers }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw).ok === true); } catch (e) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.end(data);
  });
}

const sendTelegram = (message) => tgRequest('sendMessage', {
  chat_id: CONFIG.tgChatId,
  text: `⚠️ SharePoint Cookie 刷新\n\n${message}\n\n服务器: ${CONFIG.hostLabel}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  parse_mode: 'HTML',
});

async function sendTelegramPhoto(filePath, caption) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId || !fs.existsSync(filePath)) return false;
  const boundary = '----spwebdav' + crypto.randomBytes(8).toString('hex');
  const fileBuf = fs.readFileSync(filePath);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CONFIG.tgChatId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return tgRequest('sendPhoto', null, `multipart/form-data; boundary=${boundary}`, Buffer.concat([head, fileBuf, tail]));
}

// ---- 密码自愈 ----
function readHistory() {
  try { return fs.readFileSync(CONFIG.historyFile, 'utf8').split('\n').map(x => x.trim()).filter(Boolean); } catch (e) { return []; }
}

function generatePassword() {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digit = '23456789';
  const symbol = '!@#$%*-+=';
  const all = lower + upper + digit + symbol;
  const history = readHistory();
  let pw = '';
  for (let tries = 0; tries < 50; tries++) {
    const chars = [
      upper[crypto.randomInt(upper.length)],
      lower[crypto.randomInt(lower.length)],
      digit[crypto.randomInt(digit.length)],
      symbol[crypto.randomInt(symbol.length)],
    ];
    while (chars.length < 16) chars.push(all[crypto.randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    pw = chars.join('');
    if (!history.includes(pw) && pw !== CONFIG.password) return pw;
  }
  return pw;
}

function persistNewPassword(newPw) {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).toISOString().slice(0, 10);
  let cfg = fs.readFileSync(CONFIG.envFile, 'utf8');
  cfg = cfg.replace(/^SP_PASSWORD=.*$/m, `SP_PASSWORD=${newPw}`);
  cfg = cfg.replace(/^SP_PASSWORD_START_DATE=.*$/m, `SP_PASSWORD_START_DATE=${today}`);
  const tmp = CONFIG.envFile + '.tmp';
  fs.writeFileSync(tmp, cfg, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG.envFile);
  fs.appendFileSync(CONFIG.historyFile, newPw + '\n', { mode: 0o600 });
  const hist = readHistory();
  if (hist.length > 8) fs.writeFileSync(CONFIG.historyFile, hist.slice(-8).join('\n') + '\n', { mode: 0o600 });
  log(`Password rotated and persisted to ${CONFIG.envFile}; cycle restarted at ${today}`);
  return today;
}

async function handleForcedPasswordChange(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const fields = await page.$$('input[type="password"]');
  const isChangePage = fields.length >= 3 || /Update your password|Enter a new password|Your password has expired|更新.*密码|更改.*密码|密码已过期/i.test(bodyText);
  if (!isChangePage) return null;
  log('Forced password-change page detected - self-healing rotation started', 'WARN');
  if (fields.length < 3) {
    await page.screenshot({ path: shot('sp_rotate_unexpected.png'), fullPage: true }).catch(() => {});
    throw new Error(`Password-change page without 3 fields (found ${fields.length}); manual intervention needed`);
  }
  const newPw = generatePassword();
  await fields[0].click(); await fields[0].type(CONFIG.password, { delay: 50 });
  await fields[1].click(); await fields[1].type(newPw, { delay: 50 });
  await fields[2].click(); await fields[2].type(newPw, { delay: 50 });
  const submit = await page.$('#idSIButton9, input[type="submit"], button[type="submit"]');
  if (!submit) throw new Error('Password-change submit button not found');
  await submit.click();
  await sleep(12000);
  const afterText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/passwords don't match|does not meet|invalid|错误|不匹配|不符合/i.test(afterText) && !onSite(page.url())) {
    await page.screenshot({ path: shot('sp_rotate_rejected.png'), fullPage: true }).catch(() => {});
    throw new Error('Password rotation rejected by tenant policy (see sp_rotate_rejected.png)');
  }
  const startDate = persistNewPassword(newPw);
  await sendTelegram(`🔑 密码到期已自动更换\n\n新密码: <code>${newPw}</code>\n改密日期: ${startDate}\n提醒周期已重置为 90 天。\n手动登录 Web 请使用新密码（或向机器人发 /getpw）。`);
  return newPw;
}

function killZombieChromium() {
  try {
    const result = execSync("ps aux | grep -E 'chrom.*puppeteer|chrom.*headless' | grep -v grep | awk '{print $2}'", { encoding: 'utf8', timeout: 5000 });
    const pids = result.trim().split('\n').filter(Boolean);
    if (pids.length > 5) {
      log(`Killing ${pids.length} zombie Chromium processes`, 'WARN');
      pids.forEach(pid => {
        try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch (e) {}
      });
    }
  } catch (e) {}
}

function shot(name) {
  return path.join(CONFIG.shotDir, name);
}

(async () => {
  if (!acquireLock()) process.exit(0);
  fs.mkdirSync(CONFIG.shotDir, { recursive: true });
  fs.mkdirSync(path.dirname(CONFIG.cookieFile), { recursive: true });

  log('=== Cookie refresh started ===');
  killZombieChromium();

  let browser;
  let authSuccess = false;

  try {
    browser = await puppeteer.launch({
      executablePath: CONFIG.chromiumPath,
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--single-process',
      ],
      timeout: 60000,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Step 1: 导航到站点；云主机到 Microsoft 登录端点链路常抖，重试 3 次
    let usernameInput = null;
    for (let attempt = 1; attempt <= 3 && !usernameInput; attempt++) {
      log(`Navigating to SharePoint (attempt ${attempt}/3)...`);
      try {
        await page.goto(CONFIG.siteUrl, { waitUntil: 'networkidle0', timeout: 60000 });
      } catch (e) {
        log(`Navigation timeout: ${e.message}`, 'WARN');
      }
      await sleep(3000);
      if (onSite(page.url())) break;
      try {
        await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 25000 });
        usernameInput = await page.$('input[type="email"], input[name="loginfmt"]');
      } catch (e) {
        const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        const networkError = /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|连接已中断|网络变化/.test(pageText);
        log(`Login field not ready on attempt ${attempt}: ${networkError ? 'Chromium network error page' : e.message}`, 'WARN');
        await page.screenshot({ path: shot(`sp_login_attempt_${attempt}.png`) }).catch(() => {});
        if (attempt < 3) await sleep(10000);
      }
    }

    // Step 2: 已有会话则直接取 Cookie
    if (onSite(page.url())) {
      log('Already logged in (session still valid), extracting cookies...');
    } else {
      if (!usernameInput) {
        await page.screenshot({ path: shot('sp_login_fail_step1.png') }).catch(() => {});
        throw new Error('Username field not found after 3 attempts - connection to login.microsoftonline.com unstable');
      }
      log('Entering username...');
      await usernameInput.click(); await sleep(500);
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await usernameInput.type(CONFIG.username, { delay: 80 });
      await sleep(500);

      await page.waitForSelector('input[type="submit"], #idSIButton9', { timeout: 20000 });
      const nextBtn = await page.$('input[type="submit"], #idSIButton9');
      if (!nextBtn) throw new Error('Next button not found');
      await nextBtn.click();
      await sleep(3000);

      // Step 3: 密码
      await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 30000 }).catch(() => {});
      const passwordInput = await page.$('input[type="password"], input[name="passwd"]');
      if (!passwordInput) {
        if (onSite(page.url())) {
          log('Already logged in (persistent session)');
        } else {
          await page.screenshot({ path: shot('sp_login_fail_step2.png') }).catch(() => {});
          throw new Error('Password field not found');
        }
      } else {
        log('Entering password...');
        await passwordInput.click(); await sleep(500);
        await passwordInput.type(CONFIG.password, { delay: 80 });
        await sleep(500);

        await page.waitForSelector('input[type="submit"], #idSIButton9', { timeout: 20000 });
        const signInBtn = await page.$('input[type="submit"], #idSIButton9');
        if (!signInBtn) throw new Error('Sign in button not found');
        await signInBtn.click();
        await sleep(8000);

        // Step 3.5: 强制改密页自愈
        const rotated = await handleForcedPasswordChange(page);
        if (rotated) {
          CONFIG.password = rotated;
          await sleep(5000);
        }
      }

      // Step 4: KMSI（"保持登录状态"页）
      await sleep(3000);
      try {
        const url2 = page.url();
        if (url2.includes('login.microsoftonline.com') && !onSite(url2)) {
          const kmsiCheck = await page.$('#KmsiCheckboxField, input[name="DontShowAgain"]');
          if (kmsiCheck) { await kmsiCheck.click(); await sleep(1000); }
          const yesBtn = await page.$('#idSIButton9, input[type="submit"]');
          if (yesBtn) { await yesBtn.click(); await sleep(8000); }
        }
      } catch (e) {
        log(`KMSI step error (non-fatal): ${e.message}`, 'WARN');
      }

      // Step 5: 等待回跳站点
      await sleep(5000);
      try {
        await page.waitForFunction(o => window.location.href.includes(o), siteOrigin, { timeout: 30000 });
      } catch (e) {
        log(`Wait for SharePoint redirect timeout: ${e.message}`, 'WARN');
      }
      await sleep(3000);
    }

    // Step 6: 校验落点
    const finalUrl = page.url();
    if (!finalUrl.includes(siteOrigin.replace('https://', ''))) {
      await page.screenshot({ path: shot('sp_login_fail_final.png') }).catch(() => {});
      throw new Error(`Login failed - ended at: ${finalUrl.substring(0, 100)}`);
    }
    log(`Logged in successfully: ${finalUrl.substring(0, 80)}`);

    // Step 7: 访问文档库拿全 Cookie
    try {
      await page.goto(CONFIG.docsUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    } catch (e) {
      log(`Docs navigation timeout (non-fatal): ${e.message}`, 'WARN');
    }
    await sleep(3000);

    // Step 8: 提取并保存
    const cookies = await page.cookies();
    const fedAuth = cookies.find(c => c.name === 'FedAuth');
    const rtFa = cookies.find(c => c.name === 'rtFa');
    if (!fedAuth || !rtFa) {
      throw new Error(`Missing critical cookies: FedAuth=${!!fedAuth}, rtFa=${!!rtFa}`);
    }
    log(`Got FedAuth (${fedAuth.value.length}) + rtFa (${rtFa.value.length}) + ${cookies.length - 2} other cookies`);

    const cookieData = {
      savedAt: new Date().toISOString(),
      username: CONFIG.username,
      siteUrl: CONFIG.siteUrl,
      cookieCount: cookies.length,
      cookies: cookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain,
        path: c.path || '/', expires: c.expires,
        httpOnly: c.httpOnly || false, secure: c.secure || false,
      })),
    };
    fs.writeFileSync(CONFIG.cookieFile, JSON.stringify(cookieData, null, 2), { mode: 0o600 });

    // 热更新 rclone.conf：chunker 透传 webdav 头，必须同步写进 remote 配置
    try {
      const cookiesStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const headersLine = `headers = Cookie,${cookiesStr}`;
      let config = fs.readFileSync(CONFIG.rcloneConf, 'utf8');
      const remote = escapeReg(CONFIG.rcloneRemote);
      const withHeaders = new RegExp(`^(\\[${remote}\\].*?\\n)headers = .*`, 'ms');
      const sectionOnly = new RegExp(`(\\[${remote}\\].*?vendor = other)`, 's');
      if (withHeaders.test(config)) config = config.replace(withHeaders, `$1${headersLine}`);
      else config = config.replace(sectionOnly, `$1\n${headersLine}`);
      fs.writeFileSync(CONFIG.rcloneConf, config);
      log('Rclone config headers updated');
    } catch (e) {
      log(`Failed to update rclone config headers: ${e.message}`, 'WARN');
    }

    authSuccess = true;
    fs.writeFileSync(CONFIG.heartbeatFile, new Date().toISOString() + '\n', { mode: 0o644 });
    log('Heartbeat written');
    log('Cookies saved successfully');

    // Step 9: 非阻塞重启挂载服务
    try {
      execSync(`systemctl restart --no-block ${CONFIG.rcloneService}.service 2>&1 || true`, { timeout: 15000, encoding: 'utf8' });
      log('Rclone service restart triggered');
    } catch (e) {
      log(`Rclone restart note: ${e.message} (cookies saved, service will use them on next cycle)`, 'WARN');
    }
  } catch (error) {
    log(`FATAL: ${error.message}`, 'ERROR');
    if (CONFIG.notifyOnFailure) {
      await sendTelegram(`❌ 登录失败\n\n错误: ${error.message}\n\n需要手动检查服务器`);
      const latest = [shot('sp_login_fail_final.png'), shot('sp_login_fail_step2.png'), shot('sp_login_fail_step1.png'), shot('sp_rotate_rejected.png')]
        .map(f => ({ f, t: fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0 }))
        .filter(x => x.t > 0)
        .sort((a, b) => b.t - a.t)[0];
      if (latest && Date.now() - latest.t < 300000) {
        await sendTelegramPhoto(latest.f, `登录失败截图: ${path.basename(latest.f)}`);
      }
    } else {
      log('Failure notification suppressed; scheduler will retry soon', 'WARN');
    }
    authSuccess = false;
  } finally {
    try {
      if (browser) {
        const pages = await browser.pages();
        for (const p of pages) { try { await p.close(); } catch (e) {} }
        await browser.close();
      }
    } catch (e) {
      log(`Browser cleanup error: ${e.message}`, 'WARN');
    }
    killZombieChromium();
    log(`=== Cookie refresh ${authSuccess ? 'SUCCESS' : 'FAILED'} ===`);
    releaseLock();
    process.exitCode = authSuccess ? 0 : 1;
  }
})();
