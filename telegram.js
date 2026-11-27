"use strict";

const fs = require("fs");
const path = require("path");

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
}

async function notifyTelegram({ caption, imagePath }) {
  const token = (process.env.TG_BOT_TOKEN || "").trim();
  const chatId = (process.env.TG_CHAT_ID || "").trim();

  if (!token || !chatId) {
    console.log("ℹ️ 未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过 Telegram 通知。");
    return;
  }

  const safeCaption = String(caption || "").slice(0, 1000);

  try {
    if (imagePath && fs.existsSync(imagePath)) {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", safeCaption);
      form.append("parse_mode", "HTML");
      const fileBuf = fs.readFileSync(imagePath);
      form.append("photo", new Blob([fileBuf], { type: "image/png" }), path.basename(imagePath));

      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        console.error(`⚠️ Telegram sendPhoto 失败 (${res.status}): ${await res.text()}`);
      } else {
        console.log("📨 Telegram 截图通知已发送。");
      }
      return;
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: safeCaption,
        parse_mode: "HTML",
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      console.error(`⚠️ Telegram sendMessage 失败 (${res.status}): ${await res.text()}`);
    } else {
      console.log("📨 Telegram 文本通知已发送。");
    }
  } catch (err) {
    console.error(`⚠️ 发送 Telegram 通知异常: ${err.message}`);
  }
}

module.exports = { escapeHtml, notifyTelegram };
