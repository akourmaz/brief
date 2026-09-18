import { renderText, countAnswered, ALL_QS } from '../lib/questions.js';

const TG = 'https://api.telegram.org/bot';
const MAX_MESSAGE = 3800; // запас к лимиту Telegram в 4096 символов

function chunk(text, size) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    // режем по последнему переводу строки, чтобы не рвать ответ посередине
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

async function tg(token, method, body) {
  const res = await fetch(`${TG}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data;
}

async function tgDocument(token, chatId, filename, content, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'application/json' }), filename);
  const res = await fetch(`${TG}${token}/sendDocument`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`sendDocument: ${data.description || res.status}`);
  return data;
}

function slug(s) {
  return (s || 'brief').trim().replace(/[^\wа-яА-ЯёЁ-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'brief';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы в переменных окружения');
    return res.status(500).json({ error: 'not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); }
  }
  if (!body || typeof body !== 'object' || typeof body.answers !== 'object' || !body.answers) {
    return res.status(400).json({ error: 'bad_payload' });
  }

  // берём только известные вопросы и обрезаем длину — защита от мусора в открытом эндпоинте
  const answers = {};
  for (const q of ALL_QS) {
    const a = body.answers[q.id];
    if (!a || typeof a !== 'object') continue;
    const chosen = Array.isArray(a.c) ? a.c.filter(v => typeof v === 'string').slice(0, 20).map(v => v.slice(0, 200)) : [];
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
  const text = renderText(clean);

  try {
    const head = [
      '📋 Пришёл заполненный бриф — этап 1',
      '',
      `Заполнил: ${clean.who || 'не указано'}`,
      `Связь: ${clean.contact || 'не указана'}`,
      `Отвечено: ${answered} из ${ALL_QS.length}`,
    ].join('\n');
    await tg(token, 'sendMessage', { chat_id: chatId, text: head, disable_web_page_preview: true });

    for (const part of chunk(text, MAX_MESSAGE)) {
      await tg(token, 'sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true });
    }

    await tgDocument(
      token,
      chatId,
      `brief-${slug(clean.who)}-${receivedAt.slice(0, 10)}.json`,
      JSON.stringify(record, null, 2),
      'Файл для обработки',
    );
  } catch (e) {
    console.error('Не удалось доставить бриф в Telegram:', e.message);
    // ответы уже потеряны для нас — логируем целиком, чтобы достать из логов Vercel
    console.error('PAYLOAD', JSON.stringify(record));
    return res.status(502).json({ error: 'delivery_failed' });
  }

  return res.status(200).json({ ok: true, answered });
}
