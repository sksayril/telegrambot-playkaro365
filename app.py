from pathlib import Path
import json
import os
import re
import time
from urllib.parse import unquote

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException, ElementClickInterceptedException
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


def load_local_env():
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_local_env()


def read_storage(storage_name):
    return driver.execute_script(
        f"""
        const out = {{}};
        const s = window.{storage_name};
        for (let i = 0; i < s.length; i++) {{
            const k = s.key(i);
            out[k] = s.getItem(k);
        }}
        return out;
        """
    )


def print_browser_state(label):
    print(f"\n=== {label} ===")
    all_cookies = driver.get_cookies()
    print(f"Total cookies: {len(all_cookies)}")
    print(json.dumps(all_cookies, indent=2))

    local_storage = read_storage("localStorage")
    print(f"Total localStorage keys: {len(local_storage)}")
    print(json.dumps(local_storage, indent=2))

    session_storage = read_storage("sessionStorage")
    print(f"Total sessionStorage keys: {len(session_storage)}")
    print(json.dumps(session_storage, indent=2))


def close_after_deposit_popup(timeout=5):
    """Close the blocking after-deposit modal if it appears."""
    try:
        popup = WebDriverWait(driver, timeout).until(
            EC.visibility_of_element_located(
                (
                    By.CSS_SELECTOR,
                    "div.dialog.after-deposit-wrapper.dialog--active",
                )
            )
        )
    except TimeoutException:
        return False

    try:
        close_icon = popup.find_element(
            By.CSS_SELECTOR,
            "i.icon.mdi.mdi-close[onclick*='cashBack_before_deposit_popup_reset']",
        )
        try:
            close_icon.click()
        except ElementClickInterceptedException:
            driver.execute_script("arguments[0].click();", close_icon)
        WebDriverWait(driver, 5).until(EC.invisibility_of_element(popup))
        print("Closed after-deposit popup.")
        return True
    except Exception as exc:
        print(f"After-deposit popup detected but could not be closed: {exc}")
        return False


def get_form_csrf_token():
    """Best-effort fetch of Laravel-style form _token after login."""
    token = driver.execute_script(
        """
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (meta && meta.content) return meta.content;

        const input = document.querySelector('input[name="_token"]');
        if (input && input.value) return input.value;

        if (window.Laravel && window.Laravel.csrfToken) return window.Laravel.csrfToken;
        if (window.csrfToken) return window.csrfToken;
        return null;
        """
    )
    if token:
        return unquote(token)
    return None


def analyze_promotion_join_result(result):
    """
    Classify joinPromotion result into a human-readable verdict.
    Returns dict: {"verdict": str, "reasons": [str, ...]}.
    """
    if not isinstance(result, dict):
        return {"verdict": "unknown", "reasons": ["Result payload is not an object."]}

    reasons = []
    text = str(result.get("text") or result.get("textPreview") or "")
    text_lower = text.lower()

    if not result.get("ok"):
        reasons.append("HTTP/fetch layer reported failure.")
        if result.get("error"):
            reasons.append(f"Error: {result.get('error')}")
        return {"verdict": "failed", "reasons": reasons}

    if result.get("statusText") == "FORM_POST_SUBMITTED":
        reasons.append("Fallback form POST completed and returned HTML.")

    # Common markers for success/failure on Laravel + Bootstrap alert pages.
    success_markers = (
        "promotion joined",
        "joined successfully",
        "successfully joined",
        "alert-success",
        "congratulations",
    )
    failure_markers = (
        "alert-danger",
        "invalid amount",
        "insufficient",
        "already joined",
        "something went wrong",
    )
    auth_markers = (
        'id="user_login"',
        'name="email"',
        "btnlogin",
        "login",
        "sign in",
    )

    if any(marker in text_lower for marker in success_markers):
        reasons.append("Detected success marker(s) in response body.")
        return {"verdict": "success", "reasons": reasons}

    if any(marker in text_lower for marker in failure_markers):
        reasons.append("Detected failure marker(s) in response body.")
        return {"verdict": "failed", "reasons": reasons}

    # Detect obvious auth redirect/login HTML.
    auth_hits = sum(1 for marker in auth_markers if marker in text_lower)
    if auth_hits >= 2:
        reasons.append("Response body looks like login/auth page.")
        return {"verdict": "likely_auth_redirect", "reasons": reasons}

    # Heuristic: HTML-only response with no explicit markers.
    if re.search(r"<html|<!doctype html", text_lower):
        reasons.append("Received generic HTML page with no clear success/failure marker.")
        return {"verdict": "unknown_html_response", "reasons": reasons}

    reasons.append("No known success/failure marker matched.")
    return {"verdict": "unknown", "reasons": reasons}


