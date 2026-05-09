import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

const email = process.env.PLAYKARO_EMAIL;
const password = process.env.PLAYKARO_PASSWORD;
const headless =
  process.env.PLAYKARO_HEADLESS === undefined ||
  !/^(0|false|no)$/i.test(String(process.env.PLAYKARO_HEADLESS).trim());
const skipLogin = /^(1|true|yes)$/i.test(
  String(process.env.PLAYKARO_SKIP_LOGIN ?? "").trim()
);
const skipApiLogin = /^(1|true|yes)$/i.test(
  String(process.env.PLAYKARO_SKIP_API_LOGIN ?? "").trim()
);

if (!skipLogin && (!email || !password)) {
  console.error(
    "Add PLAYKARO_EMAIL and PLAYKARO_PASSWORD to a .env file in the project root, or set PLAYKARO_SKIP_LOGIN=1 to only fetch session/CSRF."
  );
  process.exit(1);
}

function decodeCookieVal(raw) {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function extractSessionBundle(page, context) {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const cookies = await context.cookies();
  const cookieHeader = cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const pageProbe = await page.evaluate(() => {
    const metas = [...document.querySelectorAll("meta")].map((m) => ({
      name: m.getAttribute("name"),
      property: m.getAttribute("property"),
      content: m.getAttribute("content"),
      httpEquiv: m.getAttribute("http-equiv"),
    }));
    const hiddenInputs = [...document.querySelectorAll('input[type="hidden"]')]
      .filter((i) => i.name)
      .map((i) => ({
        name: i.name,
        valuePreview:
          (i.value || "").length > 120
            ? `${(i.value || "").slice(0, 120)}…`
            : i.value || "",
      }));
    const csrfMeta =
      document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ||
      document.querySelector('meta[name="_token"]')?.getAttribute("content") ||
      null;
    let socketId = null;
    try {
      if (typeof window !== "undefined") {
        socketId =
          window.__socketId ??
          window.socketId ??
          window?.Echo?.socketId?.() ??
          window?.Echo?.connector?.pusher?.connection?.socket_id ??
          null;
      }
    } catch {
      /* ignore */
    }
    return { metas, hiddenInputs, csrfMeta, socketId, documentTitle: document.title };
  });

  const xsrf = cookies.find(
    (c) => c.name === "XSRF-TOKEN" || c.name.toLowerCase() === "xsrf-token"
  );
  const xsrfDecoded = xsrf ? decodeCookieVal(xsrf.value) : null;

  const csrfForHeader =
    pageProbe.csrfMeta ||
    xsrfDecoded ||
    cookies.find((c) => /csrf/i.test(c.name))?.value ||
    null;

  const suggestedApiHeaders = {
    Accept: "*/*",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: "https://playkaro365.com",
    Referer: "https://playkaro365.com/",
    "User-Agent": userAgent,
    "X-Requested-With": "XMLHttpRequest",
    ...(csrfForHeader ? { "X-CSRF-Token": csrfForHeader } : {}),
    ...(pageProbe.socketId ? { "X-Socket-Id": String(pageProbe.socketId) } : {}),
  };

  return {
    url: page.url(),
    userAgent,
    cookies,
    cookieHeader,
    pageProbe,
    xsrfRaw: xsrf?.value ?? null,
    xsrfDecoded,
    csrfForHeader,
    suggestedApiHeaders,
    loginEndpoint: "https://playkaro365.com/api2/v2/login",
  };
}

function logBundle(label, bundle) {
  console.log(`\n========== ${label} ==========\n`);
  console.log("URL:", bundle.url);
  console.log("User-Agent:", bundle.userAgent);
  console.log("\n--- Cookies (raw objects) ---\n");
  console.log(JSON.stringify(bundle.cookies, null, 2));
  console.log("\n--- Cookie header string (for requests) ---\n");
  console.log(bundle.cookieHeader);
  console.log("\n--- Page probe (meta, hidden inputs, csrf meta, socket id) ---\n");
  console.log(JSON.stringify(bundle.pageProbe, null, 2));
  console.log("\n--- XSRF cookie ---\n");
  console.log("raw:", bundle.xsrfRaw);
  console.log("decoded:", bundle.xsrfDecoded);
  console.log("\n--- Best CSRF value for X-CSRF-Token ---\n");
  console.log(bundle.csrfForHeader ?? "(not found — try longer wait or non-headless)");
  console.log("\n--- Suggested headers for POST /api2/v2/login ---\n");
  console.log(JSON.stringify(bundle.suggestedApiHeaders, null, 2));
  console.log("\n--- Login URL ---\n");
  console.log(bundle.loginEndpoint);
  console.log(`\n========== end ${label} ==========\n`);
}

/** Walk JSON for common auth token field names (paths + values). */
function collectTokenFields(obj, path = "") {
  if (obj === null || typeof obj !== "object") return [];
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === "string" && v.length > 0 && /token|jwt|bearer|^auth$/i.test(k)) {
      out.push({ path: p, value: v });
    } else if (typeof v === "object" && v !== null) {
      out.push(...collectTokenFields(v, p));
    }
  }
  return out;
}

