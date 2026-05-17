import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadLocalEnv() {
  const envPath = join(__dirname, "..", ".env");
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

function decodeMaybe(value) {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isDestroyedContextErr(err) {
  const msg = String(err?.message || err);
  return /Execution context was destroyed|Target closed|frame was detached|Navigation|navigating/i.test(
    msg
  );
}

async function waitPageReady(page, timeoutMs = 25_000) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  } catch {
    /* SPA or already loaded */
  }
  await page.waitForTimeout(500);
}

/** Retries evaluate when login redirect invalidates the document mid-flight. */
async function evaluateStable(page, fn, arg, label = "page.evaluate") {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return arg !== undefined ? await page.evaluate(fn, arg) : await page.evaluate(fn);
    } catch (e) {
      lastErr = e;
      if (!isDestroyedContextErr(e)) throw e;
      console.log(`${label}: page navigated / context reset, waiting to retry (${attempt + 1})...`);
      await waitPageReady(page, 30_000);
    }
  }
  console.log(`${label}: skipped after repeated navigation (${String(lastErr?.message || lastErr)})`);
  return null;
}

/**
 * Some skins (e.g. jeetexch99.com) reply to POST `/api2/v2/login` with HTTP 200 and a large HTML/plan
 * document (games/wallet SPA) instead of JSON. Recognise that safely and avoid confusing it with JSON.
 */
