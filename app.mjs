import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadLocalEnv() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const USE_SYSTEM_PROFILE = false;
const USER_DATA_DIR = join(__dirname, "selenium_chrome_profile");
const SYSTEM_CHROME_USER_DATA = String.raw`C:\Users\Admin\AppData\Local\Google\Chrome\User Data`;
const SYSTEM_PROFILE_DIR = "Profile 2";

const HEADLESS = process.env.PLAYKARO_HEADLESS !== "false";

const tokenKeys = ["x-csrf-token", "xsrf-token", "csrf-token", "csrf", "_csrf"];

function readStorage(page, storageName) {
  return page.evaluate((name) => {
    const out = {};
    const s = window[name];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      out[k] = s.getItem(k);
    }
    return out;
  }, storageName);
}

async function printBrowserState(label, context, page) {
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

function findCsrfFromCookies(cookies) {
  for (const c of cookies) {
    const name = (c.name || "").toLowerCase();
    if (tokenKeys.some((k) => name.includes(k))) return c.value;
  }
  return null;
}

async function findCsrfFromStorage(page) {
  for (const storageName of ["localStorage", "sessionStorage"]) {
    const items = await readStorage(page, storageName);
    for (const [key, value] of Object.entries(items)) {
      const kl = key.toLowerCase();
      if (tokenKeys.some((tk) => kl.includes(tk))) return value;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  mkdirSync(USER_DATA_DIR, { recursive: true });

  const userDataDir = USE_SYSTEM_PROFILE ? SYSTEM_CHROME_USER_DATA : USER_DATA_DIR;
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    ...(USE_SYSTEM_PROFILE ? [`--profile-directory=${SYSTEM_PROFILE_DIR}`] : []),
  ];

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: HEADLESS,
    executablePath: process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    args: launchArgs,
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 1280, height: 720 },
  });

  const page = context.pages()[0] ?? (await context.newPage());

  const siteUrl = process.env.PLAY_SITE_URL || "https://playkaro365.com/";
  const siteOrigin = new URL(siteUrl).origin;
  const loginApiUrl = `${siteOrigin}/api2/v2/login`;

  try {
    await page.goto(siteUrl, { timeout: 90_000, waitUntil: "domcontentloaded" });
  } catch {
    await page.evaluate(() => window.stop());
  }
  await sleep(3000);

  // Close any promo dialog (like on spinjeet.com)
  try {
    const dialogClose = page.locator("div.dialog.after-deposit-wrapper.dialog--active i.mdi-close, .modalClose i.mdi-close").first();
    if (await dialogClose.count() > 0 && await dialogClose.isVisible()) {
      await dialogClose.click({ timeout: 2000 });
      await sleep(1000);
    }
  } catch (e) {}

  // Skip aviator slider (like on spinjeet.com)
  try {
    const skipBtn = page.locator(".skip_right_img, .skip-button").first();
    if (await skipBtn.count() > 0 && await skipBtn.isVisible()) {
      await skipBtn.click({ timeout: 2000 });
      await sleep(1000);
    }
  } catch (e) {}

  console.log(await page.title());
  console.log(page.url());

  let cookies = await context.cookies();
  await printBrowserState("Initial browser state", context, page);

  let xCsrfToken = findCsrfFromCookies(cookies);
  if (!xCsrfToken) xCsrfToken = await findCsrfFromStorage(page);

  if (xCsrfToken) {
    const decoded = decodeURIComponent(xCsrfToken);
    console.log(`x-csrf-token (raw): ${xCsrfToken}`);
    console.log(`x-csrf-token (decoded): ${decoded}`);
  } else {
    console.log("x-csrf-token not found in cookies/localStorage/sessionStorage.");
  }

  const loginEmail = (process.env.PLAYKARO_EMAIL || "").trim();
  const loginPassword = (process.env.PLAYKARO_PASSWORD || "").trim();

  if (!loginEmail || !loginPassword) {
    console.log("Login skipped: set PLAYKARO_EMAIL and PLAYKARO_PASSWORD in .env or env.");
  } else if (!xCsrfToken) {
    console.log("Login API skipped: x-csrf-token is required.");
  } else {
    console.log("\n--- UI login attempt ---");
    await page.waitForSelector("#user_login", { state: "visible", timeout: 20_000 });
    await page.waitForSelector("#pass_eye_user", { state: "visible", timeout: 20_000 });
    await page.waitForSelector("button.btnLogin", { state: "visible", timeout: 20_000 });

    await page.evaluate(
      ([email, pwd]) => {
        function setInputValue(el, val) {
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          ).set;
          setter.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }
        const u = document.querySelector("#user_login");
        const p = document.querySelector("#pass_eye_user");
        if (u) setInputValue(u, email);
        if (p) setInputValue(p, pwd);
      },
      [loginEmail, loginPassword]
    );

    const uVal = await page.inputValue("#user_login").catch(() => "");
    if (uVal !== loginEmail) {
      await page.fill("#user_login", "");
      await page.type("#user_login", loginEmail);
    }
    const pVal = await page.inputValue("#pass_eye_user").catch(() => "");
    if (pVal !== loginPassword) {
      await page.fill("#pass_eye_user", "");
      await page.type("#pass_eye_user", loginPassword);
    }

    await sleep(3000);

    await page.locator("#rememberMe").evaluate((el) => {
      if (el.checked) el.click();
    });

    const loginBtn = page.locator("button.btnLogin");
    await loginBtn.scrollIntoViewIfNeeded();
    try {
      await loginBtn.click({ timeout: 5000 });
    } catch {
      await loginBtn.evaluate((el) => el.click());
    }

    console.log(`Filled username: ${await page.inputValue("#user_login")}`);
    console.log(`Filled password length: ${(await page.inputValue("#pass_eye_user")).length}`);
    console.log("UI login submitted.");

    const errVisible = await page
      .locator(".desk_log_error")
      .isVisible()
      .catch(() => false);
    if (errVisible) {
      const txt = await page.locator(".desk_log_error").innerText();
      console.log(`UI login error: ${txt.trim()}`);
    } else {
      console.log("UI login error box not visible (may be success or delayed response).");
    }

    const socketId = await page.evaluate(() => {
      try {
        if (window.Echo && typeof window.Echo.socketId === "function") {
          return window.Echo.socketId();
        }
        if (window.Pusher && window.Pusher.instances) {
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
    });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const csrfHeaderValue = decodeURIComponent(xCsrfToken);

    console.log("\n--- Login request details ---");
    console.log(`POST ${loginApiUrl}`);
    const headerObj = {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: siteOrigin,
      Referer: siteUrl,
      "User-Agent": userAgent,
      "X-CSRF-Token": csrfHeaderValue,
      "X-Requested-With": "XMLHttpRequest",
      ...(socketId ? { "X-Socket-Id": String(socketId) } : {}),
    };
    console.log(JSON.stringify(headerObj, null, 2));
    console.log("Body: email=<redacted>&password=<redacted>&remember_me=false");

    const loginResult = await page.evaluate(
      async ({ email, password, csrf, socketId: sid }) => {
        const body = new URLSearchParams({
          email,
          password,
          remember_me: "false",
        }).toString();
        const headers = {
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-CSRF-Token": csrf,
          "X-Requested-With": "XMLHttpRequest",
        };
        if (sid) headers["X-Socket-Id"] = String(sid);
        const res = await fetch(loginApiUrl, {
          method: "POST",
          headers,
          body,
          credentials: "include",
        });
        const text = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          text,
        };
      },
      { email: loginEmail, password: loginPassword, csrf: csrfHeaderValue, socketId, loginApiUrl }
    );

    console.log("\n--- Login API response ---");
    console.log(JSON.stringify(loginResult, null, 2));
    await printBrowserState("Browser state after login attempts", context, page);
  }

  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