options = Options()

# Using your real Chrome profile while any Chrome window is open locks that folder;
# Chrome often launches but never loads pages. Use a dedicated dir (default), or
# set USE_SYSTEM_PROFILE = True and close every Chrome window before running.
USE_SYSTEM_PROFILE = False

if USE_SYSTEM_PROFILE:
    options.add_argument(r"--user-data-dir=C:\Users\Admin\AppData\Local\Google\Chrome\User Data")
    options.add_argument("--profile-directory=Profile 2")
else:
    profile_dir = Path(__file__).resolve().parent / "selenium_chrome_profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    options.add_argument(f"--user-data-dir={profile_dir}")

options.add_argument("--disable-blink-features=AutomationControlled")
options.add_argument("--incognito")
options.add_experimental_option("excludeSwitches", ["enable-automation"])
options.add_experimental_option("useAutomationExtension", False)
# options.add_argument("--headless=new")
# Keep the browser open after the script exits (same idea as not calling quit()).
options.add_experimental_option("detach", True)

driver = webdriver.Chrome(options=options)
driver.set_page_load_timeout(90)

try:
    driver.get("https://playkaro365.com/")
except TimeoutException:
    driver.execute_script("window.stop();")
time.sleep(3)
close_after_deposit_popup(timeout=6)

print(driver.title)
print(driver.current_url)

cookies = driver.get_cookies()
print_browser_state("Initial browser state")

# Try to locate CSRF token from cookies and browser storage.
token_keys = ("x-csrf-token", "xsrf-token", "csrf-token", "csrf", "_csrf")
x_csrf_token = None

for cookie in cookies:
    name = cookie.get("name", "").lower()
    if any(key in name for key in token_keys):
        x_csrf_token = cookie.get("value")
        break

if not x_csrf_token:
    for storage_name in ("localStorage", "sessionStorage"):
        storage_items = read_storage(storage_name)
        for key, value in storage_items.items():
            key_lower = key.lower()
            if any(token_key in key_lower for token_key in token_keys):
                x_csrf_token = value
                break
        if x_csrf_token:
            break

if x_csrf_token:
    decoded_token = unquote(x_csrf_token)
    print(f"x-csrf-token (raw): {x_csrf_token}")
    print(f"x-csrf-token (decoded): {decoded_token}")
else:
    print("x-csrf-token not found in cookies/localStorage/sessionStorage.")

# Build and call login API using the same browser session/cookies.
login_email = os.getenv("PLAYKARO_EMAIL", "").strip()
login_password = os.getenv("PLAYKARO_PASSWORD", "").strip()

if not login_email or not login_password:
    print("Login skipped: set PLAYKARO_EMAIL and PLAYKARO_PASSWORD env vars.")
elif not x_csrf_token:
    print("Login API skipped: x-csrf-token is required.")
