"use strict";

const { chromium } = require("playwright");
const { startSingbox } = require("./singbox");
const { escapeHtml, notifyTelegram } = require("./telegram");

const EMAIL = (process.env.SEEDLOAF_EMAIL || "").trim();
const PASSWORD = (process.env.SEEDLOAF_PASSWORD || "").trim();
const WORLD_ID = (process.env.SEEDLOAF_WORLD_ID || "").trim();
const PROXY_URI = (process.env.PROXY_URI || "").trim();

const TARGET_URL = WORLD_ID
  ? `https://seedloaf.com/dashboard/${WORLD_ID}/console`
  : "https://seedloaf.com/dashboard";

function getBeijingTime() {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

async function detectExitIp(context) {
  try {
    const res = await context.request.get("https://api.ipify.org?format=json", {
      timeout: 15000,
    });
    if (res.ok()) {
      const data = await res.json();
      if (data && data.ip) return String(data.ip);
    }
  } catch (_) {}
  return "获取失败";
}

function buildCaption({ title, statusText, exitIp, proxyLabel, detail }) {
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    `时间：<code>${escapeHtml(getBeijingTime())}</code>`,
    `状态：${escapeHtml(statusText)}`,
    `出口：<code>${escapeHtml(proxyLabel)}</code> (<code>${escapeHtml(exitIp)}</code>)`,
  ];
  if (detail) lines.push(`说明：${escapeHtml(detail)}`);
  return lines.join("\n");
}

async function clickLoginSubmit(page) {
  const formSubmit = page
    .locator('form button[type="submit"], button[data-localization-key="formButtonPrimary"]')
    .filter({ hasNotText: /Discord|Google|GitHub/i })
    .first();

  if (await formSubmit.isVisible().catch(() => false)) {
    await formSubmit.click();
    return;
  }

  const fallbackContinue = page
    .getByRole("button", { name: /^Continue/i })
    .filter({ hasNotText: /Discord|Google|GitHub/i })
    .last();

  await fallbackContinue.waitFor({ state: "visible", timeout: 10000 });
  await fallbackContinue.click();
}

async function dismissConsentModal(page) {
  const scopes = [page, ...page.frames()];
  for (const scope of scopes) {
    try {
      const candidates = [
        scope.locator("button.fc-cta-consent").first(),
        scope.getByRole("button", { name: /^Consent$/i }).first(),
        scope.locator("button.fc-cta-do-not-consent").first(),
        scope.getByRole("button", { name: /^Do not consent$/i }).first(),
        scope.getByRole("button", { name: /^(Accept all|Agree|I agree)$/i }).first(),
      ];

      for (const btn of candidates) {
        if (await btn.isVisible().catch(() => false)) {
          console.log("🍪 检测到隐私同意弹窗，正在自动关闭...");
          await btn.click({ timeout: 5000 });
          await page.waitForTimeout(1500);
          return true;
        }
      }
    } catch (_) {}
  }

  // 兜底：若仍残留 Google CMP 遮罩层则直接移除 DOM
  const removed = await page
    .evaluate(() => {
      const root = document.querySelector(".fc-consent-root");
      if (root) {
        root.remove();
        return true;
      }
      return false;
    })
    .catch(() => false);

  if (removed) {
    console.log("🍪 已强制清理残留的隐私遮罩层。");
    await page.waitForTimeout(500);
  }
  return removed;
}

