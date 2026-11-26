// The page the phone app's connect code opens (ANDROID_APP_SPEC): Settings → Phone app shows a QR of
// `<server>/phone/connect#t=<token>`. Every camera and QR reader opens a web link, so the code works
// with any of them; this page then hands the token to the app with one tap (an `intent://` link,
// which Chrome on Android follows only on a tap). The token stays in the fragment: it never reaches
// this server, its logs or a referrer. No app on the phone yet: the same page offers its file.
import { createHash } from 'node:crypto';

/** The app's package (android/AndroidManifest.xml). */
export const PHONE_APP_PACKAGE = 'app.recollect.phone';

// Reads the fragment, builds the link to the app and picks what the page says. Plain ES5: no build step.
const SCRIPT = `(function () {
  var hash = new URLSearchParams(location.hash.slice(1));
  var token = hash.get('t');
  var missing = new URLSearchParams(location.search).get('missing') === '1';
  var android = /Android/i.test(navigator.userAgent);
  var show = function (id, on) { var el = document.getElementById(id); if (el) el.hidden = !on; };
  if (!token) { show('ready', false); show('no-code', true); return; }
  if (!android) { show('ready', false); show('not-android', true); return; }
  var data = 'connect?server=' + encodeURIComponent(location.origin) + '&token=' + encodeURIComponent(token);
  var fallback = location.origin + location.pathname + '?missing=1' + location.hash;
  var link = 'intent://' + data + '#Intent;scheme=recollect;package=${PHONE_APP_PACKAGE};S.browser_fallback_url=' + encodeURIComponent(fallback) + ';end';
  var buttons = document.querySelectorAll('[data-open]');
  for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute('href', link);
  var getIt = document.getElementById('get-it');
  if (getIt) getIt.setAttribute('href', fallback);
  if (missing) { show('first-open', false); show('missing', true); }
})();`;

const SCRIPT_HASH = createHash('sha256').update(SCRIPT).digest('base64');

/** The page's own headers: nothing loads from elsewhere, only this script runs, nothing frames it. */
export const CONNECT_PAGE_HEADERS: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
};

/** "62 KB", "1.4 MB". */
export function fileSize(bytes: number): string {
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Kaaga's mark (components/brand/Logo.tsx), in ink.
const MARK = `<svg class="mark" viewBox="12 10 32 28" width="44" height="38" aria-hidden="true"><path d="M16 24C16 19 19 16 22 16C25 16 26.5 17.5 28 19.5C29.5 17.5 31 16 34 16C37 16 40 19 40 24C40 29 37 32 34 32C31 32 29.5 30.5 28 28.5C26.5 30.5 25 32 22 32C19 32 16 29 16 24Z" fill="currentColor" opacity="0.12"/><path d="M16 24C16 19 19 16 22 16C25 16 26.5 17.5 28 19.5M28 19.5C29.5 17.5 31 16 34 16C37 16 40 19 40 24C40 29 37 32 34 32C31 32 29.5 30.5 28 28.5M28 28.5C26.5 30.5 25 32 22 32C19 32 16 29 16 24M28 19.5V28.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="22" cy="16" r="2.5" fill="currentColor"/><circle cx="34" cy="16" r="2.5" fill="currentColor"/><circle cx="28" cy="24" r="3" fill="currentColor"/></svg>`;

/** The page. `apkBytes`: the app's file size when this server has it, else null. */
export function connectPage(apkBytes: number | null): string {
    const download = apkBytes !== null
        ? `<a class="btn main" href="/phone/kaaga.apk" download>Download the phone app</a>
      <p class="meta">Android, ${fileSize(apkBytes)}. Open the file to install it: the phone asks once to allow installs from Chrome. Then come back here and tap Open the phone app.</p>`
        : `<p class="meta">This server doesn't have the phone app's file yet. Install it from the computer (see android/README.md in Kaaga), then tap Open the phone app.</p>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>Connect this phone · Kaaga</title>
<style>
  :root { --page:#FFFFFF; --ink-1:#2C2C2B; --ink-2:#5F5E59; --ink-3:#73706B; --ring:#E3E2DF; --main:#2C2C2B; --main-hover:#3F3E3C; --on-main:#FFFFFF; --surface:#FFFFFF; --accent:#1F6FD1; --focus:#2383E2; }
  @media (prefers-color-scheme: dark) { :root { --page:#191919; --ink-1:#F0EFED; --ink-2:#ADA9A3; --ink-3:#8E8B86; --ring:#383836; --main:#E6E5E3; --main-hover:#F0EFED; --on-main:#191919; --surface:#202020; --accent:#5B9BEA; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--page); color: var(--ink-1); }
  body { font: 400 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-text-size-adjust: 100%; }
  main { max-width: 440px; margin: 0 auto; padding: 56px 16px 40px; }
  .mark { color: var(--ink-1); display: block; }
  h1 { font-size: 28px; font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; margin: 20px 0 8px; }
  p { margin: 0 0 12px; color: var(--ink-2); }
  .meta { font-size: 13px; line-height: 1.45; color: var(--ink-3); }
  .btn { display: flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 16px; border-radius: 8px; font-size: 15px; font-weight: 500; text-decoration: none; margin: 24px 0 12px; transition: background-color 120ms; -webkit-tap-highlight-color: transparent; }
  .btn.main { background: var(--main); color: var(--on-main); }
  .btn.main:active { background: var(--main-hover); }
  .btn.outline { background: var(--surface); color: var(--ink-1); box-shadow: inset 0 0 0 1px var(--ring), 0 1px 2px rgba(0,0,0,.04); }
  .btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--page), 0 0 0 5px var(--focus); }
  a { color: var(--accent); }
  .foot { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--ring); }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
</style>
</head>
<body>
<main>
  ${MARK}
  <div id="ready">
    <div id="first-open">
      <h1>Connect this phone</h1>
      <p>The phone app sets the picture of your day as the wallpaper and keeps a widget up to date. Tap the button to open it and finish connecting.</p>
      <a class="btn main" data-open href="#">Open the phone app</a>
      <p class="meta">No phone app yet? <a href="/phone/connect?missing=1" id="get-it">Get it here</a>.</p>
    </div>
    <div id="missing" hidden>
      <h1>Install the phone app first</h1>
      <p>It isn't on this phone yet.</p>
      ${download}
      <a class="btn outline" data-open href="#">Open the phone app</a>
    </div>
  </div>
  <div id="no-code" hidden>
    <h1>This link has no connect code</h1>
    <p>Make a new code on your computer: Kaaga → Settings → Phone app, then scan it with this phone's camera.</p>
  </div>
  <div id="not-android" hidden>
    <h1>Open this on your Android phone</h1>
    <p>The phone app is for Android. Scan the code in Kaaga → Settings → Phone app with the phone's camera.</p>
  </div>
  <p class="meta foot">The code only lets the app read the picture of your day and its lines. End it any time in Kaaga → Settings → Agents (&ldquo;Phone app&rdquo;).</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
