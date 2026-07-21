/**
 * One-time Google OAuth consent → refresh token, for the Drive tools.
 *
 *   npm run drive:auth
 *
 * Why this exists: the Cloud org enforces `iam.disableServiceAccountKeyCreation`, so a service-account
 * JSON key cannot be downloaded. Instead we authorise ONCE as the human who owns the Drive folder and
 * keep the resulting refresh token in `.env`; google-auth.ts then trades it for access tokens forever.
 *
 * Flow (the "rclone pattern"): this prints a consent URL you open in a browser on ANY machine. Google
 * redirects to a localhost URL that will not load — that is expected and harmless. Copy the `code=`
 * value out of the browser's address bar and paste it back here. Nothing listens on a port, so this
 * works fine over SSH on a headless server.
 *
 * The code is single-use and expires in minutes; re-run this if it fails.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { envVar, writeEnabled } from "./env";
import { scope } from "./google-auth";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Desktop-app clients accept this loopback redirect; nothing needs to actually listen on it. */
const REDIRECT_URI = "http://localhost:53682/";

async function main(): Promise<void> {
  const clientId = envVar("GOOGLE_OAUTH_CLIENT_ID")?.trim();
  const clientSecret = envVar("GOOGLE_OAUTH_CLIENT_SECRET")?.trim();
  if (!clientId || !clientSecret) {
    console.error(
      "Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env.\n" +
        "Create them at console.cloud.google.com → APIs & Services → Credentials →\n" +
        "Create credentials → OAuth client ID → Application type: Desktop app.",
    );
    process.exit(1);
  }

  const granted = scope();
  const url =
    `${AUTH_URL}?` +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: granted,
      access_type: "offline", // → we get a refresh_token
      prompt: "consent", // → force a refresh_token even on re-consent
      include_granted_scopes: "true",
    }).toString();

  console.log(`\nScope being requested: ${granted}`);
  console.log(writeEnabled() ? "  (DRIVE_MCP_WRITE is ON — full read/write scope)" : "  (read-only; set DRIVE_MCP_WRITE=1 first if you want write tools)");
  console.log("\n1. Open this URL in a browser, signed in as the account that OWNS the Drive folder:\n");
  console.log(url);
  console.log(
    "\n2. Approve. The browser will then fail to load a http://localhost:53682/... page — that is EXPECTED.\n" +
      "3. Copy the whole address-bar URL (or just the code= value) and paste it below.\n",
  );

  const rl = createInterface({ input: stdin, output: stdout });
  const pasted = (await rl.question("Paste the redirect URL or code: ")).trim();
  rl.close();

  // Accept either the full redirect URL or a bare code.
  let code = pasted;
  if (/^https?:\/\//i.test(pasted)) {
    const got = new URL(pasted).searchParams.get("code");
    if (!got) throw new Error("That URL has no ?code= parameter — copy the full address after approving.");
    code = got;
  }
  code = decodeURIComponent(code);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json()) as { refresh_token?: string; scope?: string; error_description?: string; error?: string };
  if (!res.ok || !json.refresh_token) {
    throw new Error(
      `Token exchange failed (${res.status}): ${json.error_description || json.error || "no refresh_token returned"}\n` +
        "If the code expired or was already used, just re-run `npm run drive:auth`.",
    );
  }

  console.log("\n✅ Success. Add this line to .env (then restart pm2):\n");
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${json.refresh_token}`);
  console.log(`\nGranted scope: ${json.scope ?? granted}`);
  console.log("Keep it secret — it is a long-lived credential to that Google account's Drive.\n");
}

main().catch((e) => {
  console.error("\ndrive:auth failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