function looksLikeAwsWafChallenge(text) {
  if (typeof text !== "string") return false;
  return (
    text.includes("Human Verification") ||
    text.includes("AwsWafIntegration") ||
    text.includes("aws-waf") ||
    text.includes("captcha.awswaf") ||
    text.includes("challenge.js")
  );
}

function logWafNotice() {
  console.log(`
--- AWS WAF / Human Verification ---

The server is returning a bot-check page (CAPTCHA), not the real login API.
There is no supported way to "bypass" this from automation; the site is
doing what it is designed to do.

What you can do legally:
  • Run with PLAYKARO_HEADLESS=false, complete the CAPTCHA in the window,
    then run again (or continue in the same session).
  • Ask the operator for an official API / mobile client token flow if
    they offer one for integrators.

This script will not integrate CAPTCHA solvers or WAF bypass tools.
`);
}

function logApiResponse(label, status, statusText, text, setCookieLines) {
  console.log(`\n--- ${label} ---\n`);
  console.log("status:", status, statusText || "");

  if (setCookieLines?.length) {
    console.log("\n--- Set-Cookie (raw) ---\n");
    setCookieLines.forEach((c) => console.log((c.split("\r\n")[0] ?? c).slice(0, 200)));
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }

  console.log("\n--- Response body ---\n");
  if (parsed !== null) {
    console.log(JSON.stringify(parsed, null, 2));
    const tokens = collectTokenFields(parsed);
    if (tokens.length) {
      console.log("\n--- Token-like fields (paths) ---\n");
      console.log(JSON.stringify(tokens, null, 2));
    }
  } else {
    console.log(text.slice(0, 8000));
    if (text.length > 8000) console.log("\n… (truncated)");
  }

  if (looksLikeAwsWafChallenge(text) || status === 405 || status === 403) {
    logWafNotice();
  }
}

/**
 * Same-origin fetch from inside the page (matches site XHR; browser adds Sec-Fetch-*).
 */
async function postLoginViaInPageFetch(page, bundle, credsEmail, credsPassword) {
  const formBody = new URLSearchParams({
    email: credsEmail,
    password: credsPassword,
    remember_me: "true",
  }).toString();

  return page.evaluate(
    async ({ url, formBody, csrf, socketId }) => {
      const headers = {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRF-Token": csrf,
        "X-Requested-With": "XMLHttpRequest",
      };
      if (socketId) headers["X-Socket-Id"] = String(socketId);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: formBody,
        credentials: "include",
      });
      const text = await res.text();
      return { status: res.status, statusText: res.statusText, text };
    },
    {
      url: bundle.loginEndpoint,
      formBody,
      csrf: bundle.csrfForHeader,
      socketId: bundle.pageProbe.socketId ?? null,
    }
  );
}

