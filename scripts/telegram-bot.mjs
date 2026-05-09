import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as authStore from "./bot-auth-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function loadLocalEnv() {
  const envPath = join(projectRoot, ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment or .env");
  process.exit(1);
}

const TELEGRAM_OWNER_ID = Number.parseInt(String(process.env.TELEGRAM_OWNER_ID || "").trim(), 10);
if (!Number.isFinite(TELEGRAM_OWNER_ID)) {
  console.error("Set TELEGRAM_OWNER_ID in .env (numeric Telegram user ID of bot owner).");
  process.exit(1);
}

authStore.bootstrapOwner(TELEGRAM_OWNER_ID);
console.log(`[auth] Approval DB ready: ${authStore.dbPathResolved()} (owner ${TELEGRAM_OWNER_ID})`);

/** Owner from env cannot be blocked; everyone else respects `blocked_users` table. */
function userIsEffectivelyBlockedTelegramUid(uid) {
  if (!Number.isFinite(uid) || uid === TELEGRAM_OWNER_ID) return false;
  return authStore.isBlocked(uid);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_TIMEOUT_SECONDS = 30;
const FLOW_TIMEOUT_MS = Number(process.env.BOT_FLOW_TIMEOUT_MS || 180000);
const BOT_VERBOSE_LOGS = !/^(0|false|no)$/i.test(String(process.env.BOT_VERBOSE_LOGS || "true"));
/** How many browser flows may run at once (different chats). Default 3. */
const BOT_MAX_CONCURRENT_FLOWS = Math.max(
  1,
  Math.min(32, Number(process.env.BOT_MAX_CONCURRENT_FLOWS || 3) || 3)
);

function createConcurrencyLimiter(maxConcurrent) {
  let active = 0;
  const waitQueue = [];

  const pump = () => {
    while (active < maxConcurrent && waitQueue.length > 0) {
      const { fn, resolve, reject } = waitQueue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        waitQueue.push({ fn, resolve, reject });
        pump();
      });
    },
    getSlotsInUse() {
      return active;
    },
    getWaiting() {
      return waitQueue.length;
    },
  };
}

const flowLimiter = createConcurrencyLimiter(BOT_MAX_CONCURRENT_FLOWS);
/** One in-flight automation per chat (avoid double /joinpromo for same user). */
const chatAutomationBusy = new Set();
/** Pending admin conversational step: add admin or broadcast body */
const adminConversation = new Map();

let nextUpdateOffset = 0;

async function telegramRequest(method, payload) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Telegram API ${method} failed: ${res.status} ${txt}`);
  }
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram API ${method} not ok: ${JSON.stringify(json)}`);
  }
  return json.result;
}

async function sendMessage(chatId, text) {
  if (BOT_VERBOSE_LOGS) {
    console.log(`[bot->chat:${chatId}] ${text.replace(/\s+/g, " ").slice(0, 220)}`);
  }
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendMessageMarkup(chatId, text, replyMarkup) {
  if (BOT_VERBOSE_LOGS) {
    console.log(`[bot->chat:${chatId}] (keyboard) ${text.replace(/\s+/g, " ").slice(0, 180)}`);
  }
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}

async function answerCallback(callbackQueryId, text, showAlert = false) {
  await telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: text.slice(0, 200) } : {}),
    show_alert: showAlert,
  });
}

function fmtUserPlain(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "User";
  const un = from.username ? ` @${from.username}` : "";
  return `${name}${un}\nTelegram ID: ${from.id}`;
}

function normalizeCmd(word) {
  return String(word || "").replace(/^(\/\w+)(@\w+)?$/i, "$1").toLowerCase();
}

function isAdminCmd(text) {
  return /^\/admin(?:@\w+)?(\s|$)/i.test(String(text || "").trim());
}

function parseLoginCommand(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/login(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) return null;
  const identifier = match[1].trim();
  const password = match[2].trim();
  if (!identifier || !password) return null;
  const amount = "1000";
  const promotionId = "22";
  const site = "https://playkaro365.com";
  const proxy = "";
  const joinUrl = "";
  return { site, identifier, password, amount, promotionId, proxy, joinUrl };
}

