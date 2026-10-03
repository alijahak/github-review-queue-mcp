const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Client names and redirect URIs come from dynamic registration, i.e. from anyone. Escape everything. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export const CONSENT_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export interface ConsentView {
  clientName: string;
  redirectUri: string;
  pendingId: string;
  csrf: string;
  githubScope: string;
}

export function renderConsent(v: ConsentView): string {
  let redirectHost = v.redirectUri;
  try {
    redirectHost = new URL(v.redirectUri).host || v.redirectUri;
  } catch {
    // Registration already validated the URI; fall back to showing it whole.
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access to your GitHub review queue?</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; }
  .card { border: 1px solid #d0d7de; border-radius: 8px; padding: 1.5rem; }
  h1 { font-size: 1.25rem; margin-top: 0; }
  code { background: #f6f8fa; padding: .1rem .3rem; border-radius: 4px; }
  ul { padding-left: 1.2rem; }
  .actions { display: flex; gap: .75rem; margin-top: 1.25rem; }
  button { font: inherit; padding: .5rem 1rem; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer; }
  button.primary { background: #1f883d; border-color: #1f883d; color: #fff; }
  .muted { color: #59636e; font-size: .9rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Allow <strong>${escapeHtml(v.clientName)}</strong> to use your GitHub review queue?</h1>
  <p>After you approve, you'll sign in with GitHub. The app will then be able to:</p>
  <ul>
    <li>read pull requests, changed files and CI results in repositories your GitHub account can see;</li>
    <li>post comments and submit reviews <strong>as you</strong>, when you ask it to.</li>
  </ul>
  <p class="muted">You'll be sent back to <code>${escapeHtml(redirectHost)}</code>. GitHub permission requested: <code>${escapeHtml(v.githubScope)}</code>. If you don't recognize this app or that address, deny.</p>
  <form method="post" action="/consent">
    <input type="hidden" name="pending" value="${escapeHtml(v.pendingId)}">
    <input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">
    <div class="actions">
      <button class="primary" type="submit" name="decision" value="approve">Approve and sign in with GitHub</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </div>
  </form>
</div>
</body>
</html>`;
}
