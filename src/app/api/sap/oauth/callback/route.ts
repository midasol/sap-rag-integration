import { NextRequest, NextResponse } from 'next/server';
import { adk } from '@/lib/adk-client';
import { setSession } from '@/lib/session';
import { getOAuthPending, clearOAuthPending } from '@/lib/oauth-pending';
import { getLogger } from '@/lib/logger';

export const runtime = 'nodejs';

function html(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/**
 * Returns an HTML page that posts a message to window.opener and closes itself.
 *
 * Security note: postMessage uses origin '*' because the parent tab's origin is
 * not known server-side at this point. The frontend handler (T36+) is responsible
 * for validating the event source and origin before acting on the message.
 */
function popupHtml(payload: object, title: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;padding:2rem">
<p id="msg">Completing SAP login…</p>
<script>
(function(){
  var data = ${JSON.stringify(payload)};
  try { if (window.opener) window.opener.postMessage(Object.assign({type:'sap-oauth'}, data), '*'); } catch(e){}
  if (data.success) { setTimeout(function(){ window.close(); }, 200); }
  else { document.getElementById('msg').textContent = 'SAP login failed: ' + (data.error || 'unknown'); }
})();
</script></body>`;
}

export async function GET(req: NextRequest) {
  const log = getLogger();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errParam = url.searchParams.get('error');

  if (errParam) {
    log.warn({ event: 'sap.oauth.callback_error', err: errParam }, 'sap.oauth.callback_error');
    return html(popupHtml({ success: false, error: errParam }, 'SAP login failed'), 400);
  }
  if (!code || !state) {
    return html(popupHtml({ success: false, error: 'missing_code_or_state' }, 'SAP login failed'), 400);
  }

  const pending = await getOAuthPending();
  if (!pending) {
    return html(popupHtml({ success: false, error: 'no_pending_oauth' }, 'SAP login failed'), 400);
  }
  if (pending.state !== state) {
    log.warn({ event: 'sap.oauth.state_mismatch', expected: pending.state, got: state }, 'sap.oauth.state_mismatch');
    await clearOAuthPending();
    return html(popupHtml({ success: false, error: 'state_mismatch' }, 'SAP login failed'), 400);
  }

  try {
    // TODO: re-wire to a dedicated /sap/auth/oauth/exchange ADK endpoint.
    // The /run + function_call path was rejected by Gemini API; previous
    // wiring is removed. For now, callback fails closed.
    void code;
    void pending;
    const result = { success: false, error: 'oauth_pending_dedicated_endpoint' } as const;

    const raw = JSON.stringify(result);
    const isSuccess = raw.includes('"success":true');
    if (!isSuccess) {
      const m = /"error"\s*:\s*"([^"]+)"/.exec(raw);
      const error = m ? m[1] : 'oauth_failed';
      log.warn({ event: 'sap.oauth.exchange_failed', error }, 'sap.oauth.exchange_failed');
      await clearOAuthPending();
      return html(popupHtml({ success: false, error }, 'SAP login failed'), 401);
    }

    const userMatch = /"sap_user"\s*:\s*"([^"]+)"/.exec(raw);
    const sapUser = userMatch ? userMatch[1] : pending.userId;

    await setSession(sapUser);
    await clearOAuthPending();
    log.info({ event: 'sap.oauth.exchange_success', sap_user: sapUser }, 'sap.oauth.exchange_success');
    return html(popupHtml({ success: true, sap_user: sapUser }, 'SAP login complete'), 200);
  } catch (err) {
    log.error(
      { event: 'sap.oauth.callback_exception', err: err instanceof Error ? err.message : String(err) },
      'sap.oauth.callback_exception'
    );
    return html(popupHtml({ success: false, error: 'callback_failed' }, 'SAP login failed'), 500);
  }
}
