import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectDirectory = fileURLToPath(new URL('.', import.meta.url));
const mediaOptions = ['ブログ', 'note', 'X', 'Instagram', 'YouTube'];
const fields = [
  ['theme', 'コンテンツのテーマ', 200],
  ['audience', 'ターゲット読者', 500],
  ['medium', '媒体', 30],
  ['purpose', '目的', 1000],
  ['notes', 'メモ', 5000],
];

// 入力文字をHTMLとして実行させず、安全なテキストとして表示します。
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function page(title, content) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Yoshio AI Business</title>
<link rel="stylesheet" href="/style.css"></head>
<body><header><a class="brand" href="/">Yoshio AI Business</a>
<span class="badge">ローカル企画ノート</span></header>
<main>${content}</main>
<footer>このMacに企画を保存します。外部AIへの送信・自動投稿は行いません。</footer></body></html>`;
}

function formPage(plans, values = {}, error = '') {
  const inputs = fields.map(([key, label, limit]) => {
    const required = key === 'theme' || key === 'medium';
    let input;
    if (key === 'medium') {
      input = `<select id="${key}" name="${key}" required>${mediaOptions.map(option =>
        `<option${values[key] === option ? ' selected' : ''}>${option}</option>`).join('')}</select>`;
    } else if (key === 'purpose' || key === 'notes') {
      input = `<textarea id="${key}" name="${key}" maxlength="${limit}" rows="${key === 'notes' ? 5 : 3}">${escapeHtml(values[key])}</textarea>`;
    } else {
      input = `<input id="${key}" name="${key}" maxlength="${limit}" value="${escapeHtml(values[key])}" ${required ? 'required' : ''}>`;
    }
    return `<div class="field"><label for="${key}">${label} <span class="hint">${required ? '必須' : '任意'}</span></label>${input}</div>`;
  }).join('');

  return page('企画を作成', `<section class="intro"><p class="eyebrow">アイデアを、次の一歩へ。</p>
<h1>コンテンツの企画を作る</h1><p>テーマと届けたい相手を整理して、制作の準備を始めましょう。</p></section>
<div class="layout"><section class="card"><h2>新しい企画</h2>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/plans">${inputs}<button type="submit">企画を作成</button>
<p class="hint">入力内容を整理して保存します。AIによる文章生成はまだ行いません。</p></form></section>
<section class="card saved"><h2>保存した企画 <span class="count">${plans.length}</span></h2>
${plans.length ? `<ul class="plan-list">${plans.map(plan => `<li><a href="/plans/${plan.id}">${escapeHtml(plan.theme)}</a><p class="hint">${escapeHtml(plan.medium)} · ${formatDate(plan.createdAt)}</p></li>`).join('')}</ul>` : '<p class="muted">まだ企画はありません。<br>最初のアイデアを保存してみましょう。</p>'}</section></div>`);
}

function formatDate(value) {
  return escapeHtml(new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
}

function detailPage(plan) {
  return page(plan.theme, `<a class="back" href="/">← 企画一覧・新規作成へ</a>
<article class="card detail"><p class="eyebrow">保存済みの企画</p><h1>${escapeHtml(plan.theme)}</h1>
<p class="hint">作成日時：${formatDate(plan.createdAt)}（日本時間）</p>
<dl>${fields.map(([key, label]) => `<div><dt>${label}</dt><dd>${escapeHtml(plan[key] || '未入力')}</dd></div>`).join('')}</dl>
<p class="notice">この企画をもとに、記事の構成やSNS投稿案を考えていきましょう。</p></article>`);
}

function requestError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// テスト時は一時フォルダを渡し、実際の企画データから分離できます。
export function createApp({ dataDirectory = path.join(projectDirectory, 'data') } = {}) {
  async function listPlans() {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const names = await readdir(dataDirectory);
    const plans = await Promise.all(names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
      .map(async name => JSON.parse(await readFile(path.join(dataDirectory, name), 'utf8'))));
    return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return http.createServer(async (request, response) => {
    function send(status, body, type = 'text/html; charset=utf-8') {
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        // 同じアプリへのPOSTではOriginを保持します。no-referrerだと
        // ブラウザがOrigin: nullを送り、下の送信元チェックで拒否されます。
        'Referrer-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    }

    try {
      // localhost以外のホスト名や、他のサイトからの保存要求を受け付けません。
      const host = request.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
        throw requestError('このアプリはlocalhostから開いてください。', 403);
      }
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/style.css') {
        return send(200, await readFile(path.join(projectDirectory, 'public/style.css')), 'text/css; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/') {
        return send(200, formPage(await listPlans()));
      }
      if (request.method === 'POST' && url.pathname === '/plans') {
        if ((request.headers.origin && request.headers.origin !== `http://${host}`)
          || request.headers['sec-fetch-site'] === 'cross-site') {
          throw requestError('このアプリの入力画面から保存してください。', 403);
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
          throw requestError('フォーム形式で送信してください。', 415);
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 100_000) throw requestError('入力が大きすぎます。文字数を減らしてください。', 413);
          chunks.push(chunk);
        }
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const values = Object.fromEntries(fields.map(([key]) => [key, (form.get(key) || '').trim()]));
        let error = '';
        if (!values.theme) error = 'コンテンツのテーマを入力してください。';
        else if (!mediaOptions.includes(values.medium)) error = '媒体を選択肢から選んでください。';
        else if (fields.some(([key, , limit]) => values[key].length > limit)) error = '入力の文字数が上限を超えています。短くして再度保存してください。';
        if (error) return send(400, formPage(await listPlans(), values, error));

        const plan = { id: randomUUID(), createdAt: new Date().toISOString(), ...values };
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        const destination = path.join(dataDirectory, `${plan.id}.json`);
        // 書き込みが完了してから正式名に変更し、不完全なファイルを一覧に出しません。
        await writeFile(`${destination}.tmp`, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
        await rename(`${destination}.tmp`, destination);
        response.writeHead(303, { Location: `/plans/${plan.id}` });
        return response.end();
      }
      const match = url.pathname.match(/^\/plans\/([a-f0-9-]{36})$/);
      if (request.method === 'GET' && match) {
        let contents;
        try {
          contents = await readFile(path.join(dataDirectory, `${match[1]}.json`), 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') throw requestError('企画が見つかりません。', 404);
          throw error;
        }
        return send(200, detailPage(JSON.parse(contents)));
      }
      throw requestError('ページが見つかりません。', 404);
    } catch (error) {
      if (!error.status) console.error('処理に失敗しました:', error.code || error.name);
      send(error.status || 500, page('エラー', `<section class="card"><h1>処理を完了できませんでした</h1>
<p>${escapeHtml(error.status ? error.message : '保存データの読み書きに失敗しました。ターミナルとdataフォルダを確認してください。')}</p><a href="/">入力画面へ戻る</a></section>`));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApp();
  // 他の端末からアクセスできないよう、このMacのループバックだけで待ち受けます。
  server.listen(3000, '127.0.0.1', () => {
    console.log('Yoshio AI Business を起動しました。http://127.0.0.1:3000 をブラウザで開いてください。');
    console.log('終了するには Control + C を押してください。');
  });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? 'ポート3000が使用中です。先に起動したアプリをControl + Cで終了してください。'
      : `起動できませんでした: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
