/** The submission kit: the copy and assets to paste into directories and profiles (/api/admin/backlinks/kit). */
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));

export function renderBacklinksKit(origin: string): string {
  const fields: [string, string][] = [
    ['Name', 'Wellness Whizz'],
    ['URL', `${origin}/`],
    ['Tagline (60)', 'Free AI supplement quiz with the evidence behind every pick'],
    ['Short description (160)', 'A free two-minute quiz turns your goals, diet and lifestyle into a short supplement list with plain-English reasons, dosing and the studies behind each one.'],
    ['Description (400)', 'Wellness Whizz is a free, independent AI supplement guide. Answer a two-minute quiz about your goals, diet, sleep and training and get a short list of supplements with the reason for each, the dose the studies used, and what to watch out for. The site also has 150 evidence-based supplement pages, dosage guides, a protein calculator, a photo scanner for your supplement shelf, and a Spanish version. No accounts, no paywall; funded by disclosed affiliate links.'],
    ['Long description (1000)', 'Most supplement advice online is either a sales page or a wall of studies. Wellness Whizz sits in between: an AI advisor that reads your answers (goals, diet, sleep, stress, training, medication caveats) and recommends a focused stack of three to five supplements, each with the reason it was picked, the dose used in trials, timing, and safety notes. Every supplement page links to the studies it cites. Tools: the quiz, a protein intake calculator, a shelf scanner that reads a photo of what you already take and flags overlaps and gaps, dosage guides for the most searched supplements, and a quarterly report on what quiz-takers actually take. The whole site is also available in Spanish at aiww.io/es/. It is free, has no accounts, and is funded by disclosed affiliate links; the recommendations do not change with the commission.'],
    ['Categories / tags', 'health, nutrition, supplements, fitness, AI tool, wellness, quiz, calculator'],
    ['Pricing', 'Free'],
    ['Founder', 'Anton'],
    ['Contact email', 'hello@aiww.io'],
    ['Alternatives to', 'Examine.com, Cronometer, Care/of quiz, Hims quiz'],
    ['Twitter / X', 'https://x.com/aiwwio (adjust to the real handle)'],
    ['TikTok', 'https://www.tiktok.com/@theaiwellnesswhiz'],
    ['Logo (square)', `${origin}/images/logo-512.png`],
    ['Screenshots', `${origin}/ (home), ${origin}/wellness-quiz (quiz), ${origin}/supplement/creatine (a supplement page), ${origin}/shelf (scanner)`],
    ['Show HN title', 'Show HN: Wellness Whizz, a free AI supplement quiz that cites its sources'],
    ['Product Hunt tagline', 'The free AI supplement quiz that shows its sources'],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Submission kit · Wellness Whizz</title>
<style>body{margin:0;padding:20px 14px 60px;background:#fdf1cf;color:#1d272d;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.45}main{max-width:720px;margin:0 auto}h1{font-size:24px}.f{background:#fff;border-radius:12px;padding:10px 14px;margin:10px 0}.f b{display:block;font-size:13px;color:#6b7478;margin-bottom:4px}.f div{white-space:pre-wrap}button{border:0;border-radius:999px;background:#e6dfc9;padding:4px 10px;font:inherit;font-size:13px;cursor:pointer;float:right}</style></head>
<body><main><h1>Submission kit</h1><p>Tap Copy, paste into the directory form. Use the same wording everywhere; the descriptions are already within the usual limits.</p>
${fields.map(([k, v]) => `<div class="f"><button onclick="navigator.clipboard.writeText(this.nextElementSibling.nextElementSibling.textContent)">Copy</button><b>${esc(k)}</b><div>${esc(v)}</div></div>`).join('')}
</main></body></html>`;
}
