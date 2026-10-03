/**
 * Transactional email through Resend (https://resend.com): used for "Email me my results". Optional: without
 * RESEND_API_KEY the address is still stored and nothing is sent. EMAIL_FROM must be a sender on a domain verified
 * in Resend, e.g. "Wellness Whizz <hello@aiww.io>".
 */
import type { ResultItem, Session } from './db';
import { escapeHtml } from './html';
import { primaryProduct, shopUrl, type LinkEnv } from './links';

export interface EmailEnv extends LinkEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

export function emailEnabled(env: EmailEnv): boolean {
  return !!env.RESEND_API_KEY && !!env.EMAIL_FROM;
}

export async function sendEmail(env: EmailEnv, to: string, subject: string, html: string, text: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** The results email: the recommended supplements with a Buy on iHerb link each and a link back to the page. */
export function resultsEmail(env: EmailEnv, origin: string, session: Session, items: ResultItem[]): { subject: string; html: string; text: string } {
  const resultUrl = `${origin}/result/${session.id}`;
  const rows = items
    .map((item) => {
      const sup = item.supplement;
      const product = primaryProduct(sup);
      const buy = shopUrl(env, sup, product);
      const photo = product?.image ? `${origin}${product.image}` : '';
      return `
        <tr>
          <td style="padding:14px 0;border-top:1px solid #e3e8ea;vertical-align:top;width:84px">${photo ? `<img src="${escapeHtml(photo)}" width="72" height="72" alt="" style="display:block;border-radius:14px;background:#fdf1cf;object-fit:contain">` : ''}</td>
          <td style="padding:14px 10px;border-top:1px solid #e3e8ea;vertical-align:top">
            <div style="font-size:18px;font-weight:700;color:#1d272d">${escapeHtml(sup.name)}</div>
            <div style="font-size:14px;line-height:21px;color:#1d272d;opacity:.85;margin:4px 0 8px">${escapeHtml(item.reason || sup.summary)}</div>
            <a href="${escapeHtml(buy)}" style="display:inline-block;background:#1d272d;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:9px 16px;border-radius:12px">Buy on iHerb</a>
            &nbsp; <a href="${escapeHtml(`${origin}/supplement/${sup.slug}`)}" style="font-size:14px;color:#1d272d">Full profile</a>
          </td>
        </tr>`;
    })
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f6f7;font-family:Helvetica,Arial,sans-serif;color:#1d272d">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border-radius:24px;padding:28px 24px">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.6">Wellness Whizz</div>
      <h1 style="font-size:26px;line-height:32px;margin:8px 0 6px">Your personal supplement list</h1>
      <p style="font-size:15px;line-height:23px;margin:0 0 16px">Here are the supplements the advisor picked for your answers, with a link to buy each one on iHerb. Your full results page, with safety notes and studies, stays at <a href="${escapeHtml(resultUrl)}" style="color:#1d272d">${escapeHtml(resultUrl)}</a>.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">${rows}
      </table>
      <p style="margin:22px 0 0"><a href="${escapeHtml(resultUrl)}" style="display:inline-block;background:#87d581;color:#1d272d;text-decoration:none;font-weight:700;font-size:16px;padding:14px 24px;border-radius:16px">Open my results</a></p>
    </div>
    <p style="font-size:12px;line-height:18px;opacity:.6;padding:16px 8px 0">This is information, not medical advice; talk to a doctor or pharmacist before starting a supplement. As an iHerb affiliate, Wellness Whizz earns from qualifying purchases at no extra cost to you. You received this email because you asked for your results on the site.</p>
  </div></body></html>`;
  const text = [
    'Your personal supplement list from Wellness Whizz',
    '',
    ...items.map((i) => `- ${i.supplement.name}: ${i.reason || i.supplement.summary}\n  Buy on iHerb: ${shopUrl(env, i.supplement, primaryProduct(i.supplement))}`),
    '',
    `Full results: ${resultUrl}`,
    '',
    'This is information, not medical advice. As an iHerb affiliate, Wellness Whizz earns from qualifying purchases at no extra cost to you.',
  ].join('\n');
  return { subject: `Your supplement list: ${items.map((i) => i.supplement.name).slice(0, 3).join(', ')}`, html, text };
}
