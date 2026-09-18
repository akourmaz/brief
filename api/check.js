// ВРЕМЕННЫЙ диагностический эндпоинт. Показывает, что GitHub отвечает нашему токену.
// Удалить, как только запись в answers/ заработает.

const GH = 'https://api.github.com';

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || process.env.VERCEL_GIT_REPO_OWNER;
  const repo = process.env.GITHUB_REPO || process.env.VERCEL_GIT_REPO_SLUG;

  const out = { repo: `${owner || '?'}/${repo || '?'}` };

  if (!token) return res.status(200).json({ ...out, tokenPresent: false });

  // по префиксу видно тип токена: github_pat_ — fine-grained, ghp_ — классический
  out.tokenPresent = true;
  out.tokenKind = token.startsWith('github_pat_') ? 'fine-grained'
    : token.startsWith('ghp_') ? 'classic'
    : 'unknown';
  out.tokenLength = token.length;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'brief-inbox',
  };

  try {
    const who = await fetch(`${GH}/user`, { headers });
    out.userStatus = who.status;
    if (who.ok) out.user = (await who.json()).login;

    const r = await fetch(`${GH}/repos/${owner}/${repo}`, { headers });
    out.repoStatus = r.status;
    if (r.ok) {
      const d = await r.json();
      out.repoPrivate = d.private;
      out.permissions = d.permissions; // здесь push: true означает право записи
    } else {
      out.repoMessage = (await r.json().catch(() => ({}))).message;
    }

    // настоящая проверка: пробуем записать файл
    const probe = await fetch(`${GH}/repos/${owner}/${repo}/contents/answers/_check.md`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Диагностика доступа [skip ci]',
        content: Buffer.from('Временный файл проверки доступа.\n', 'utf8').toString('base64'),
        branch: process.env.GITHUB_BRANCH || 'main',
      }),
    });
    out.writeStatus = probe.status;
    const pd = await probe.json().catch(() => ({}));
    out.writeMessage = pd.message || 'ок, файл записан';
  } catch (e) {
    out.error = e.message;
  }

  return res.status(200).json(out);
}