else:
    print("\n--- UI login attempt ---")
    close_after_deposit_popup(timeout=3)
    wait = WebDriverWait(driver, 20)
    username_input = wait.until(EC.visibility_of_element_located((By.ID, "user_login")))
    password_input = wait.until(EC.visibility_of_element_located((By.ID, "pass_eye_user")))
    login_button = wait.until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, "button.btnLogin"))
    )

    def set_input_value(element, value):
        driver.execute_script(
            """
            const el = arguments[0];
            const val = arguments[1];
            el.focus();
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value"
            ).set;
            setter.call(el, val);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            """,
            element,
            value,
        )

    # Vue/SPA forms often require DOM events in addition to typing.
    set_input_value(username_input, login_email)
    set_input_value(password_input, login_password)

    # Fallback if value did not stick.
    if username_input.get_attribute("value") != login_email:
        username_input.clear()
        username_input.send_keys(login_email)
    if password_input.get_attribute("value") != login_password:
        password_input.clear()
        password_input.send_keys(login_password)
    time.sleep(3)

    remember_checkbox = driver.find_element(By.ID, "rememberMe")
    if remember_checkbox.is_selected():
        driver.execute_script("arguments[0].click();", remember_checkbox)

    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", login_button)
    close_after_deposit_popup(timeout=2)
    try:
        login_button.click()
    except ElementClickInterceptedException:
        driver.execute_script("arguments[0].click();", login_button)

    print(f"Filled username: {username_input.get_attribute('value')}")
    print(f"Filled password length: {len(password_input.get_attribute('value') or '')}")
    print("UI login submitted.")

    try:
        error_box = WebDriverWait(driver, 5).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, ".desk_log_error"))
        )
        print(f"UI login error: {error_box.text.strip()}")
    except Exception:
        print("UI login error box not visible (may be success or delayed response).")

    socket_id = driver.execute_script(
        """
        try {
          if (window.Echo && typeof window.Echo.socketId === "function") {
            return window.Echo.socketId();
          }
          if (window.Pusher && window.Pusher.instances) {
            const keys = Object.keys(window.Pusher.instances);
            if (keys.length > 0) {
              const p = window.Pusher.instances[keys[0]];
              if (p && p.connection && p.connection.socket_id) {
                return p.connection.socket_id;
              }
            }
          }
        } catch (e) {}
        return null;
        """
    )
    user_agent = driver.execute_script("return navigator.userAgent;")
    csrf_header_value = unquote(x_csrf_token)

    print("\n--- Login request details ---")
    print("POST https://playkaro365.com/api2/v2/login")
    print(
        json.dumps(
            {
                "Accept": "*/*",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Origin": "https://playkaro365.com",
                "Referer": "https://playkaro365.com/",
                "User-Agent": user_agent,
                "X-CSRF-Token": csrf_header_value,
                "X-Requested-With": "XMLHttpRequest",
                **({"X-Socket-Id": str(socket_id)} if socket_id else {}),
            },
            indent=2,
        )
    )
    print("Body: email=<redacted>&password=<redacted>&remember_me=false")

    login_result = driver.execute_async_script(
        """
        const email = arguments[0];
        const password = arguments[1];
        const csrf = arguments[2];
        const socketId = arguments[3];
        const done = arguments[arguments.length - 1];

        const body = new URLSearchParams({
          email,
          password,
          remember_me: "false",
        }).toString();

        const headers = {
          "Accept": "*/*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-CSRF-Token": csrf,
          "X-Requested-With": "XMLHttpRequest",
        };
        if (socketId) headers["X-Socket-Id"] = String(socketId);

        fetch("https://playkaro365.com/api2/v2/login", {
          method: "POST",
          headers,
          body,
          credentials: "include",
        })
          .then(async (res) => {
            const text = await res.text();
            done({
              ok: res.ok,
              status: res.status,
              statusText: res.statusText,
              text,
            });
          })
          .catch((err) => done({ ok: false, error: String(err) }));
        """,
        login_email,
        login_password,
        csrf_header_value,
        socket_id,
    )

    print("\n--- Login API response ---")
    print(json.dumps(login_result, indent=2))

    promotion_id = os.getenv("PLAYKARO_PROMOTION_ID", "14").strip() or "14"
    promotion_amount = os.getenv("PLAYKARO_PROMO_AMOUNT", "1000").strip() or "1000"
    # Open the promotions page in UI context first.
    try:
        driver.get(f"https://playkaro365.com/promotions/{promotion_id}")
        close_after_deposit_popup(timeout=3)
    except TimeoutException:
        driver.execute_script("window.stop();")
    form_token = get_form_csrf_token() or csrf_header_value

    print("\n--- Promotion join UI flow ---")
    print(f"Navigated to: https://playkaro365.com/promotions/{promotion_id}")
    print("Steps: click Join Now -> wait popup -> set amount -> click Confirm")

    promotion_result = driver.execute_async_script(
        """
        const promotionId = arguments[0];
        const amount = arguments[1];
        const fallbackToken = arguments[2];
        const done = arguments[arguments.length - 1];

        const targetPath = `/joinPromotion/${promotionId}`;
        const captures = [];

        const parseBody = (body) => {
          if (!body) return {};
          try {
            if (typeof body === "string") {
              return Object.fromEntries(new URLSearchParams(body).entries());
            }
            if (body instanceof URLSearchParams) {
              return Object.fromEntries(body.entries());
            }
            if (body instanceof FormData) {
              return Object.fromEntries(body.entries());
            }
          } catch (e) {}
          return { raw: String(body) };
        };

        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const [input, init = {}] = args;
          const url = typeof input === "string" ? input : (input && input.url) || "";
          const method = (init.method || (input && input.method) || "GET").toUpperCase();
          const requestBody = init.body || null;
          const isTarget = url.includes(targetPath);
          const reqHeaders = init.headers || {};
          const res = await originalFetch(...args);
          if (isTarget) {
            let text = "";
            try { text = await res.clone().text(); } catch (e) {}
            captures.push({
              transport: "fetch",
              url,
              method,
              requestHeaders: reqHeaders,
              requestForm: parseBody(requestBody),
              status: res.status,
              ok: res.ok,
              statusText: res.statusText,
              responsePreview: text.slice(0, 1200),
            });
          }
          return res;
        };

        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__pkMethod = method;
          this.__pkUrl = url;
          this.__pkHeaders = {};
          return origOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
          if (this.__pkHeaders) this.__pkHeaders[name] = value;
          return origSetHeader.call(this, name, value);
        };
        XMLHttpRequest.prototype.send = function(body) {
          const isTarget = (this.__pkUrl || "").includes(targetPath);
          if (isTarget) {
            this.addEventListener("loadend", () => {
              captures.push({
                transport: "xhr",
                url: this.__pkUrl || "",
                method: String(this.__pkMethod || "GET").toUpperCase(),
                requestHeaders: this.__pkHeaders || {},
                requestForm: parseBody(body),
                status: this.status,
                ok: this.status >= 200 && this.status < 300,
                statusText: this.statusText,
                responsePreview: String(this.responseText || "").slice(0, 1200),
              });
            });
          }
          return origSend.call(this, body);
        };

        const restoreTransportHooks = () => {
          window.fetch = originalFetch;
          XMLHttpRequest.prototype.open = origOpen;
          XMLHttpRequest.prototype.send = origSend;
          XMLHttpRequest.prototype.setRequestHeader = origSetHeader;
        };

        const clickEl = (el) => {
          if (!el) return;
          el.scrollIntoView({ block: "center", inline: "center" });
          try { el.click(); } catch (e) {}
          try { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch (e) {}
        };

        const setInputValue = (el, value) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(el, String(value));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        };

        const waitFor = (fn, timeoutMs = 15000, pollMs = 150) =>
          new Promise((resolve, reject) => {
            const started = Date.now();
            const timer = setInterval(() => {
              let value = null;
              try { value = fn(); } catch (e) {}
              if (value) {
                clearInterval(timer);
                resolve(value);
                return;
              }
              if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                reject(new Error("Timeout waiting for expected UI element/action."));
              }
            }, pollMs);
          });

        (async () => {
          try {
            const joinBtn = await waitFor(
              () => document.querySelector("button.join-now-btn, .actions button[onclick*='promo_joinnow_page']"),
              15000
            );
            clickEl(joinBtn);

            const amountInput = await waitFor(
              () =>
                document.querySelector(
                  "input[name='amount'], input#amount, .dialog input[type='number'], .modal input[type='number']"
                ),
              15000
            );
            setInputValue(amountInput, amount);

            const confirmBtn = await waitFor(
              () => {
                const buttons = Array.from(document.querySelectorAll("button"));
                return buttons.find((btn) => /confirm/i.test((btn.textContent || "").trim()));
              },
              15000
            );
            clickEl(confirmBtn);

            await waitFor(() => captures.length > 0, 15000, 100);
            const lastCapture = captures[captures.length - 1] || {};
            const requestForm = lastCapture.requestForm || {};
            const tokenFromRequest = requestForm._token || fallbackToken || null;
            const amountFromRequest = requestForm.amount || String(amount);

            done({
              ok: Boolean(lastCapture.ok),
              status: lastCapture.status || 0,
              statusText: lastCapture.statusText || "UNKNOWN",
              method: lastCapture.method || "POST",
              url: lastCapture.url || `https://playkaro365.com${targetPath}`,
              requestHeaders: lastCapture.requestHeaders || {},
              requestForm,
              tokenFromRequest,
              amountFromRequest,
              text: lastCapture.responsePreview || "",
              captureCount: captures.length,
            });
          } catch (err) {
            done({ ok: false, error: String(err), captureCount: captures.length });
          } finally {
            restoreTransportHooks();
          }
        })();
        """,
        promotion_id,
        promotion_amount,
        form_token,
    )

    print("\n--- Promotion join API response ---")
    print(json.dumps(promotion_result, indent=2))
    promotion_verdict = analyze_promotion_join_result(promotion_result)
    print("\n--- Promotion join verdict ---")
    print(json.dumps(promotion_verdict, indent=2))
    print_browser_state("Browser state after login attempts")
