import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

export const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * HTML page with a strict CSP. `formTarget`: the origin a form may end up at. Browsers apply
 * CSP form-action to the redirect that follows a form POST, so the validated client redirect
 * origin must be allowed, or the code never reaches the client (spike finding).
 */
export function page(
  title: string,
  body: string,
  status = 200,
  headers = new Headers(),
  formTarget?: string,
): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTarget ? ` ${formTarget}` : ''}; frame-ancestors 'none'`,
  );
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'no-store');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem}
input,button{font:inherit;padding:.5rem;margin:.25rem 0}input{width:100%;box-sizing:border-box}.warn{color:#a40}</style>
${body}</html>`,
    { status, headers },
  );
}

export function consentPage(d: ConsentDescription, handle: string, error?: string): string {
  const name = escape(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escape(d.clientDomain)}</strong>.`
    : 'This app registered itself; its name is <strong>not verified</strong>.';
  return `<h1>Allow ${name} to use your Netatmo heating?</h1>
<p>${origin} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ''}
<p>The assistant will be able to read your heating data, and to change it if write mode was enabled during setup (each change still needs your confirmation).</p>
${error ? `<p class="warn">${escape(error)}</p>` : ''}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<label>Owner password<input type="password" name="password" autocomplete="current-password" required></label>
<p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`;
}