/**
 * POST /api2/v2/login: try in-page fetch first, then Playwright APIRequest (page.request).
 * Body is x-www-form-urlencoded (not JSON). WAF/CAPTCHA cannot be bypassed here.
 */
async function tryApiLogin(page, bundle, credsEmail, credsPassword) {
  console.log("\n========== API login (POST /api2/v2/login) ==========\n");

  if (skipApiLogin) {
    console.log("Skipped: PLAYKARO_SKIP_API_LOGIN=1\n");
    return null;
  }
  if (!credsEmail || !credsPassword) {
    console.log("Skipped: set PLAYKARO_EMAIL and PLAYKARO_PASSWORD in .env\n");
    return null;
  }
  if (!bundle.csrfForHeader) {
    console.log(
      "Skipped: no CSRF token (often blocked by WAF / Human Verification — try PLAYKARO_HEADLESS=false or wait until the real app shell loads).\n"
    );
    return null;
  }

  const formBody = new URLSearchParams({
    email: credsEmail,
    password: credsPassword,
    remember_me: "true",
  }).toString();

  console.log("Request Content-Type: application/x-www-form-urlencoded");
  console.log(
    "Request body (password redacted):",
    `email=${encodeURIComponent(credsEmail)}&password=***&remember_me=true`
  );

  console.log("\nAttempt 1: in-page fetch (same origin as open tab)…");
  const r1 = await postLoginViaInPageFetch(page, bundle, credsEmail, credsPassword);
  logApiResponse("in-page fetch", r1.status, r1.statusText, r1.text, null);

  let parsed1 = null;
  try {
    parsed1 = JSON.parse(r1.text);
  } catch {
    /* not JSON */
  }
  const waf1 = looksLikeAwsWafChallenge(r1.text);
  if (parsed1 !== null && !waf1) {
    console.log("\n========== end API login ==========\n");
    return { status: r1.status, parsed: parsed1, text: r1.text };
  }
  if (!waf1 && !parsed1 && r1.status >= 200 && r1.status < 300) {
    console.log("\n========== end API login ==========\n");
    return { status: r1.status, parsed: null, text: r1.text };
  }

  console.log("\nAttempt 2: Playwright page.request (shared cookie jar)…");
  const res = await page.request.post(bundle.loginEndpoint, {
    headers: bundle.suggestedApiHeaders,
    data: formBody,
  });

  const text = await res.text();
  const setCookies = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);

  logApiResponse(
    "page.request",
    res.status(),
    res.statusText(),
    text,
    setCookies
  );

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  console.log("\n========== end API login ==========\n");
  return { status: res.status(), parsed, text };
}

async function run() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      process.env.PLAYKARO_USER_AGENT?.trim() ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  console.log("headless:", headless, "| PLAYKARO_SKIP_LOGIN:", skipLogin);

  await page.goto("https://playkaro365.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const settleMs = Number(process.env.PLAYKARO_SETTLE_MS || 5000) || 5000;
  await new Promise((r) => setTimeout(r, settleMs));

  let bundle = await extractSessionBundle(page, context);
  logBundle("session after home load", bundle);

  await tryApiLogin(page, bundle, email, password);

  if (skipLogin) {
    await browser.close();
    return;
  }

  try {
    await page.fill('input[name="email"]', email, { timeout: 15_000 });
    await page.fill('input[name="password"]', password, { timeout: 15_000 });
  } catch (e) {
    console.warn("Could not fill login fields (modal or selectors):", e.message);
    await browser.close();
    return;
  }

  const remember = page.locator('input[name="remember_me"]');
  if ((await remember.count()) > 0) {
    await remember.check({ force: true }).catch(() => remember.click());
  }

  if (!headless) {
    console.log("If verification shows, complete it in the browser…");
  }

  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, settleMs));

  bundle = await extractSessionBundle(page, context);
  logBundle("session after submit attempt", bundle);

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
