#!/usr/bin/env node
/**
 * 租户强制改密页自动改密辅助脚本（公开脱敏版）
 * 场景：90 天密码到期后，登录流会落入 "Update your password" 页，
 *       Cookie 刷新脚本因此失败；本脚本走完整改密流并验证回到站点。
 * 用法：SP_USERNAME=.. SP_CURRENT_PASSWORD=.. SP_NEW_PASSWORD=.. node sp-change-password.js
 * 依赖：与 sp-cookie-refresh.js 相同（puppeteer-extra + stealth）
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const username = process.env.SP_USERNAME;
const currentPassword = process.env.SP_CURRENT_PASSWORD;
const newPassword = process.env.SP_NEW_PASSWORD;
const chromiumPath = process.env.SP_CHROMIUM_PATH || '/usr/bin/chromium';
const siteUrl = (process.env.SP_SITE_URL || '').replace(/\/+$/, '');
const shotDir = process.env.SP_SHOT_DIR || '/var/lib/sp-webdav/shots';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!username || !currentPassword || !newPassword || !siteUrl) {
  console.error('SP_USERNAME / SP_CURRENT_PASSWORD / SP_NEW_PASSWORD / SP_SITE_URL are required');
  process.exit(2);
}
const siteOrigin = new URL(siteUrl).origin;

async function waitAndClick(page, selector, timeout = 30000) {
  await page.waitForSelector(selector, { timeout });
  const element = await page.$(selector);
  if (!element) throw new Error(`Selector not found: ${selector}`);
  await element.click();
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--single-process',
    ],
    timeout: 60000,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    console.log('Opening SharePoint...');
    await page.goto(siteUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(error => {
      console.log(`Navigation warning: ${error.message}`);
    });

    if (!page.url().includes(siteOrigin.replace('https://', '')) || page.url().includes('login.microsoftonline.com')) {
      console.log('Entering username...');
      await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 60000 });
      const usernameInput = await page.$('input[type="email"], input[name="loginfmt"]');
      await usernameInput.click();
      await usernameInput.type(username, { delay: 60 });
      await waitAndClick(page, 'input[type="submit"], #idSIButton9');

      console.log('Entering current password...');
      await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 60000 });
      const passwordInput = await page.$('input[type="password"], input[name="passwd"]');
      await passwordInput.click();
      await passwordInput.type(currentPassword, { delay: 60 });
      await waitAndClick(page, 'input[type="submit"], #idSIButton9');
      await sleep(8000);
    }

    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const passwordInputs = await page.$$('input[type="password"]');
    if (/Update your password|Enter a new password|更新.*密码|更改.*密码/i.test(bodyText) || passwordInputs.length >= 3) {
      console.log('Password update page detected. Filling new password...');
      const fields = await page.$$('input[type="password"]');
      if (fields.length < 3) {
        await page.screenshot({ path: `${shotDir}/sp_password_change_unexpected.png`, fullPage: true }).catch(() => {});
        throw new Error(`Expected 3 password fields, found ${fields.length}`);
      }
      await fields[0].click();
      await fields[0].type(currentPassword, { delay: 50 });
      await fields[1].click();
      await fields[1].type(newPassword, { delay: 50 });
      await fields[2].click();
      await fields[2].type(newPassword, { delay: 50 });
      await waitAndClick(page, 'input[type="submit"], #idSIButton9, button[type="submit"]');
      await sleep(15000);
    } else {
      console.log('No password update page detected. Continuing verification...');
    }

    try {
      await page.waitForFunction(o => window.location.href.includes(o), siteOrigin.replace('https://', ''), { timeout: 60000 });
    } catch (error) {
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      await page.screenshot({ path: `${shotDir}/sp_password_change_failed.png`, fullPage: true }).catch(() => {});
      throw new Error(`Password change/login did not reach SharePoint. URL=${page.url()} TEXT=${text.slice(0, 800)}`);
    }

    console.log(`SUCCESS ${page.url()}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(`FAILED ${error.message}`);
  process.exit(1);
});
