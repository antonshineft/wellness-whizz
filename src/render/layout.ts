import { escapeHtml } from '../html';
import { WF_SITE_ID } from './partials';

export interface PageOptions {
  title: string;
  description?: string;
  pageId: string;
  bodyClass?: string;
  head?: string;
  body: string;
  scripts?: string;
}

const DEFAULT_DESCRIPTION =
  'Explore personalized wellness with Wellness Whizz. Our AI-driven platform provides custom supplement recommendations for your unique health journey.';

/** Full HTML document with the same head, stylesheets, fonts and scripts as the Webflow export. */
export function page(opts: PageOptions): string {
  // The brand suffix is added only while the whole title stays within 60 characters (search engines truncate longer ones).
  const title = escapeHtml(/wellness whizz/i.test(opts.title) || opts.title.length > 43 ? opts.title : `${opts.title} | Wellness Whizz`);
  const description = escapeHtml(opts.description ?? DEFAULT_DESCRIPTION);
  const bodyClass = opts.bodyClass ? ` class="${opts.bodyClass}"` : '';
  return `<!DOCTYPE html>
<html data-wf-page="${opts.pageId}" data-wf-site="${WF_SITE_ID}" lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta content="${description}" name="description">
  <meta content="${title}" property="og:title">
  <meta content="${description}" property="og:description">
  <meta content="${title}" name="twitter:title">
  <meta content="${description}" name="twitter:description">
  <meta property="og:type" content="website">
  <meta content="summary_large_image" name="twitter:card">
  <meta content="@aiwwio" name="twitter:site">
  <meta content="width=device-width, initial-scale=1" name="viewport">
  <meta content="D5839stdLcyZohbV8RR60XC4AdkQRaxR8669m8NgTWA" name="google-site-verification">
  <link href="/css/normalize.css" rel="stylesheet" type="text/css">
  <link href="/css/webflow.css" rel="stylesheet" type="text/css">
  <link href="/css/antons-dapper-site-d606bb.webflow.css" rel="stylesheet" type="text/css">
  <link href="/css/wellness-extras.css" rel="stylesheet" type="text/css">
  <script type="text/javascript">!function(o,c){var n=c.documentElement,t=" w-mod-";n.className+=t+"js",("ontouchstart"in o||o.DocumentTouch&&c instanceof DocumentTouch)&&(n.className+=t+"touch")}(window,document);</script>
  <link href="/images/favicon.png" rel="shortcut icon" type="image/x-icon">
  <link href="/images/webclip.png" rel="apple-touch-icon">
  <script async src="https://www.googletagmanager.com/gtag/js?id=AW-11471478571"></script>
  <script>window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}gtag('js', new Date());gtag('config', 'AW-11471478571');</script>
${opts.head ?? ''}
</head>
<body${bodyClass}>
${opts.body}
  <script src="/js/jquery-3.5.1.min.js" type="text/javascript"></script>
  <script src="/js/webflow.js" type="text/javascript"></script>
  <script src="/js/site.js"></script>
${opts.scripts ?? ''}
</body>
</html>`;
}