function parseJoinPromoCommand(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 5) return null;
  if (normalizeCmd(parts[0]) !== "/joinpromo") return null;
  const site = parts[1].trim();
  const identifier = parts[2].trim();
  const password = parts[3].trim();
  const amount = parts[4].trim();
  const proxy = parts[5] ? parts[5].trim() : "";
  const joinUrl = parts[6] ? parts[6].trim() : "";
  if (!site || !identifier || !password || !amount) return null;
  const promotionId = "22";
  return { site, identifier, password, amount, promotionId, proxy, joinUrl };
}

/** Avoid matching our own "AWS WAF token" diagnostic lines. */
function chunkLooksLikeWafChallengePage(chunk) {
  if (/--- AWS WAF token/i.test(chunk)) return false;
  return (
    /awsWafCookieDomainList/i.test(chunk) ||
    /window\.gokuProps/i.test(chunk) ||
    /Human Verification/i.test(chunk)
  );
}

/** Join status must not pick up Login API `"status":200`; only read after join block. */
function extractJoinPromotionStatus(logs) {
  const parts = logs.split(/--- Join promotion API response/i);
  if (parts.length < 2) return null;
  const lastBlock = parts[parts.length - 1];
  const m = lastBlock.match(/"status"\s*:\s*(\d{3})/);
  return m ? Number(m[1]) : null;
}

function joinPromotionChallengeFromLogs(logs) {
  const parts = logs.split(/--- Join promotion API response/i);
  if (parts.length < 2) return false;
  return /"challengeDetected"\s*:\s*true/i.test(parts[parts.length - 1]);
}

function deriveLoginSuccessFromLogs(logs) {
  if (/\bLOGIN_CONFIRM_TAIL:\s*yes\b/.test(logs)) return true;
  if (logs.includes('"message":"Login Success"')) return true;
  if (/--- Login API response ---[\s\S]{0,12000}\bLogin Success\b/i.test(logs)) return true;
  if (/\bLOGIN_FLOW_MARK:\s*html_shell_ok\b/.test(logs)) return true;
  if (
    /\bLOGIN_FLOW_MARK:\s*(?:json_plain_success|json_success_flag|json_status_msg|json_status_id|json_redirect)\b/.test(
      logs
    )
  ) {
    return true;
  }
  /** Large HTML skins log `loginSucceeded=true` inside the capped login summary JSON */
  if (/\[\s*HTML\/non-JSON login body truncated[^\]]*loginSucceeded\s*=\s*true\s*\]/i.test(logs))
    return true;
  return false;
}

