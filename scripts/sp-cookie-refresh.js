#!/usr/bin/env node
/**
 * SharePoint Cookie Refresher（公开脱敏版）
 * - 无头 Chromium 模拟登录 Microsoft，提取 FedAuth + rtFa
 * - Cookie 落盘 cookies.json，并热更新 rclone.conf 的 webdav remote 头
 * - 锁文件防并发；非阻塞重启 rclone 服务
 * - 导航 3 次重试（对抗 ERR_NETWORK_CHANGED 等链路抖动），失败留截图
 * - Telegram 仅在真实认证失败时通知（SP_NOTIFY_FAILURE=0 时首败静默）
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
const { execSync } = require('child_process');

const env = process.env;
const siteUrl = (env.SP_SITE_URL || '').replace(/\/+$/, '');
if (!siteUrl || !env.SP_USERNAME || !env.SP_PASSWORD) {
  console.error('Missing required env: SP_SITE_URL / SP_USERNAME / SP_PASSWORD');
  process.exit(2);
}

const siteOrigin = new URL(siteUrl).origin;
const sitePath = new URL(siteUrl).pathname.replace(/\/+$/, '');

const CONFIG = {
  username: env.SP_USERNAME,
  password: env.SP_PASSWORD,
  siteUrl,
  docsUrl: (env.SP_DOCS_URL || `${siteUrl}/Shared%20Documents`),
  cookieFile: env.SP_COOKIE_FILE || '/var/lib/sp-webdav/cookies.json',
  logFile: env.SP_LOG_FILE || '/var/log/sp-webdav-cookie-refresh.log',
  lockFile: env.SP_LOCK_FILE || '/run/sp-webdav-cookie-refresh.lock',
  shotDir: env.SP_SHOT_DIR || '/var/lib/sp-webdav/shots',
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

const sendTelegram = (message) => {
  return new Promise((resolve) => {
    if (!CONFIG.tgToken || !CONFIG.tgChatId) return resolve();
    const text = encodeURIComponent(`⚠️ SharePoint Cookie 刷新\n\n${message}\n\n服务器: ${CONFIG.hostLabel}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    const url = `https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage?chat_id=${CONFIG.tgChatId}&text=${text}&parse_mode=HTML`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) log('Telegram notification sent');
          else log(`Telegram failed: ${data}`, 'WARN');
        } catch (e) {}
        resolve();
      });
    }).on('error', (e) => {
      log(`Telegram error: ${e.message}`, 'WARN');
      resolve();
    });
  });
};

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