function classifyLoginHtmlBodySuccess(rawText, hostname) {
  const raw = String(rawText || "");
  const lower = raw.toLowerCase();
  const head = raw.slice(0, 48_000);
  const len = raw.length;

  if (len < 4000 || !/<html[\s>]/i.test(raw)) return { ok: false, reason: "not-html-shell" };

  if (
    /awsWafCookieDomainList|attention required|\btoken\.js\b|challenge\.cloudflare|blocked by aws|human Verification|gokuProps/i.test(
      lower
    )
  ) {
    return { ok: false, reason: "waf-like" };
  }

  const authNegative =
    /username or password incorrect|invalid credential|incorrect password|log ?in failed|login failed|unauthorized|"success"\s*:\s*false|desk_log_(?:fail|error)/i.test(
      head
    );
  if (authNegative) return { ok: false, reason: "auth-error-in-body" };

  const hostLower = String(hostname || "").toLowerCase();
  const jeetSkin = /\bjeetexch\b/i.test(hostLower);

  const gamingShell =
    /play_BonusMoney|bonusBal\b|lowBalance_addMoney_popup|redirectLink|cashBack_before_deposit|casinoRedirect|sport(book|radar)|casino_redirect/i.test(
      lower
    );
  const sessionShell =
    /href\s*=\s*["'][^"']*logout|data-link='\s*\//i.test(lower) ||
    (/<meta\s+name=["']csrf-token["']/i.test(raw) &&
      /\b(wallet|deposit|balance|bonus|chips|gameBtn)\b/i.test(lower));

  if (gamingShell || sessionShell) return { ok: true, reason: "app-html-markers" };

  /** Last resort only for skins known to mirror this behaviour — large HTML minus explicit failure lines */
  if (jeetSkin && len >= 12_000 && /<meta\s+name=["']csrf-token["']/i.test(raw)) {
    return { ok: true, reason: "jeetexch-html-csrf-large" };
  }

  return { ok: false, reason: "html-no-confidence" };
}

function normalizeBaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "https://playkaro365.com";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function firstNonEmptyEnv(keys) {
  for (const key of keys) {
    const v = String(process.env[key] ?? "").trim();
    if (v) return v;
  }
  return "";
}

function proxyUsesCredentials(proxy) {
  if (!proxy) return false;
  return Boolean(String(proxy.username || "").trim() || String(proxy.password || "").trim());
}

function mergeProxyBypassLists(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    const items = String(list || "")
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (let item of items) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out.length ? out.join(",") : undefined;
}

/**
 * Chromium limitation: SOCKS4/5 + authentication → ERR_PROXY_AUTH_UNSUPPORTED (blocked by Playwright too).
 * HTTP CONNECT proxies with BASIC auth (`http://user:pass@host:port`) are supported.
 * Use PLAY_PROXY_USERNAME / PLAY_PROXY_PASSWORD if `@`/`:`/`#` in password breaks URLs.
 *
 * PLAY_PROXY_BYPASS — comma-separated host patterns routed direct (Chrome bypass list syntax).
 * PLAY_PROXY_BYPASS_SITE=1 — also bypasses PLAY_SITE_URL hostname only (GEO via proxy for proxy host, site direct).
 */
function parseProxyConfig(rawProxyUrl, bypassOptions = {}) {
  const value = String(rawProxyUrl || "").trim();
  if (!value) return null;
  try {
    let normalized = value;
    if (!/^[a-z0-9+.-]{2,}:/i.test(normalized)) {
      normalized = `http://${normalized}`;
    }

    const u = new URL(normalized);
    let protocol = u.protocol.toLowerCase();
    if (protocol === "socks5h:") protocol = "socks5:";
    if (protocol === "socks4a:") protocol = "socks4:";

    const host = u.hostname;
    const portNum = u.port;
    const portPart = portNum ? `:${portNum}` : "";
    if (!host) {
      console.log("[proxy] Invalid PLAY_PROXY_URL: missing host.");
      return null;
    }

    /** Chrome expects HTTP CONNECT — `https://proxy:8443` as server often yields auth quirks */
    let serverScheme = protocol;
    if (serverScheme === "https:") {
      serverScheme = "http:";
      console.log("[proxy] Normalized proxy URL scheme https: → http: (recommended for Chromium CONNECT tunnels).");
    }

    const server = `${serverScheme}//${host}${portPart}`;
    let username = decodeURIComponent(u.username || "");
    let password = decodeURIComponent(u.password || "");
    const envUser = firstNonEmptyEnv(["PLAY_PROXY_USERNAME", "PLAY_PROXY_USER"]);
    const envPass = firstNonEmptyEnv(["PLAY_PROXY_PASSWORD", "PLAY_PROXY_PASS"]);
    if (envUser) username = envUser;
    if (envPass) password = envPass;

    const hasAuth = Boolean(username || password);
    /** Credentials from URL segments or explicit env overrides (SOCKS rejects any of these). */
    const hasCred = Boolean(envUser || envPass || u.username || u.password);

    if (protocol === "socks5:" || protocol === "socks4:") {
      if ((protocol === "socks4:" && hasCred) || (protocol === "socks5:" && hasCred)) {
        console.error(
          "[proxy] Chromium cannot use SOCKS proxies that require authentication (ERR_PROXY_AUTH_UNSUPPORTED).\n" +
            "       Playwright rejects socks5+socks passwords as well.\n" +
            "       Fix: Use an HTTP/HTTPS CONNECT proxy URL such as:\n" +
            "             http://USER:PASS@exit.example.com:8080\n" +
            "       Or set PLAY_PROXY_BYPASS=.winclash.com,winclash.com only if browsing that host direct is OK,\n" +
            "       or PLAY_PROXY_URL= empty to disable the proxy."
        );
        throw new Error("SOCKS proxy auth unsupported — use HTTP CONNECT proxy or bypass/disable proxy.");
      }
      console.warn(
        "[proxy] Using SOCKS — if upstream requires SOCKS auth, Chrome shows ERR_PROXY_AUTH_UNSUPPORTED. Prefer HTTP CONNECT."
      );
    }

    const bypassManual = firstNonEmptyEnv(["PLAY_PROXY_BYPASS"]);
    const bypassSiteToggle = /^(1|true|yes)$/i.test(
      String(bypassOptions.bypassSite || process.env.PLAY_PROXY_BYPASS_SITE || "").trim()
    );
    const siteHost = String(bypassOptions.siteHostname || "").trim();
    const bypassList = mergeProxyBypassLists(
      bypassManual,
      bypassSiteToggle && siteHost ? siteHost : ""
    );

    console.log(
      `[proxy] active server=${server} scheme=${protocol} bypass=${bypassList || "(none)"} auth=${hasAuth ? "credentials-set" : "none"}`
    );

    const proxy = {
      server,
      ...(bypassList ? { bypass: bypassList } : {}),
      ...(username ? { username } : {}),
      ...(password !== "" ? { password } : {}),
    };
    if (proxy.username !== undefined && !proxy.password && envPass === "") {
      console.warn("[proxy] Username set without password — 407 BASIC auth failures may produce ERR_PROXY_AUTH_UNSUPPORTED.");
    }
    return proxy;
  } catch (e) {
    if (/SOCKS proxy auth unsupported/i.test(String(e.message || ""))) throw e;
    console.log("[proxy] Invalid PLAY_PROXY_URL, ignoring proxy:", String(e.message || e));
    return null;
  }
}

function findAwsWafCookie(cookies) {
  return (
    cookies.find((c) => String(c?.name || "").toLowerCase() === "aws-waf-token") || null
  );
}

async function logAwsWafDiagnostics(context, page, phase, cookiesForUrl) {
  const cookies = cookiesForUrl
    ? await context.cookies(cookiesForUrl)
    : await context.cookies();
  const wafCookie = findAwsWafCookie(cookies);
  const logFull =
    /^(1|true|yes)$/i.test(String(process.env.PLAY_WAF_LOG_FULL || "").trim());

  console.log(`\n--- AWS WAF token (${phase}) ---`);
  if (!wafCookie?.value) {
    console.log("aws-waf-token cookie: absent (challenge may still be pending or cookie not issued yet)");
  } else {
    const v = wafCookie.value;
    console.log(`aws-waf-token cookie: present, length=${v.length}`);
    if (logFull) {
      console.log(`aws-waf-token (full): ${v}`);
    } else {
      const head = v.slice(0, 72);
      const tail = v.length > 96 ? `...${v.slice(-40)}` : "";
      console.log(`aws-waf-token (preview): ${head}${tail}`);
    }
    console.log(
      `cookie domain/path: ${wafCookie.domain ?? "?"} ${wafCookie.path ?? "?"} secure=${Boolean(wafCookie.secure)}`
    );
  }

  try {
    const storageProbe = await page.evaluate(() => {
      const ls = { ...localStorage };
      const keys = Object.keys(ls).filter((k) => /waf|aws/i.test(k));
      const pick = {};
      for (const k of keys) {
        const val = ls[k];
        pick[k] =
          typeof val === "string" && val.length > 120
            ? `${val.slice(0, 80)}… (len ${val.length})`
            : val;
      }
      return { awswafKeys: keys, awswafPreview: pick };
    });
    if (storageProbe.awswafKeys.length) {
      console.log("localStorage (WAF-related keys):", JSON.stringify(storageProbe.awswafPreview, null, 2));
    } else {
      console.log("localStorage: no awswaf* keys yet");
    }
  } catch {
    console.log("localStorage WAF probe skipped (page not ready)");
  }
}

/** Poll until aws-waf-token appears or timeout (use headed browser + complete check manually). */
async function waitForAwsWafCookieIfConfigured(context, page, cookiesForUrl) {
  const maxMs = Number(process.env.PLAYKARO_WAIT_WAF_MS || 0) || 0;
  if (maxMs <= 0) return;

  console.log(
    `\nPLAYKARO_WAIT_WAF_MS=${maxMs}: waiting up to ${maxMs}ms for aws-waf-token (complete verification in browser if shown)...`
  );
  const deadline = Date.now() + maxMs;
  const started = Date.now();
  while (Date.now() < deadline) {
    const cookies = cookiesForUrl ? await context.cookies(cookiesForUrl) : await context.cookies();
    const waf = findAwsWafCookie(cookies);
    if (waf?.value?.trim()) {
      console.log(`aws-waf-token detected after ~${Date.now() - started}ms wait.`);
      return;
    }
    await page.waitForTimeout(1500);
  }
  console.log("Wait finished: aws-waf-token still missing; continuing anyway.");
}

async function readStorage(page, storageName) {
  try {
    return await page.evaluate((name) => {
      const out = {};
      const s = window[name];
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i);
        out[k] = s.getItem(k);
      }
      return out;
    }, storageName);
  } catch {
    return {};
  }
}

async function printBrowserState(label, page, context) {
  console.log(`\n=== ${label} ===`);
  const cookies = await context.cookies();
  console.log(`Total cookies: ${cookies.length}`);
  console.log(JSON.stringify(cookies, null, 2));

  const localStorage = await readStorage(page, "localStorage");
  console.log(`Total localStorage keys: ${Object.keys(localStorage).length}`);
  console.log(JSON.stringify(localStorage, null, 2));

  const sessionStorage = await readStorage(page, "sessionStorage");
  console.log(`Total sessionStorage keys: ${Object.keys(sessionStorage).length}`);
  console.log(JSON.stringify(sessionStorage, null, 2));
}

async function closeAfterDepositPopup(page, timeoutMs = 5000) {
  const popupSelector = "div.dialog.after-deposit-wrapper.dialog--active";
  /** Close icons for deposit promo, IPL popup, or any md close in this dialog */
  const closeSelectors = [
    "i.icon.mdi.mdi-close[onclick*='cashBack_before_deposit_popup_reset']",
    "i.icon.mdi.mdi-close[onclick*='ipl_popup_reset']",
    ".modalClose i.icon.mdi.mdi-close",
    "i.icon.mdi.mdi-close",
  ];

  const tryClickClose = async (popup, selector) => {
    const closeIcon = popup.locator(selector).first();
    if ((await closeIcon.count()) === 0) return false;
    try {
      await closeIcon.click({ timeout: 2000 });
    } catch {
      await closeIcon.click({ force: true, timeout: 2000 }).catch(() => {});
      await page.evaluate((sel) => {
        const popupEl = document.querySelector(
          "div.dialog.after-deposit-wrapper.dialog--active"
        );
        if (!popupEl) return;
        const icon = popupEl.querySelector(sel);
        if (icon) icon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }, selector);
    }
    return true;
  };

  try {
    const popup = page.locator(popupSelector).first();
    await popup.waitFor({ state: "visible", timeout: timeoutMs });

    let clicked = false;
    for (const sel of closeSelectors) {
      if (await tryClickClose(popup, sel)) {
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      await page.evaluate(() => {
        if (typeof window.ipl_popup_reset === "function") {
          try {
            window.ipl_popup_reset();
          } catch {
            /* ignore */
          }
        }
        if (typeof window.cashBack_before_deposit_popup_reset === "function") {
          try {
            window.cashBack_before_deposit_popup_reset();
          } catch {
            /* ignore */
          }
        }
      });
    }

    await popup.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    const stillVisible = await popup.isVisible().catch(() => false);
    if (!stillVisible) {
      console.log("Closed after-deposit / promo popup.");
    }
  } catch {
    /* no popup or already gone */
  }

  try {
    const skipBtn = page.locator(".skip_right_img, .skip-button").first();
    if ((await skipBtn.count()) > 0 && (await skipBtn.isVisible())) {
      await skipBtn.click({ timeout: 2000 });
      console.log("Clicked aviator skip button.");
      await page.waitForTimeout(1000);
    }
  } catch {
    /* ignore */
  }
  
  return false;
}

/**
 * Deposit / IPL / low-balance modals sometimes sit above the SPA and interfere with routing.
 * Call before navigating to `/promotions/...`, then once more after arrival.
 */
async function dismissSiteOverlays(page, closeTimeoutMs = 6000) {
  await closeAfterDepositPopup(page, closeTimeoutMs);
  await evaluateStable(
    page,
    () => {
      const names = [
        "lowBalance_addMoney_popup_reset",
        "ipl_popup_reset",
        "cashBack_before_deposit_popup_reset",
      ];
      for (const name of names) {
        const fn = window[name];
        if (typeof fn !== "function") continue;
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    },
    undefined,
    "overlay-reset-fns"
  );

  for (let round = 0; round < 5; round++) {
    await closeAfterDepositPopup(page, 1200).catch(() => false);
    const genericClose = page
      .locator(
        ".dialog--active .modalClose i.icon.mdi.mdi-close, .dialog.dialog--active i.icon.mdi.mdi-close, #lowBalance_addMoney_popup_id i.icon.mdi.mdi-close, #play_BonusMoney_id i.icon.mdi.mdi-close"
      )
      .first();
    if ((await genericClose.count()) === 0) break;
    await genericClose.click({ timeout: 800 }).catch(() => {});
    await page.waitForTimeout(350);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

function promotionPathMatchesUrl(pageUrl, promotionIdValue) {
  const needle = `/promotions/${String(promotionIdValue || "").trim()}`;
  try {
    const p = new URL(pageUrl).pathname.replace(/\/$/, "") || "";
    return p.endsWith(needle) || p.includes(`${needle}/`);
  } catch {
    return String(pageUrl).includes(needle);
  }
}

async function ensurePromotionPageLoaded(page, promotionPageUrl, promotionIdValue, label) {
  const settlePause = Number(process.env.PLAYKARO_SETTLE_MS || 3000) || 3000;
  console.log(`${label}: navigating to promotions → ${promotionPageUrl}`);
  let lastNavErr = "";
  for (const waitUntil of ["domcontentloaded", "load"]) {
    try {
      await page.goto(promotionPageUrl, { waitUntil, timeout: 90_000 });
      lastNavErr = "";
      break;
    } catch (e) {
      lastNavErr = String(e?.message || e);
      console.log(`Promotion page.goto (${waitUntil}): ${lastNavErr}`);
    }
  }

  await waitPageReady(page, 35_000);
  await page.waitForTimeout(Math.min(settlePause, 4000));

  let urlAfter = "";
  try {
    urlAfter = page.url();
  } catch {
    urlAfter = "";
  }
  console.log(`${label}: URL after navigation: ${urlAfter}`);

  if (!promotionPathMatchesUrl(urlAfter, promotionIdValue)) {
    console.log(`${label}: path mismatch; forcing window.location.assign(...)`);
    await evaluateStable(
      page,
      (href) => {
        window.location.assign(href);
      },
      promotionPageUrl,
      "promotion location.assign"
    );
    await page.waitForLoadState("domcontentloaded", { timeout: 75_000 }).catch(() => {});
    await waitPageReady(page, 35_000);
    await page.waitForTimeout(Math.min(settlePause, 4000));
    try {
      urlAfter = page.url();
    } catch {
      urlAfter = "";
    }
    console.log(`${label}: URL after assign: ${urlAfter}`);
    if (!promotionPathMatchesUrl(urlAfter, promotionIdValue)) {
      console.log(
        `${label}: still not on promotions page (may be intercepted by modal or upstream redirect).`
      );
    }
  }
}

async function getFormCsrfToken(page) {
  try {
    const token = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta?.content) return meta.content;
      const input = document.querySelector('input[name="_token"]');
      if (input?.value) return input.value;
      if (window.Laravel?.csrfToken) return window.Laravel.csrfToken;
      if (window.csrfToken) return window.csrfToken;
      return null;
    });
    return decodeMaybe(token);
  } catch {
    // Page may be mid-navigation; caller can fallback to cookie/header CSRF.
    return null;
  }
}

async function discoverCsrfToken(page, context) {
  const tokenKeys = ["x-csrf-token", "xsrf-token", "csrf-token", "csrf", "_csrf"];
  const cookies = await context.cookies();
  const hasWafToken = cookies.some((c) => String(c.name || "").toLowerCase() === "aws-waf-token");
  const xsrfCookie = cookies.find((c) => String(c.name || "").toLowerCase() === "xsrf-token");
  if (xsrfCookie?.value) {
    return {
      token: decodeMaybe(xsrfCookie.value),
      source: `cookie:${xsrfCookie.name}`,
      hasWafToken,
    };
  }

  for (const cookie of cookies) {
    const name = String(cookie.name || "").toLowerCase();
    if (tokenKeys.some((k) => name.includes(k))) {
      return { token: decodeMaybe(cookie.value), source: `cookie:${cookie.name}`, hasWafToken };
    }
  }

  for (const storageName of ["localStorage", "sessionStorage"]) {
    const items = await readStorage(page, storageName);
    for (const [key, value] of Object.entries(items)) {
      if (tokenKeys.some((tokenKey) => key.toLowerCase().includes(tokenKey))) {
        return { token: value, source: `${storageName}:${key}`, hasWafToken };
      }
    }
  }

  const formToken = await getFormCsrfToken(page);
  if (formToken) return { token: formToken, source: "dom:meta-or-_token", hasWafToken };

  return { token: null, source: null, hasWafToken };
}

loadLocalEnv();

/**
 * Default is headed — AWS WAF / Human Verification usually fails in headless.
 * - PLAYKARO_HEADLESS=1|true|yes → headless (only if you accept WAF risk / testing)
 * - PLAYKARO_HEADLESS=0|false|no → headed
 * - PLAYKARO_HEADED=1 → headed (explicit)
 * - Linux + no DISPLAY: this script re-execs once under `xvfb-run -a` if installed (headed + WAF).
 * - PLAYKARO_SKIP_AUTO_XVFB=1 → skip that re-exec (you manage DISPLAY yourself).
 * - PLAYKARO_AUTO_HEADLESS_LINUX=1 → on Linux with no DISPLAY only, use headless (WAF may block).
 */
function resolvePlaywrightHeadless() {
  const h = String(process.env.PLAYKARO_HEADLESS || "").trim();
  if (/^(1|true|yes)$/i.test(h)) return { headless: true, via: "PLAYKARO_HEADLESS" };
  if (/^(0|false|no)$/i.test(h)) return { headless: false, via: "PLAYKARO_HEADLESS" };
  if (/^(1|true|yes)$/i.test(String(process.env.PLAYKARO_HEADED || "").trim())) {
    return { headless: false, via: "PLAYKARO_HEADED" };
  }
  if (
    /^(1|true|yes)$/i.test(String(process.env.PLAYKARO_AUTO_HEADLESS_LINUX || "").trim()) &&
    process.platform === "linux" &&
    !String(process.env.DISPLAY || "").trim()
  ) {
    return { headless: true, via: "PLAYKARO_AUTO_HEADLESS_LINUX (linux, no DISPLAY)" };
  }
  return { headless: false, via: "default headed (WAF)" };
}

/**
 * Headed Playwright on Linux needs a framebuffer. If DISPLAY is unset and `xvfb-run` exists,
 * re-run this process under `xvfb-run -a` once (child gets DISPLAY; avoids manual wrapping).
 */
function maybeReexecUnderXvfbRun(headless) {
  if (headless) return;
  if (process.platform !== "linux") return;
  if (String(process.env.DISPLAY || "").trim()) return;
  if (/^(1|true|yes)$/i.test(String(process.env.PLAYKARO_SKIP_AUTO_XVFB || "").trim())) return;

  if (process.env.PLAYKARO_XVFB_REEXEC === "1") {
    console.error(
      "[browser] Headed on Linux but DISPLAY is still unset. Install xvfb: sudo apt install -y xvfb"
    );
    return;
  }

  const which = spawnSync("which", ["xvfb-run"], { encoding: "utf8" });
  const xvfbRun = which.status === 0 ? String(which.stdout || "").trim().split(/\n/)[0]?.trim() : "";
  if (!xvfbRun) return;

  process.env.PLAYKARO_XVFB_REEXEC = "1";
  console.log("[browser] No DISPLAY — re-running under xvfb-run -a (virtual screen for headed Chromium).");
  const r = spawnSync(xvfbRun, ["-a", process.execPath, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
  process.exit(r.status === null ? 1 : r.status);
}

const loginEmail = (process.env.PLAYKARO_EMAIL || "").trim();
const loginPassword = (process.env.PLAYKARO_PASSWORD || "").trim();
const { headless, via: headlessVia } = resolvePlaywrightHeadless();
maybeReexecUnderXvfbRun(headless);
const settleMs = Number(process.env.PLAYKARO_SETTLE_MS || 3000) || 3000;
const verbose = /^(1|true|yes)$/i.test(String(process.env.PLAYKARO_VERBOSE || "").trim());
const promotionId = (process.env.PLAYKARO_PROMOTION_ID || "22").trim() || "22";
const promotionAmount = (process.env.PLAYKARO_PROMO_AMOUNT || "1000").trim() || "1000";
// PLAY_SITE_URL sets the host; same flow for playkaro365.com, winclash.com, jeetexch99.com, etc.
const siteBaseUrl = normalizeBaseUrl(process.env.PLAY_SITE_URL || "https://playkaro365.com");
const siteOrigin = new URL(siteBaseUrl).origin;
const homeUrl = `${siteOrigin}/`;
const loginApiUrl = `${siteOrigin}/api2/v2/login`;
const promotionPageUrl = `${siteOrigin}/promotions/${promotionId}`;
const joinUrlFromEnv = String(process.env.PLAY_JOIN_URL || "").trim();
const joinPromotionUrl = joinUrlFromEnv || `${siteOrigin}/joinPromotion/${promotionId}`;
let proxySiteBypassHost = "";
try {
  proxySiteBypassHost = new URL(siteBaseUrl).hostname;
} catch {
  proxySiteBypassHost = "";
}
const proxyConfig = parseProxyConfig(process.env.PLAY_PROXY_URL || "", {
  siteHostname: proxySiteBypassHost,
  bypassSite: process.env.PLAY_PROXY_BYPASS_SITE,
});

/** Telegram bot passes PLAY_BROWSER_PROFILE_SUFFIX so parallel flows never share one persistent profile lock. */
const profileSuffixSafe = String(process.env.PLAY_BROWSER_PROFILE_SUFFIX || "")
  .trim()
  .replace(/[^a-zA-Z0-9_-]/g, "")
  .slice(0, 80);
const profileBase = join(__dirname, "..", "browser_profiles");
const chromiumProfileDir = profileSuffixSafe
  ? join(profileBase, `chromium_${profileSuffixSafe}`)
  : join(__dirname, "..", "selenium_chrome_profile");
const firefoxProfileDir = profileSuffixSafe
  ? join(profileBase, `firefox_${profileSuffixSafe}`)
  : join(__dirname, "..", "selenium_firefox_profile");
mkdirSync(chromiumProfileDir, { recursive: true });
mkdirSync(firefoxProfileDir, { recursive: true });
if (profileSuffixSafe) {
  console.log(`[browser] Persistent profile dir (isolated): ${profileSuffixSafe.slice(0, 16)}…`);
}

const rawBrowserChoice = String(process.env.PLAY_BROWSER || process.env.PLAYKARO_BROWSER || "")
  .trim()
  .toLowerCase();
const firefoxFromEnvName = rawBrowserChoice === "firefox" || rawBrowserChoice === "ff";
const userChoseChromiumName =
  /^(chromium|chrome|chrome-beta|msedge|edge)$/i.test(rawBrowserChoice || "");
const firefoxForProxyFlag = /^(1|true|yes)$/i.test(
  String(process.env.PLAY_PROXY_USE_FIREFOX || "").trim()
);
const forceChromium = /^(1|true|yes)$/i.test(
  String(process.env.PLAY_PROXY_FORCE_CHROMIUM || "").trim()
);
/** Chromium often raises ERR_PROXY_AUTH_UNSUPPORTED for BASIC auth gateways (e.g. IPRoyal). Firefox handles them reliably. */
const firefoxAutoWindows =
  process.platform === "win32" &&
  proxyUsesCredentials(proxyConfig) &&
  !forceChromium &&
  !userChoseChromiumName;
const useFirefoxPersistent =
  firefoxFromEnvName ||
  (proxyUsesCredentials(proxyConfig) && (firefoxForProxyFlag || firefoxAutoWindows));

if (firefoxForProxyFlag && !firefoxFromEnvName) {
  console.log("[browser] PLAY_PROXY_USE_FIREFOX=1 — launching Firefox for authenticated HTTP proxy.");
}
if (firefoxAutoWindows && !firefoxFromEnvName && !firefoxForProxyFlag) {
  console.log(
    "[browser] Windows + authenticated proxy → Firefox (avoids Chromium ERR_PROXY_AUTH_UNSUPPORTED). Set PLAY_PROXY_FORCE_CHROMIUM=1 to keep Chromium, or PLAY_BROWSER=firefox explicitly."
  );
}
if (useFirefoxPersistent) {
  console.log(
    "[browser] Tip: Ensure Firefox is installed for Playwright:  npx playwright install firefox"
  );
}

console.log(`[browser] headless=${headless} (${headlessVia})`);
if (
  !headless &&
  process.platform === "linux" &&
  !String(process.env.DISPLAY || "").trim()
) {
  console.log(
    "[browser] No DISPLAY and xvfb-run not on PATH — headed Chrome cannot start. Fix:\n" +
      "  sudo apt install -y xvfb\n" +
      "Or wrap the bot: xvfb-run -a npm run bot:telegram\n" +
      "Headless (WAF may block): PLAYKARO_HEADLESS=1 or PLAYKARO_AUTO_HEADLESS_LINUX=1."
  );
}

const browser = useFirefoxPersistent
  ? await firefox.launchPersistentContext(firefoxProfileDir, {
      headless,
      viewport: { width: 1366, height: 900 },
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
      ignoreHTTPSErrors: true,
    })
  : await chromium.launchPersistentContext(chromiumProfileDir, {
      headless,
      executablePath: process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
      viewport: { width: 1366, height: 900 },
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
      args: [
        "--disable-blink-features=AutomationControlled",
        /* Incognito breaks or weakens HTTP CONNECT + proxy BASIC auth with some Chromium builds */
        ...(proxyUsesCredentials(proxyConfig) ? [] : ["--incognito"]),
        "--disable-web-security",
        "--disable-site-isolation-trials",
        "--allow-running-insecure-content",
      ],
    });

if (!useFirefoxPersistent && proxyUsesCredentials(proxyConfig)) {
  console.log(
    "[proxy] Chromium: omitted --incognito so proxy BASIC auth can succeed. Still see ERR_PROXY_AUTH_UNSUPPORTED? Set PLAY_PROXY_USE_FIREFOX=1 or PLAY_BROWSER=firefox."
  );
}

const page = browser.pages()[0] || (await browser.newPage());

try {
  try {
    await page.goto(homeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
  } catch {
    console.log("Navigation timeout, continuing after stop.");
  }

  await page.waitForTimeout(settleMs);
  await closeAfterDepositPopup(page, 6000);

  await waitForAwsWafCookieIfConfigured(browser, page, homeUrl);
  await logAwsWafDiagnostics(browser, page, "after home load", homeUrl);

  const pageTitle = await page.title();
  console.log(pageTitle);
  console.log(page.url());
  if (/403/i.test(pageTitle)) {
    console.log("Flow blocked: received 403 page before login form could load.");
  }

  if (verbose) {
    await printBrowserState("Initial browser state", page, browser);
  }

  const csrfDiscovery = await discoverCsrfToken(page, browser);
  let xCsrfToken = csrfDiscovery.token;

  if (xCsrfToken) {
    const decodedToken = decodeMaybe(xCsrfToken);
    console.log(`x-csrf-token source: ${csrfDiscovery.source}`);
    console.log(`x-csrf-token (raw): ${xCsrfToken}`);
    console.log(`x-csrf-token (decoded): ${decodedToken}`);
  } else {
    console.log("x-csrf-token not found in cookies/localStorage/sessionStorage/DOM.");
    if (csrfDiscovery.hasWafToken) {
      console.log(
        "Detected aws-waf-token cookie. Complete human verification in headed mode, then retry."
      );
    }
  }

  if (!loginEmail || !loginPassword) {
    console.log("Login skipped: set PLAYKARO_EMAIL and PLAYKARO_PASSWORD env vars.");
  } else {
    console.log("\n--- UI login attempt ---");
    await closeAfterDepositPopup(page, 3000);
    loginFlow: {

  const usernameInput = page.locator("#user_login").first();
  const passwordInput = page.locator("#pass_eye_user").first();
  const loginButton = page.locator("button.btnLogin").first();

  try {
    await usernameInput.waitFor({ state: "visible", timeout: 20_000 });
    await passwordInput.waitFor({ state: "visible", timeout: 20_000 });
    await loginButton.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    console.log("Flow blocked: login fields not available (likely WAF/challenge page).");
    break loginFlow;
  }

  const setInputValue = async (selector, value) => {
    await page.evaluate(
      ({ sel, val }) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        ).set;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      },
      { sel: selector, val: value }
    );
  };

  await setInputValue("#user_login", loginEmail);
  await setInputValue("#pass_eye_user", loginPassword);

  const readUser = () => usernameInput.inputValue({ timeout: 2000 }).catch(() => "");
  const readPass = () => passwordInput.inputValue({ timeout: 2000 }).catch(() => "");
  if ((await readUser()) !== loginEmail) await usernameInput.fill(loginEmail);
  if ((await readPass()) !== loginPassword) await passwordInput.fill(loginPassword);

  await page.waitForTimeout(3000);
  const remember = page.locator("#rememberMe").first();
  if ((await remember.count()) > 0 && (await remember.isChecked())) await remember.click();

  await loginButton.scrollIntoViewIfNeeded();
  await closeAfterDepositPopup(page, 2000);

  /* Race click vs navigation: hard redirect invalidates evaluate; SPA may navigate in-app only */
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null),
    loginButton.click({ force: true }),
  ]).catch(() => null);

  await page.waitForTimeout(3500);
  await waitPageReady(page, 20_000);
  await closeAfterDepositPopup(page, 3000);

  // After submit the SPA may navigate and remove #user_login — do not wait on that locator.
  const userLogged = await readUser();
  const passLogged = await readPass();
  console.log(`Filled username: ${userLogged || loginEmail}`);
  console.log(`Filled password length: ${(passLogged || loginPassword).length}`);
  console.log("UI login submitted.");

  const errorText = await page
    .locator(".desk_log_error")
    .first()
    .textContent({ timeout: 5000 })
    .catch(() => null);
  if (errorText?.trim()) console.log(`UI login error: ${errorText.trim()}`);
  else console.log("UI login error box not visible (may be success or delayed response).");
  await closeAfterDepositPopup(page, 3000);
  await waitPageReady(page, 30_000);

  const socketId = await evaluateStable(
    page,
    () => {
      try {
        if (window.Echo && typeof window.Echo.socketId === "function") return window.Echo.socketId();
        if (window.Pusher?.instances) {
          const keys = Object.keys(window.Pusher.instances);
          if (keys.length > 0) {
            const p = window.Pusher.instances[keys[0]];
            if (p?.connection?.socket_id) return p.connection.socket_id;
          }
        }
      } catch {
        /* ignore */
      }
      return null;
    },
    undefined,
    "socketId"
  );
  const userAgent =
    (await evaluateStable(page, () => navigator.userAgent, undefined, "userAgent")) ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  let refreshedCsrf = await discoverCsrfToken(page, browser);
  if (!refreshedCsrf.token) {
    await waitPageReady(page, 15_000);
    refreshedCsrf = await discoverCsrfToken(page, browser);
  }
  xCsrfToken = xCsrfToken || refreshedCsrf.token;
  const csrfHeaderValue = decodeMaybe(xCsrfToken);

  let loginResult = null;
  let loginSucceeded = false;
  if (!csrfHeaderValue) {
    console.log("Login API skipped: x-csrf-token is required.");
  } else {
    console.log("\n--- Login request details ---");
    console.log(`POST ${loginApiUrl}`);
    console.log(
      JSON.stringify(
        {
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Origin: siteOrigin,
          Referer: homeUrl,
          "User-Agent": userAgent,
          "X-CSRF-Token": csrfHeaderValue,
          "X-XSRF-TOKEN": csrfHeaderValue,
          "X-Requested-With": "XMLHttpRequest",
          ...(socketId ? { "X-Socket-Id": String(socketId) } : {}),
        },
        null,
        2
      )
    );
    console.log("Body: email=<redacted>&password=<redacted>&remember_me=false");

    loginResult = await evaluateStable(
      page,
      async ({ email, password, csrf, socketId, loginApiUrl }) => {
        const body = new URLSearchParams({
          email,
          password,
          remember_me: "false",
        }).toString();
        const headers = {
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-CSRF-Token": csrf,
          "X-XSRF-TOKEN": csrf,
          "X-Requested-With": "XMLHttpRequest",
        };
        if (socketId) headers["X-Socket-Id"] = String(socketId);

        try {
          const res = await fetch(loginApiUrl, {
            method: "POST",
            headers,
            body,
            credentials: "include",
          });
          return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            text: await res.text(),
          };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
      { email: loginEmail, password: loginPassword, csrf: csrfHeaderValue, socketId, loginApiUrl },
      "login API fetch"
    );

    loginSucceeded = (() => {
      if (!loginResult || loginResult.error) return false;
      const httpStatus = Number(loginResult.status);
      if (!(loginResult.ok && httpStatus === 200)) return false;

      const raw = String(loginResult.text || "").trim();
      const lower = raw.toLowerCase();
      if (lower.includes("login success")) {
        console.log("LOGIN_FLOW_MARK: json_plain_success");
        return true;
      }

      try {
        const j = JSON.parse(raw);
        if (typeof j.success === "boolean" && j.success) {
          console.log("LOGIN_FLOW_MARK: json_success_flag");
          return true;
        }
        const apiSt = Number(j.status);
        const msg = String(j.message ?? "").toLowerCase();
        if (apiSt === 200 && (msg.includes("success") || msg.includes("authenticated"))) {
          console.log("LOGIN_FLOW_MARK: json_status_msg");
          return true;
        }
        if (apiSt === 200 && j.id != null && !/\bfail(?:ed)?\b/.test(msg)) {
          console.log("LOGIN_FLOW_MARK: json_status_id");
          return true;
        }
        if (
          apiSt === 200 &&
          (j.redirect != null ||
            /\b(profile|deposit|dashboard|wallet|games)\b/i.test(String(j.url || "")))
        ) {
          console.log("LOGIN_FLOW_MARK: json_redirect");
          return true;
        }
      } catch {
        /* Not JSON — several hosts return HTML for the login XHR */
        try {
          const host = new URL(siteBaseUrl).hostname;
          const htmlClass = classifyLoginHtmlBodySuccess(raw, host);
          if (htmlClass.ok) {
            console.log(`Login classified from HTML (${htmlClass.reason}).`);
            console.log("LOGIN_FLOW_MARK: html_shell_ok");
            return true;
          }
        } catch {
          /* ignore */
        }
      }

      return false;
    })();

    console.log("\n--- Login API response ---");
    if (loginResult && String(loginResult.text || "").length > 22_000) {
      const t = String(loginResult.text || "");
      console.log(
        JSON.stringify(
          {
            ok: loginResult.ok,
            status: loginResult.status,
            statusText: loginResult.statusText,
            textChars: t.length,
            summary: `[HTML/non-JSON login body truncated in logs — loginSucceeded=${loginSucceeded}]`,
            textHead: `${t.slice(0, 500)} …`,
          },
          null,
          2
        )
      );
    } else if (loginResult) {
      console.log(JSON.stringify(loginResult, null, 2));
    }
    if (loginSucceeded) {
      console.log("LOGIN_CONFIRM_TAIL: yes");
    }
  }

    if (loginSucceeded) {
      await logAwsWafDiagnostics(browser, page, "after login API success", homeUrl);
      await dismissSiteOverlays(page, 8000);
      await waitPageReady(page, 25_000);
      await ensurePromotionPageLoaded(page, promotionPageUrl, promotionId, "post-login");
      await dismissSiteOverlays(page, 8000);

      const runJoinPromotionRequest = async (promotionToken, attemptLabel) => {
        const joinUrl = joinPromotionUrl;
        const joinBody = new URLSearchParams({
          _token: promotionToken,
          amount: promotionAmount,
        }).toString();

        console.log(`\n--- Join promotion request details (${attemptLabel}) ---`);
        console.log(`POST ${joinUrl}`);
        console.log(
          JSON.stringify(
            {
              mode: "browser-native-form-submit",
              Referer: promotionPageUrl,
              Cookie: "<auto from browser session>",
            },
            null,
            2
          )
        );
        console.log(`Body: ${joinBody}`);
        console.log(
          "Form data:",
          JSON.stringify(
            {
              _token: promotionToken,
              amount: promotionAmount,
            },
            null,
            2
          )
        );

        const responsePromise = page
          .waitForResponse(
            (resp) =>
              resp.url().includes(`/joinPromotion/${promotionId}`) &&
              resp.request().method() === "POST",
            { timeout: 45_000 }
          )
          .catch(() => null);

        const navPromise = page
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 })
          .catch(() => null);

        await page.evaluate(
          ({ promotionIdValue, tokenValue, amountValue }) => {
            const form = document.createElement("form");
            form.method = "POST";
            form.action = `/joinPromotion/${promotionIdValue}`;

            const tokenInput = document.createElement("input");
            tokenInput.type = "hidden";
            tokenInput.name = "_token";
            tokenInput.value = tokenValue;
            form.appendChild(tokenInput);

            const amountInput = document.createElement("input");
            amountInput.type = "hidden";
            amountInput.name = "amount";
            amountInput.value = String(amountValue);
            form.appendChild(amountInput);

            document.body.appendChild(form);
            form.submit();
          },
          { promotionIdValue: promotionId, tokenValue: promotionToken, amountValue: promotionAmount }
        );

        const joinResponse = await responsePromise;
        await navPromise;

        if (!joinResponse) {
          console.log(`\n--- Join promotion API response (${attemptLabel}) ---`);
          console.log(
            JSON.stringify(
              {
                ok: false,
                status: 0,
                statusText: "NO_RESPONSE_CAPTURED",
                location: "",
                setCookieCount: 0,
                challengeDetected: false,
                textPreview: "",
              },
              null,
              2
            )
          );
          return { status: 0, location: "", challengeDetected: false };
        }

        const headers = joinResponse.headers();
        const location = headers.location || "";
        const responseText = await joinResponse.text().catch(() => "");
        const challengeDetected =
          joinResponse.status() === 202 ||
          /awsWafCookieDomainList|aws-waf|Human Verification|challenge\.js/i.test(responseText);

        console.log(`\n--- Join promotion API response (${attemptLabel}) ---`);
        console.log(
          JSON.stringify(
            {
              ok: joinResponse.ok(),
              status: joinResponse.status(),
              statusText: joinResponse.statusText(),
              location,
              setCookieCount: 0,
              challengeDetected,
              textPreview: responseText.slice(0, 500),
            },
            null,
            2
          )
        );
        return { status: joinResponse.status(), location, challengeDetected };
      };

      let promotionToken = (await getFormCsrfToken(page)) || csrfHeaderValue;
      if (!promotionToken) {
        console.log("Join promotion skipped: _token not found.");
      } else {
        let joinResult = await runJoinPromotionRequest(promotionToken, "attempt-1");
        if (joinResult.challengeDetected) {
          console.log("Challenge response detected. Waiting and retrying join request once.");
          await page.waitForTimeout(5000);
          await dismissSiteOverlays(page, 7000);
          await ensurePromotionPageLoaded(page, promotionPageUrl, promotionId, "join-retry");
          await dismissSiteOverlays(page, 7000);
          promotionToken = (await getFormCsrfToken(page)) || promotionToken;
          joinResult = await runJoinPromotionRequest(promotionToken, "attempt-2");
        }
      }
    } else {
      console.log("Join promotion skipped: login API did not return explicit Login Success.");
    }
    }

    if (verbose) {
      await printBrowserState("Browser state after login attempts", page, browser);
    }
  }
} finally {
  await browser.close();
  console.log("Browser closed.");
}
