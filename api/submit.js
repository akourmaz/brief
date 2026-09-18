import { renderText, countAnswered, ALL_QS } from '../lib/questions.js';

const GH = 'https://api.github.com';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'brief-inbox',
    'Content-Type': 'application/json',
  };
}

/** Латиница/цифры для имени файла: кириллица транслитерируется, остальное режется. */
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
function slug(s) {
  const out = (s || '').toLowerCase().split('').map(ch => (ch in TRANSLIT ? TRANSLIT[ch] : ch)).join('');
  return out.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'brief';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || process.env.VERCEL_GIT_REPO_OWNER;
  const repo = process.env.GITHUB_REPO || process.env.VERCEL_GIT_REPO_SLUG;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const dir = process.env.ANSWERS_DIR || 'answers';

  if (!token || !owner || !repo) {
    console.error('Не задан GITHUB_TOKEN или не определился репозиторий (GITHUB_OWNER / GITHUB_REPO)');
    return res.status(500).json({ error: 'not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); }
  }
  if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object') {
    return res.status(400).json({ error: 'bad_payload' });
  }

  // берём только известные вопросы и режем длину — эндпоинт открыт всему интернету
  const answers = {};
  for (const q of ALL_QS) {
    const a = body.answers[q.id];
    if (!a || typeof a !== 'object') continue;
    const chosen = Array.isArray(a.c)
      ? a.c.filter(v => typeof v === 'string').slice(0, 20).map(v => v.slice(0, 200))
      : [];
    const text = typeof a.t === 'string' ? a.t.slice(0, 4000) : '';
    if (chosen.length || text.trim()) answers[q.id] = { c: chosen, t: text };
  }

  const answered = countAnswered(answers);
  if (answered === 0) return res.status(400).json({ error: 'empty' });

  const clean = {
    who: String(body.who || '').slice(0, 200),
    contact: String(body.contact || '').slice(0, 200),
    answers,
  };
  const receivedAt = new Date().toISOString();
  const record = { ...clean, answeredCount: answered, total: ALL_QS.length, receivedAt };

  try {
    const stamp = receivedAt.slice(0, 16).replace(/[:T]/g, '-'); // 2026-09-18-15-30
    const path = `${dir}/${stamp}-${slug(clean.who)}.md`;
    const content = [
      renderText(clean),
      '',
      '---',
      '',
      'Структурированные ответы:',
      '',
      '```json',
      JSON.stringify(record, null, 2),
      '```',
      '',
    ].join('\n');

    // [skip ci] — чтобы каждый присланный бриф не запускал пересборку на Vercel
    const put = await fetch(`${GH}/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
      method: 'PUT',
      headers: ghHeaders(token),
      body: JSON.stringify({
        message: `Бриф: ${clean.who || 'без имени'} (${answered}/${ALL_QS.length}) [skip ci]`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
      }),
    });
    if (!put.ok) {
      const detail = await put.text();
      throw new Error(`contents PUT: HTTP ${put.status} ${detail.slice(0, 200)}`);
    }

    return res.status(200).json({ ok: true, answered });
  } catch (e) {
    console.error('Не удалось сохранить бриф в репозиторий:', e.message);
    // ответы иначе потеряны — дублируем в логи, откуда их можно достать вручную
    console.error('PAYLOAD', JSON.stringify(record));
    return res.status(502).json({ error: 'save_failed' });
  }
}