function runPlaykaroFlow({ site, identifier, password, amount, promotionId, proxy, joinUrl }) {
  return new Promise((resolve) => {
    const normalizedSite = /^https?:\/\//i.test(site) ? site : `https://${site}`;
    const env = {
      ...process.env,
      /** Unique folder under browser_profiles/ so concurrent bot users do not lock the same browser profile */
      PLAY_BROWSER_PROFILE_SUFFIX: randomBytes(10).toString("hex"),
      PLAYKARO_EMAIL: identifier,
      PLAYKARO_PASSWORD: password,
      PLAYKARO_PROMO_AMOUNT: amount,
      PLAYKARO_PROMOTION_ID: promotionId,
      PLAY_SITE_URL: normalizedSite,
      ...(proxy ? { PLAY_PROXY_URL: proxy } : {}),
      ...(joinUrl ? { PLAY_JOIN_URL: joinUrl } : {}),
      /** Omit default: playkaro-full-flow auto headless on Linux when DISPLAY is unset (servers). */
      PLAYKARO_VERBOSE: "false",
    };
    const siteOrigin = (() => {
      try {
        return new URL(normalizedSite).origin;
      } catch {
        return normalizedSite;
      }
    })();
    const expectedLocation = `${siteOrigin}/promotions/${promotionId}`;

    const child = spawn(process.execPath, ["scripts/playkaro-full-flow.mjs"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let logs = "";
    const cap = 30000;
    let loginSuccessSeen = false;
    let joinSectionSeen = false;
    let locationOkSeen = false;
    let badCredentialSeen = false;
    let wafChallengeSeen = false;
    let blockedBeforeLoginSeen = false;
    const append = (chunk) => {
      if (BOT_VERBOSE_LOGS) {
        process.stdout.write(`[flow] ${chunk}`);
      }
      logs += chunk;
      if (logs.length > cap) logs = logs.slice(logs.length - cap);
      if (deriveLoginSuccessFromLogs(logs)) loginSuccessSeen = true;
      if (/--- Join promotion API response/i.test(chunk)) joinSectionSeen = true;
      if (chunk.includes(`"location": "${expectedLocation}"`)) locationOkSeen = true;
      if (/Username or Password Incorrect/i.test(chunk)) badCredentialSeen = true;
      if (chunkLooksLikeWafChallengePage(chunk)) wafChallengeSeen = true;
      if (/Flow blocked: received 403 page|Flow blocked: login fields not available/i.test(chunk)) {
        blockedBeforeLoginSeen = true;
      }
    };

    let finished = false;
    const done = (payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(flowTimer);
      resolve(payload);
    };

    const flowTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const joinStatusFinal = extractJoinPromotionStatus(logs);
      const join302Final = joinStatusFinal === 302;
      const wafFinal = wafChallengeSeen || joinPromotionChallengeFromLogs(logs);
      done({
        code: 124,
        loginSuccess: loginSuccessSeen || deriveLoginSuccessFromLogs(logs),
        joinHit: joinSectionSeen || /--- Join promotion API response/i.test(logs),
        join302: join302Final,
        locationOk:
          locationOkSeen ||
          logs.includes(`"location": "${expectedLocation}"`),
        joinStatus: joinStatusFinal,
        badCredentialSeen,
        wafChallengeSeen: wafFinal,
        blockedBeforeLoginSeen,
        timedOut: true,
        logs,
      });
    }, FLOW_TIMEOUT_MS);

    child.stdout.on("data", (d) => append(String(d)));
    child.stderr.on("data", (d) => append(String(d)));
    child.on("error", (err) => {
      done({
        code: 1,
        loginSuccess: false,
        joinHit: false,
        join302: false,
        locationOk: false,
        joinStatus: null,
        badCredentialSeen: false,
        wafChallengeSeen: false,
        blockedBeforeLoginSeen: false,
        timedOut: false,
        logs: `${logs}\nchild error: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      const joinStatusFinal = extractJoinPromotionStatus(logs);
      const join302Final = joinStatusFinal === 302;
      const wafFinal = wafChallengeSeen || joinPromotionChallengeFromLogs(logs);
      const loginSuccess = loginSuccessSeen || deriveLoginSuccessFromLogs(logs);
      const joinHit = joinSectionSeen || /--- Join promotion API response/i.test(logs);
      const locationOk =
        locationOkSeen || logs.includes(`"location": "${expectedLocation}"`);
      done({
        code: Number(code ?? 1),
        loginSuccess,
        joinHit,
        join302: join302Final,
        locationOk,
        joinStatus: joinStatusFinal,
        badCredentialSeen,
        wafChallengeSeen: wafFinal,
        blockedBeforeLoginSeen,
        timedOut: false,
        logs,
      });
    });
  });
}

function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Approve User", callback_data: "adm:lua" }],
      [{ text: "Reject User", callback_data: "adm:lur" }],
      [{ text: "Approved list", callback_data: "adm:laa" }],
      [{ text: "Block user", callback_data: "adm:lub" }],
      [{ text: "Block by Telegram ID", callback_data: "adm:bui" }],
      [{ text: "Unblock user", callback_data: "adm:luu" }],
      [{ text: "Add Admin", callback_data: "adm:aa" }],
      [{ text: "Remove Admin", callback_data: "adm:la" }],
      [{ text: "Broadcast Message", callback_data: "adm:bc" }],
    ],
  };
}

async function sendAdminHome(chatId) {
  await sendMessageMarkup(chatId, "Admin panel — choose an action:", adminPanelKeyboard());
}

async function notifyAdminsOfNewPending(fromUser, touch) {
  if (!touch.isNew || touch.status !== "pending") return;
  if (authStore.isAdmin(fromUser.id)) return;
  const line = `New user — Pending approval\n${fmtUserPlain(fromUser)}\nUse /admin to review.`;
  for (const aid of authStore.notifyAdminIds()) {
    try {
      await sendMessage(aid, line);
    } catch {
      /* ignore */
    }
  }
}

async function handleAdminConversation(adminId, chatId, text, message) {
  const step = adminConversation.get(adminId);
  if (!step) return false;
  if (text.trim() === "/cancel") {
    adminConversation.delete(adminId);
    await sendMessage(chatId, "Cancelled.");
    await sendAdminHome(chatId);
    return true;
  }
  if (step === "BLOCK_BY_ID") {
    adminConversation.delete(adminId);
    let fwdUser = message.forward_from;
    const fo = message.forward_origin;
    if (!fwdUser && fo?.type === "user" && fo.sender_user) fwdUser = fo.sender_user;
    const tid =
      fwdUser?.id ?? Number.parseInt(String(text).replace(/\s+/g, "").trim(), 10);
    if (!Number.isFinite(tid)) {
      await sendMessage(chatId, "Invalid Telegram user ID.");
      await sendAdminHome(chatId);
      return true;
    }
    if (tid === TELEGRAM_OWNER_ID) {
      await sendMessage(chatId, "Cannot block the bot owner.");
      await sendAdminHome(chatId);
      return true;
    }
    const r = authStore.blockUser(tid, adminId, "");
    if (!r.ok) await sendMessage(chatId, `Block failed: ${r.error}`);
    else {
      await sendMessage(chatId, `User ${tid} is now blocked.`);
      try {
        await sendMessage(
          tid,
          "Access Denied.\nYour account has been blocked by an administrator."
        );
      } catch {
        /* */
      }
    }
    await sendAdminHome(chatId);
    return true;
  }
  if (step === "ADD_ADMIN") {
    adminConversation.delete(adminId);
    let fwdUser = message.forward_from;
    const fo = message.forward_origin;
    if (!fwdUser && fo?.type === "user" && fo.sender_user) fwdUser = fo.sender_user;
    const newId =
      fwdUser?.id ?? Number.parseInt(String(text).replace(/\s+/g, "").trim(), 10);
    if (!Number.isFinite(newId)) {
      await sendMessage(chatId, "Invalid Telegram user ID.");
      await sendAdminHome(chatId);
      return true;
    }
    const r = authStore.addAdministrator(newId, adminId);
    if (!r.ok) await sendMessage(chatId, `Add admin failed: ${r.error}`);
    else {
      await sendMessage(chatId, `Admin added: ${newId}`);
      try {
        await sendMessage(
          newId,
          "You were added as a bot administrator.\n/admin opens the administrator panel."
        );
      } catch {
        /* user may never have messaged bot */
      }
    }
    await sendAdminHome(chatId);
    return true;
  }
  if (step === "BROADCAST") {
    adminConversation.delete(adminId);
    const targets = authStore.getApprovedUserIds();
    let delivered = 0;
    let failed = 0;
    const body = `Broadcast\n\n${text}`;
    for (const tid of targets) {
      try {
        await sendMessage(tid, body);
        delivered++;
        await new Promise((r) => setTimeout(r, 55));
      } catch {
        failed++;
      }
    }
    await sendMessage(
      chatId,
      `Broadcast done. Approx. delivered ${delivered}; failed ${failed} (blocked chat / bot not started).`
    );
    await sendAdminHome(chatId);
    return true;
  }
  return false;
}

async function sendApprovedUserList(chatId) {
  const rows = authStore.listApprovedUsersDetailed(100);
  if (rows.length === 0) {
    await sendMessage(chatId, "No approved users.");
    await sendAdminHome(chatId);
    return;
  }
  const lines = ["Approved users (ID — username — name):", ""];
  for (const u of rows) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || "(no name)";
    const un = u.username ? `@${String(u.username).replace(/^@/, "")}` : "—";
    const bl = authStore.isBlocked(u.telegram_user_id) ? " [blocked]" : "";
    lines.push(`${u.telegram_user_id} — ${un} — ${name}${bl}`);
  }
  const body = lines.join("\n");
  const maxChunk = 3500;
  for (let i = 0; i < body.length; i += maxChunk) {
    await sendMessage(chatId, body.slice(i, i + maxChunk));
  }
  await sendAdminHome(chatId);
}

async function sendApprovedBlockPickList(chatId) {
  const rows = authStore.listApprovedUsersDetailed(25);
  const pick = rows.filter(
    (u) =>
      Number(u.telegram_user_id) !== TELEGRAM_OWNER_ID && !authStore.isBlocked(u.telegram_user_id)
  );
  if (pick.length === 0) {
    const msg =
      rows.length === 0
        ? "No approved users to block."
        : "No one in this list can be blocked (owner is protected; others may already be blocked). Use Block by Telegram ID if needed.";
    await sendMessage(chatId, msg);
    await sendAdminHome(chatId);
    return;
  }
  const kb = [];
  for (const u of pick) {
    const label = `${(u.first_name || "User").slice(0, 16)} (${u.telegram_user_id})`.slice(
      0,
      58
    );
    kb.push([{ text: `Block: ${label}`, callback_data: `adm:bk:${u.telegram_user_id}` }]);
  }
  kb.push([{ text: "<< Admin menu", callback_data: "adm:mn" }]);
  await sendMessageMarkup(chatId, "Pick an approved user to block:", {
    inline_keyboard: kb,
  });
}

async function sendBlockedUnblockPickList(chatId) {
  const rows = authStore.listBlockedUsers(25);
  if (rows.length === 0) {
    await sendMessage(chatId, "No blocked users.");
    await sendAdminHome(chatId);
    return;
  }
  const kb = [];
  for (const r of rows) {
    const id = r.telegram_user_id;
    kb.push([{ text: `Unblock: ${id}`, callback_data: `adm:ub:${id}` }]);
  }
  kb.push([{ text: "<< Admin menu", callback_data: "adm:mn" }]);
  await sendMessageMarkup(chatId, "Pick a blocked user to restore access:", {
    inline_keyboard: kb,
  });
}

async function sendPendingPickList(chatId, mode) {
  const rows = authStore.listPendingUsers(25);
  if (rows.length === 0) {
    await sendMessage(chatId, "No Pending users.");
    await sendAdminHome(chatId);
    return;
  }
  const kb = [];
  for (const u of rows) {
    const label = `${(u.first_name || "User").slice(0, 18)} (${u.telegram_user_id})`.slice(0, 58);
    if (mode === "approve") {
      kb.push([{ text: `Approve: ${label}`, callback_data: `adm:ap:${u.telegram_user_id}` }]);
    } else {
      kb.push([{ text: `Reject: ${label}`, callback_data: `adm:rj:${u.telegram_user_id}` }]);
    }
  }
  kb.push([{ text: "<< Admin menu", callback_data: "adm:mn" }]);
  await sendMessageMarkup(
    chatId,
    mode === "approve" ? "Pick a Pending user to approve:" : "Pick a Pending user to reject:",
    { inline_keyboard: kb }
  );
}

async function sendAdminRemoveKeyboard(chatId) {
  const list = authStore.listAdminsDetailed();
  const kb = [];
  for (const a of list) {
    if (a.telegram_user_id === TELEGRAM_OWNER_ID || a.is_owner === 1) {
      kb.push([{ text: `Owner ${a.telegram_user_id} (cannot remove)`, callback_data: "adm:noop" }]);
    } else {
      kb.push([
        {
          text: `Remove admin ${a.telegram_user_id}`,
          callback_data: `adm:rm:${a.telegram_user_id}`,
        },
      ]);
    }
  }
  kb.push([{ text: "<< Admin menu", callback_data: "adm:mn" }]);
  await sendMessageMarkup(chatId, "Remove administrators (owner is locked):", {
    inline_keyboard: kb,
  });
}

async function handleCallbackQuery(query) {
  const fromId = Number(query.from?.id);
  const chatId = Number(query.message?.chat?.id);
  const qid = query.id;
  const data = String(query.data || "");

  if (!Number.isFinite(fromId) || !Number.isFinite(chatId)) {
    await answerCallback(qid);
    return;
  }

  if (userIsEffectivelyBlockedTelegramUid(fromId)) {
    await answerCallback(qid, "Access Denied — your account is blocked.", true);
    return;
  }

  if (!authStore.isAdmin(fromId)) {
    await answerCallback(qid, "Access Denied — not an administrator.", true);
    return;
  }

  await answerCallback(qid);

  if (!data.startsWith("adm:")) return;
  const body = data.slice(4);

  if (body === "noop") return;

  if (body === "mn") {
    await sendAdminHome(chatId);
    return;
  }
  if (body === "lua") {
    await sendPendingPickList(chatId, "approve");
    return;
  }
  if (body === "lur") {
    await sendPendingPickList(chatId, "reject");
    return;
  }
  if (body === "laa") {
    await sendApprovedUserList(chatId);
    return;
  }
  if (body === "lub") {
    await sendApprovedBlockPickList(chatId);
    return;
  }
  if (body === "luu") {
    await sendBlockedUnblockPickList(chatId);
    return;
  }
  if (body === "bui") {
    adminConversation.set(fromId, "BLOCK_BY_ID");
    await sendMessage(
      chatId,
      "Forward a message from that user OR send numeric Telegram user ID.\nCannot block bot owner.\n/cancel aborts."
    );
    return;
  }
  if (body === "aa") {
    adminConversation.set(fromId, "ADD_ADMIN");
    await sendMessage(
      chatId,
      "Forward a message from that user OR send numeric Telegram ID.\n/cancel aborts."
    );
    return;
  }
  if (body === "bc") {
    adminConversation.set(fromId, "BROADCAST");
    await sendMessage(chatId, "Send the broadcast text (goes to all Approved users).\n/cancel aborts.");
    return;
  }
  if (body === "la") {
    await sendAdminRemoveKeyboard(chatId);
    return;
  }
  if (body.startsWith("ap:")) {
    const tid = Number.parseInt(body.slice(3), 10);
    const r = authStore.setUserStatus(tid, "approved", fromId);
    if (!r.ok) await sendMessage(chatId, `Approve failed: ${r.error ?? "error"}`);
    else {
      await sendMessage(chatId, `User ${tid} → Approved`);
      try {
        await sendMessage(tid, "Your access request was Approved. You can use the bot now.");
      } catch {
        /* */
      }
    }
    await sendAdminHome(chatId);
    return;
  }
  if (body.startsWith("rj:")) {
    const tid = Number.parseInt(body.slice(3), 10);
    const r = authStore.setUserStatus(tid, "rejected", fromId);
    if (!r.ok) await sendMessage(chatId, `Reject failed: ${r.error ?? "error"}`);
    else {
      await sendMessage(chatId, `User ${tid} → Rejected`);
      try {
        await sendMessage(tid, "Access Denied.\nYour request was rejected.");
      } catch {
        /* */
      }
    }
    await sendAdminHome(chatId);
    return;
  }
  if (body.startsWith("bk:")) {
    const tid = Number.parseInt(body.slice(3), 10);
    const r = authStore.blockUser(tid, fromId, "");
    if (!r.ok) await sendMessage(chatId, `Block failed: ${r.error ?? "error"}`);
    else {
      await sendMessage(chatId, `User ${tid} is now blocked.`);
      try {
        await sendMessage(
          tid,
          "Access Denied.\nYour account has been blocked by an administrator."
        );
      } catch {
        /* */
      }
    }
    await sendAdminHome(chatId);
    return;
  }
  if (body.startsWith("ub:")) {
    const tid = Number.parseInt(body.slice(3), 10);
    const r = authStore.unblockUser(tid, fromId);
    if (!r.ok) await sendMessage(chatId, `Unblock failed: ${r.error ?? "error"}`);
    else {
      await sendMessage(chatId, `User ${tid} unblocked. They still need Approved status if not already.`);
      try {
        await sendMessage(tid, "Your block was removed.\nTry /start if you have approved access.");
      } catch {
        /* */
      }
    }
    await sendAdminHome(chatId);
    return;
  }
  if (body.startsWith("rm:")) {
    const tid = Number.parseInt(body.slice(3), 10);
    const r = authStore.removeAdministrator(tid, fromId, TELEGRAM_OWNER_ID);
    if (!r.ok) await sendMessage(chatId, r.error ?? "Cannot remove administrator.");
    else await sendMessage(chatId, `Removed administrator ${tid}.`);
    await sendAdminHome(chatId);
  }
}

function approvedHelpLines(isAdministrator) {
  const lines = [
    "✅ Bot Ready",
    "Welcome!",
    "",
    "🚀 400% Bonus",
    "* https://playkaro365.com",
    "* https://winclash.com",
    "* https://jeetexch99.com",
    "",
    "💡 Examples:",
    "/joinpromo jeetexch99.com Shitij12 Dada@123 1000",
    "",
    "/joinpromo playkaro365.com Shitij12 Dada@123 1000",
    "",
    "/joinpromo winclash.com Shitij12 Dada@123 1000",
    "",
    "ID PASSWORD DALNE KE BAAD 30 SECOND KE ANDER 4X HO JAEGA.",
    "",
    "BOT READY 🤝",
  ];
  if (isAdministrator) lines.push("", "/admin — administrator panel");
  return lines.join("\n");
}

async function dispatchAutomationFlow(chatId, parsed) {
  if (chatAutomationBusy.has(chatId)) {
    await sendMessage(chatId, "You already have a run in progress. Wait for it to finish.");
    return;
  }
  chatAutomationBusy.add(chatId);
  const waitHint =
    flowLimiter.getWaiting() > 0 || flowLimiter.getSlotsInUse() >= BOT_MAX_CONCURRENT_FLOWS;
  await sendMessage(
    chatId,
    waitHint
      ? "Queued — starting when a slot is free..."
      : "Processing login + promotion..."
  );
  try {
    await flowLimiter.run(async () => {
      console.log(
        `[flow slot ${flowLimiter.getSlotsInUse()}/${BOT_MAX_CONCURRENT_FLOWS}] chat ${chatId} id=${parsed.identifier}`
      );
      let result;
      try {
        result = await runPlaykaroFlow(parsed);
      } catch (err) {
        await sendMessage(chatId, `Error: ${String(err.message || err)}`);
        return;
      }
      const loginEffective = result.loginSuccess || result.joinHit;
      if (result.timedOut) {
        await sendMessage(chatId, "Timed out. Retry in ~1 minute.");
        return;
      }
      if (result.blockedBeforeLoginSeen || result.wafChallengeSeen) {
        await sendMessage(
          chatId,
          `WAF/403 blocked. Promotion status: ${result.joinStatus ?? "unknown"}.`
        );
        return;
      }
      if (loginEffective && result.joinHit && (result.join302 || result.locationOk)) {
        await sendMessage(
          chatId,
          [
            "✅ Success",
            "",
            "Your promotion request was submitted successfully.",
            "",
            `💰 Amount: ${parsed.amount}`,
          ].join("\n")
        );
        return;
      }
      if (loginEffective && result.joinHit) {
        await sendMessage(
          chatId,
          `Promotion uncertain. HTTP/status: ${result.joinStatus ?? "unknown"}`
        );
        return;
      }
      if (loginEffective) {
        await sendMessage(chatId, "Login processed; promotion did not finish.");
        return;
      }
      if (result.badCredentialSeen) {
        await sendMessage(chatId, "Incorrect username/mobile or password.");
        return;
      }
      await sendMessage(chatId, "Flow incomplete. Recheck credentials.");
    });
  } finally {
    chatAutomationBusy.delete(chatId);
  }
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const text = String(message.text || "").trim();
  const from = message.from;
  if (!chatId || !text || !from) return;

  const uid = from.id;
  if (BOT_VERBOSE_LOGS) {
    console.log(`[chat:${chatId}] ${text}`);
  }

  if (userIsEffectivelyBlockedTelegramUid(uid)) {
    if (/^\/(start|help)(@\w+)?(\s|$)/i.test(text)) {
      await sendMessage(
        chatId,
        "Access Denied.\nYour account has been blocked by an administrator."
      );
    } else {
      await sendMessage(chatId, "Access Denied.");
    }
    return;
  }

  const touch = authStore.touchUserFromTelegram(from);
  await notifyAdminsOfNewPending(from, touch);

  if (authStore.isAdmin(uid) && adminConversation.has(uid)) {
    if (isAdminCmd(text)) {
      adminConversation.delete(uid);
      await sendAdminHome(chatId);
      return;
    }
    const done = await handleAdminConversation(uid, chatId, text, message);
    if (done) return;
  }

  if (isAdminCmd(text)) {
    if (!authStore.isAdmin(uid)) {
      await sendMessage(chatId, "Access Denied.\nUnauthorized — administrator only.");
      return;
    }
    await sendAdminHome(chatId);
    return;
  }

  const dbStatus = authStore.getUserStatus(uid);
  const status = dbStatus ?? touch.status;

  if (!authStore.isAdmin(uid)) {
    if (status === "rejected") {
      if (/^\/(start|help)(@\w+)?(\s|$)/i.test(text)) {
        await sendMessage(
          chatId,
          "Access Denied.\nYour request was rejected by an administrator."
        );
      } else {
        await sendMessage(chatId, "Access Denied.");
      }
      return;
    }
    if (status === "pending") {
      if (/^\/(start)(@\w+)?(\s|$)/i.test(text)) {
        await sendMessage(
          chatId,
          "Status: Pending\nYour Telegram account needs administrator approval.\nAutomated login/promotions stay locked until then."
        );
      } else if (/^\/(help)(@\w+)?(\s|$)/i.test(text)) {
        await sendMessage(
          chatId,
          "Status: Pending.\nLimited access until approval. Only /start and /help are allowed."
        );
      } else {
        await sendMessage(chatId, "Access Denied. Your approval is Pending.");
      }
      return;
    }
  }

  if (/^\/(start|help)(@\w+)?(\s|$)/i.test(text)) {
    await sendMessage(chatId, approvedHelpLines(authStore.isAdmin(uid)));
    return;
  }

  const parsed = normalizeCmd(text.split(/\s+/)[0]) === "/joinpromo"
    ? parseJoinPromoCommand(text)
    : parseLoginCommand(text);
  if (!parsed) {
    await sendMessage(
      chatId,
      "Invalid format.\n/login <email_or_mobile> <password>\n/joinpromo <site> <email> <password> <amount> [proxy] [joinUrl]"
    );
    return;
  }

  await dispatchAutomationFlow(chatId, parsed);
}

async function pollUpdates() {
  while (true) {
    try {
      const updates = await telegramRequest("getUpdates", {
        timeout: POLL_TIMEOUT_SECONDS,
        offset: nextUpdateOffset,
        allowed_updates: ["message", "callback_query"],
      });
      if (BOT_VERBOSE_LOGS && updates.length > 0) {
        console.log(`Received ${updates.length} update(s).`);
      }

      for (const update of updates) {
        nextUpdateOffset = update.update_id + 1;
        if (BOT_VERBOSE_LOGS) {
          console.log(`Handling update_id=${update.update_id}`);
        }
        if (update.callback_query) {
          void handleCallbackQuery(update.callback_query).catch((err) =>
            console.error(`callback (update ${update.update_id}):`, err?.message || err)
          );
        }
        if (update.message?.text) {
          void handleMessage(update.message).catch((err) =>
            console.error(`handleMessage error (update ${update.update_id}):`, err?.message || err)
          );
        }
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

console.log(
  `Telegram bot started — approval gate enabled. Owner ${TELEGRAM_OWNER_ID}; BOT_MAX_CONCURRENT_FLOWS=${BOT_MAX_CONCURRENT_FLOWS}.`
);
await pollUpdates();