async function run() {
  if (!EMAIL || !PASSWORD) {
    console.error("❌ 缺少环境变量：请配置 SEEDLOAF_EMAIL 和 SEEDLOAF_PASSWORD");
    process.exit(1);
  }

  let singbox = null;
  let browser = null;
  let page = null;
  let proxyLabel = "直连 (GitHub Actions)";
  let exitIp = "未知";

  try {
    // 1. 如配置了节点，启动 sing-box
    if (PROXY_URI) {
      console.log("🔌 正在解析节点并启动 sing-box...");
      singbox = await startSingbox(PROXY_URI);
      proxyLabel = `${singbox.protocol} | ${singbox.nodeName}`;
      console.log(`✅ sing-box 已就绪: ${proxyLabel} -> ${singbox.proxyUrl}`);
    } else {
      console.log("ℹ️ 未配置 PROXY_URI，将使用直连模式。");
    }

    // 2. 启动 Playwright 浏览器并挂载代理
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    if (singbox) {
      contextOptions.proxy = { server: singbox.proxyUrl };
    }

    const context = await browser.newContext(contextOptions);
    exitIp = await detectExitIp(context);
    console.log(`🌍 当前出口 IP: ${exitIp}`);

    page = await context.newPage();

    // 3. 访问目标面板
    console.log(`🌐 正在访问: ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    // 4. 自动处理 Clerk 邮箱密码登录
    if (page.url().includes("accounts.seedloaf.com") || page.url().includes("sign-in")) {
      console.log("🔐 检测到登录页面，开始邮箱密码登录...");

      const emailInput = page.locator('input[name="identifier"], input[type="email"]').first();
      await emailInput.waitFor({ state: "visible", timeout: 25000 });
      await emailInput.fill(EMAIL);

      const passwordInput = page.locator('input[name="password"], input[type="password"]').first();

      if (await passwordInput.isVisible()) {
        await passwordInput.fill(PASSWORD);
        await clickLoginSubmit(page);
      } else {
        await clickLoginSubmit(page);
        await passwordInput.waitFor({ state: "visible", timeout: 20000 });
        await passwordInput.fill(PASSWORD);
        await clickLoginSubmit(page);
      }

      console.log("⏳ 等待登录跳转回面板...");
      await page.waitForURL(/seedloaf\.com\/dashboard/, { timeout: 45000 });
      console.log("✅ 登录成功");

      if (WORLD_ID && !page.url().includes(WORLD_ID)) {
        await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      }
    }

    // 5. 等待控制台状态同步并清理隐私弹窗
    await page.waitForTimeout(6000);
    await dismissConsentModal(page);
    await page.screenshot({ path: "before-action.png", fullPage: true });

    const startBtn = page.getByRole("button", { name: /Start World/i }).first();
    const stopBtn = page.getByRole("button", { name: /Stop World/i }).first();

    if (await stopBtn.isVisible()) {
      console.log("🟢 服务器正在运行中（ONLINE），无需启动。");
      await notifyTelegram({
        caption: buildCaption({
          title: "🟢 Seedloaf 巡检正常",
          statusText: "运行中 (ONLINE)",
          exitIp,
          proxyLabel,
          detail: "服务器在线，无需操作。",
        }),
        imagePath: "before-action.png",
      });
    } else if (await startBtn.isVisible()) {
      console.log("🔴 检测到服务器已停机（OFFLINE），正在点击 Start World...");
      await dismissConsentModal(page);
      await startBtn.click();

      await page.waitForTimeout(12000);
      await page.screenshot({ path: "after-start.png", fullPage: true });

      const stillStartVisible = await startBtn.isVisible().catch(() => false);
      if (!stillStartVisible) {
        console.log("🚀 启动指令已生效，服务器正在启动或已上线。");
        await notifyTelegram({
          caption: buildCaption({
            title: "🚀 Seedloaf 已自动开机",
            statusText: "已触发启动",
            exitIp,
            proxyLabel,
            detail: "检测到停机并已点击 Start World，请查看截图确认。",
          }),
          imagePath: "after-start.png",
        });
      } else {
        console.log("⚠️ 已点击 Start World，但按钮仍然可见。");
        await notifyTelegram({
          caption: buildCaption({
            title: "⚠️ Seedloaf 启动结果待确认",
            statusText: "已点击 Start World，但按钮仍可见",
            exitIp,
            proxyLabel,
            detail: "可能正在排队或触发限制，请查看截图。",
          }),
          imagePath: "after-start.png",
        });
      }
    } else {
      console.log("⚠️ 未检测到 Start World 或 Stop World 按钮。");
      await notifyTelegram({
        caption: buildCaption({
          title: "⚠️ Seedloaf 状态未知",
          statusText: "未找到启动/停止按钮",
          exitIp,
          proxyLabel,
          detail: "可能正在启动中、页面未加载完或触发了人机验证，请看截图。",
        }),
        imagePath: "before-action.png",
      });
    }
  } catch (error) {
    console.error("❌ 执行失败:", error.message);
    let errorImg = null;
    if (page) {
      try {
        await page.screenshot({ path: "error.png", fullPage: true });
        errorImg = "error.png";
      } catch (_) {}
    }

    await notifyTelegram({
      caption: buildCaption({
        title: "❌ Seedloaf 巡检失败",
        statusText: "执行异常",
        exitIp,
        proxyLabel,
        detail: error.message,
      }),
      imagePath: errorImg,
    });

    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (singbox) {
      await singbox.stop().catch(() => {});
    }
  }
}

run();
