import { createExecutionGate } from './lib/offer-import/execution-gate.js';
import { createBudgetCoordinator } from './lib/ai/budget-coordinator.js';
import { budgetPage, parseBudgetActivation, parseRealApproval, realApprovalPreview } from './lib/ai/budget-pages.js';
import { createExecutionStore } from './lib/offer-import/execution-store.js';
import { createGenerationService } from './lib/ai/generation-service.js';
import { createOpenAIProvider } from './lib/ai/openai-provider.js';
import { createOpenAIExtractionProvider } from './lib/ai/openai-extraction-provider.js';
import { createExtractionService } from './lib/offer-import/extraction-service.js';
import { extractionPages, parseExtractionForm, parseExtractionApproval } from './lib/offer-import/extraction-pages.js';
import { openaiConfig } from './lib/ai/config.js';
import { generationPages } from './lib/generation-pages.js';
import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildPrompt, contentFields, parseImport, validateContent } from './lib/content.js';
import { createDraftStore } from './lib/drafts.js';
import { createImprovementStore, readImprovementSettings, readImprovementFields, validateImprovementWork, parseImprovementResult, hasAffiliateProvenance } from './lib/improvements.js';
import { publishPage } from './lib/publish-page.js';
import { draftPages } from './lib/draft-pages.js';
import { createOfferStore } from './lib/offers/store.js';
import { parseOfferForm } from './lib/offers/form.js';
import { offerPages } from './lib/offer-pages.js';
import { activeFindings } from './lib/offers/ui-guidance.js';
import { createOfferImportStore } from './lib/offer-import/store.js';
import { offerImportPages, parseReviewForm } from './lib/offer-import/ui.js';
import { createMaintenanceService } from './lib/maintenance/backup.js';
import { maintenancePages, parseMaintenanceForm } from './lib/maintenance/pages.js';
import { createReflectionService } from './lib/offer-import/reflection-service.js';
import { reflectionPages, reflectionOptions, parseReflectionApproval } from './lib/offer-import/reflection-pages.js';
import { reflectionHash } from './lib/offer-import/projection.js';

import { bindingFields, resolvePlanOffer, planOfferViews } from './lib/plan-offer.js';

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
<link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
<body><header><a class="brand" href="/">Yoshio AI Business</a>
<span class="badge">ローカル企画ノート</span><a href="/offers">案件管理</a><a href="/offer-imports">候補レビュー</a><a href="/maintenance">データ保全管理</a></header>
<main>${content}</main>
<footer>このMacに企画を保存します。OpenAI直接生成は確認後に企画情報を送信します。自動投稿は行いません。</footer></body></html>`;
}

function formPage(plans, values = {}, error = '', offers = []) {
  const editing = Boolean(values.id);
  const binding = values.offerBinding;
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

  return page(editing ? '企画を編集' : '企画を作成', `<section class="intro"><p class="eyebrow">アイデアを、次の一歩へ。</p>
<h1>${editing ? 'コンテンツの企画を編集' : 'コンテンツの企画を作る'}</h1><p>テーマと届けたい相手を整理して、制作の準備を始めましょう。</p></section>
<div class="layout"><section class="card"><h2>${editing ? '企画を編集' : '新しい企画'}</h2>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${editing ? `/plans/${values.id}/edit` : '/plans'}" data-plan-form>${editing ? `<input type="hidden" name="planRevision" value="${escapeHtml(values.revision || 1)}">` : ''}${inputs}${bindingViews.form(offers, binding)}${binding ? bindingViews.detail(binding, offers.find(offer => offer.id === binding.offerId)) : ''}<button type="submit">${editing ? '企画を保存' : '企画を作成'}</button>
<p class="hint">入力内容を整理して保存します。保存後、Codexへの依頼文を作成できます。</p></form></section>
<section class="card saved"><h2>保存した企画 <span class="count">${plans.length}</span></h2>
${plans.length ? `<ul class="plan-list">${plans.map(plan => `<li><a href="/plans/${plan.id}">${escapeHtml(plan.theme)}</a><p class="hint">${escapeHtml(plan.medium)} · ${formatDate(plan.createdAt)}</p></li>`).join('')}</ul>` : '<p class="muted">まだ企画はありません。<br>最初のアイデアを保存してみましょう。</p>'}</section></div>`);
}

function formatDate(value) {
  return escapeHtml(new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
}

const bindingViews = planOfferViews(escapeHtml);
const generationViews = generationPages(escapeHtml);
const offerViews = offerPages(escapeHtml);
const { workflow, editor, importPreview, improvementPage } = draftPages({ escapeHtml, formatDate });

function detailPage(plan, drafts = [], raw = '', error = '', currentOffer = null) {
  return page(plan.theme, `<a class="back" href="/">← 企画一覧・新規作成へ</a>
<article class="card detail"><p class="eyebrow">保存済みの企画</p><h1>${escapeHtml(plan.theme)}</h1>
<a href="/plans/${plan.id}/edit">企画を編集</a><p class="hint">作成日時：${formatDate(plan.createdAt)}（日本時間）</p>
<dl>${fields.map(([key, label]) => `<div><dt>${label}</dt><dd>${escapeHtml(plan[key] || '未入力')}</dd></div>`).join('')}</dl>
${bindingViews.detail(plan.offerBinding, currentOffer)}<p class="notice">この企画をもとに、記事の構成やSNS投稿案を考えていきましょう。</p></article><section class="card detail workflow"><h2>AIで直接下書きを生成</h2><p>生成前確認で送信内容・使用設定・概算を確認できます。</p><a data-direct-generation href="/plans/${plan.id}/generate">AIで下書きを生成</a></section>${workflow(plan, drafts, raw, error)}`);
}

function requestError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// テスト時は一時フォルダを渡し、実際の企画データから分離できます。
export function createApp({ dataDirectory = path.join(projectDirectory, 'data'), generationOptions = {}, offerImportOptions = {}, maintenanceOptions = {}, extractionOptions = {} } = {}) {
  const importStore = offerImportOptions.store || createOfferImportStore(dataDirectory);
  const importViews = offerImportPages(escapeHtml);
  const offerStore = createOfferStore(dataDirectory);
  const reflection = offerImportOptions.reflection || createReflectionService({ dataDirectory, importStore, offerStore });
  const reflectionViews = reflectionPages(escapeHtml);
  const maintenance = createMaintenanceService(dataDirectory, maintenanceOptions);
  const maintenanceViews = maintenancePages(escapeHtml);
  const budget = createBudgetCoordinator(dataDirectory, { now: generationOptions.now || (() => new Date()) });
  const extractionExecutions = createExecutionStore(dataDirectory);
  const extraction = createExtractionService({ now: generationOptions.now, ...extractionOptions, dataDirectory,
    provider: extractionOptions.provider || createOpenAIExtractionProvider(), store: extractionExecutions, importStore, offerStore, coordinator: budget });
  const extractionViews = extractionPages(escapeHtml);
  const importExecutionReady = createExecutionGate(dataDirectory, extractionExecutions);
  const draftStore = createDraftStore(dataDirectory, { offerStore });
  const improvementStore = createImprovementStore(dataDirectory);
  const generation = createGenerationService({ ...generationOptions, dataDirectory, draftStore, loadPlan: readPlan });
  async function readPlan(id) {
    try { return JSON.parse(await readFile(path.join(dataDirectory, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw requestError('企画が見つかりません。', 404); throw error; }
  }
  async function currentOffer(plan) {
    if (!plan.offerBinding) return null;
    try { return await offerStore.get(plan.offerBinding.offerId); }
    catch (error) { if ([400, 404, 503].includes(error.status)) return null; throw error; }
  }
  async function readForm(request, host, limit = 100_000) {
    if ((request.headers.origin && request.headers.origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') throw requestError('このアプリの入力画面から保存してください。', 403);
    if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw requestError('フォーム形式で送信してください。', 415);
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > limit) throw requestError('入力が大きすぎます。文字数を減らしてください。', 413); chunks.push(chunk); }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }
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
        'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
      if (request.method === 'GET' && url.pathname === '/offer-extraction.js') return send(200, await readFile(path.join(projectDirectory, 'public/offer-extraction.js')), 'text/javascript; charset=utf-8');
      if (url.pathname === '/offer-extractions' || url.pathname.startsWith('/offer-extractions/')) {
        try {
          if (request.method === 'GET' && url.pathname === '/offer-extractions/new') {
            if ([...url.searchParams.keys()].some(k => k !== 'offerId') || url.searchParams.getAll('offerId').length > 1) throw requestError('対象指定が不正です。', 400);
            const offers = await offerStore.list();
            const offer = url.searchParams.has('offerId') ? await offerStore.get(url.searchParams.get('offerId')) : offers[0] || null;
            return send(200, page('資料から登録候補を作る', extractionViews.intake(offers, offer)).replace('</head>', '<script src="/offer-extraction.js" defer></script></head>'));
          }
          if (url.search) throw requestError('対象指定が不正です。', 400);
          if (request.method === 'GET' && url.pathname === '/offer-extractions') return send(200, page('抽出実行記録', extractionViews.list((await extractionExecutions.read()).executions.map(e => e.revisions.at(-1)))));
          if (request.method === 'POST' && url.pathname === '/offer-extractions/prepare') {
            if (request.headers.origin !== `http://${host}`) throw requestError('送信元が不正です。', 403);
            const value = parseExtractionForm(await readForm(request, host, 2 * 1024 * 1024));
            const r = await extraction.prepare(value);
            response.writeHead(303, { Location: `/offer-extractions/${r.id}`, 'Cache-Control': 'no-store' }); return response.end();
          }
          const match = url.pathname.match(/^\/offer-extractions\/([a-f0-9-]{36})(?:\/(approve))?$/);
          if (!match) throw requestError('実行記録が見つかりません。', 404);
          if (request.method === 'GET' && !match[2]) return send(200, page('抽出送信前確認', extractionViews.detail(await extraction.preview(match[1]))));
          if (request.method !== 'POST' || match[2] !== 'approve') throw requestError('操作が見つかりません。', 404);
          if (request.headers.origin !== `http://${host}`) throw requestError('送信元が不正です。', 403);
          const token = parseExtractionApproval(await readForm(request, host, 6000));
          await extraction.approveAndExecute(match[1], token, { confirm: true });
          response.writeHead(303, { Location: `/offer-extractions/${match[1]}`, 'Cache-Control': 'no-store' }); return response.end();
        } catch (error) {
          const status = [400,403,404,409,413,415,503].includes(error.status) ? error.status : 503;
          return send(status, page('抽出停止', extractionViews.failure()));
        }
      }
      if (url.pathname === '/maintenance' || url.pathname.startsWith('/maintenance/')) {
        try {
          if (url.search) return send(400, page('管理操作を停止', maintenanceViews.failure()));
          if (request.method === 'GET' && url.pathname === '/maintenance/ai-budget') {
            let activation = null; let executions = [];
            let state = null;
            try { activation = await budget.activation(); } catch { /* fixed stop message, no raw error */ }
            if (activation) try { state = await budget.state(); } catch { /* fail closed, no enable form */ }
            try { executions = (await extractionExecutions.read()).executions.map(e => e.revisions.at(-1)); } catch { /* integrity explains failure */ }
            return send(200, page('共通AI予算', budgetPage(escapeHtml, activation, executions, state)));
          }
          if (request.method === 'POST' && ['/maintenance/ai-budget/real-preview', '/maintenance/ai-budget/enable-real'].includes(url.pathname)) {
            if (request.headers.origin !== `http://${host}`) throw requestError('送信元が不正です。', 403);
            const final = url.pathname.endsWith('/enable-real');
            const parsed = parseRealApproval(await readForm(request, host, 4000), final);
            if (!final) return send(200, page('共通real枠の最終確認', realApprovalPreview(escapeHtml, await budget.previewRealApproval(parsed))));
            await budget.enableReal(parsed, { confirm: true });
            response.writeHead(303, { Location: '/maintenance/ai-budget', 'Cache-Control': 'no-store' }); return response.end();
          }
          if (request.method === 'POST' && url.pathname === '/maintenance/ai-budget/activate') {
            if (request.headers.origin !== `http://${host}`) throw requestError('送信元が不正です。', 403);
            const policy = parseBudgetActivation(await readForm(request, host, 2000));
            const activation = await budget.activate(policy, { confirm: true, expectedRevision: 0 });
            return send(200, page('共通AI予算', budgetPage(escapeHtml, activation)));
          }
          if (request.method === 'GET' && url.pathname === '/maintenance') return send(200, page('データ保全管理', maintenanceViews.home(await maintenance.list())));
          if (request.method === 'GET' && url.pathname === '/maintenance/integrity') return send(200, page('整合性確認', maintenanceViews.integrity(await maintenance.integrity())));
          if (request.method === 'POST' && ['/maintenance/backups', '/maintenance/dry-run'].includes(url.pathname)) {
            if (request.headers.origin !== `http://${host}`) throw requestError('このアプリの入力画面から操作してください。', 403);
            const operation = url.pathname.endsWith('/backups') ? 'backup' : 'dry-run';
            const backupId = parseMaintenanceForm(await readForm(request, host, 2000), operation);
            return operation === 'backup' ? send(200, page('バックアップ作成', maintenanceViews.created(await maintenance.create())))
              : send(200, page('復元dry-run', maintenanceViews.dryRun(await maintenance.dryRun(backupId))));
          }
          // No restore route, including explicit approval or repeated POST attempts.
          return send(404, page('管理操作を停止', maintenanceViews.failure()));
        } catch (error) { return send([400, 403, 409, 413, 415].includes(error.status) ? error.status : 503, page('管理操作を停止', maintenanceViews.failure())); }
      }
      if (request.method === 'GET' && url.pathname === '/offer-import.js') return send(200, await readFile(path.join(projectDirectory, 'public/offer-import.js')), 'text/javascript; charset=utf-8');
      if (url.pathname === '/offer-imports' || url.pathname.startsWith('/offer-imports/')) {
        const reflectMatch = url.pathname.match(/^\/offer-imports\/([a-f0-9-]{36})\/(reflection|commit|commits|recover)$/);
        if (reflectMatch) {
          const [, id, action] = reflectMatch;
          try {
            if (request.method === 'GET' && action === 'reflection') {
              const draft = await importStore.get(id);
              const options = reflectionOptions(url.searchParams, draft);
              const selection = reflectionViews.selection(draft, await offerStore.list(), options);
              const prepared = options ? await reflection.preview(id, options) : null;
              return send(200, page('反映プレビュー', selection + (prepared ? reflectionViews.preview(draft, { ...prepared, hash: reflectionHash(prepared.plan) }) : '')));
            }
            if (request.method === 'GET' && action === 'commits') return send(200, page('反映記録', reflectionViews.records(id, await reflection.records(id))));
            if (request.method !== 'POST' || !['commit', 'recover'].includes(action)) throw requestError('操作が見つかりません。', 404);
            if (request.headers.origin !== `http://${host}`) throw requestError('送信元が不正です。', 403);
            const token = parseReflectionApproval(await readForm(request, host, 30_000));
            // Tokens bind the import; never allow a token from another route to authorize this import.
            const data = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
            if (data.importId !== id) throw requestError('確認対象が異なります。', 400);
            await reflection[action](token, { approve: true });
            response.writeHead(303, { Location: `/offer-imports/${id}/commits` }); return response.end();
          } catch (error) {
            const status = [400, 403, 404, 409, 413, 415, 503].includes(error.status) ? error.status : 503;
            return send(status, page('反映停止', importViews.failure(status, id) + `<p><a href="/offer-imports/${id}/commits">反映記録と復旧確認を開く</a></p><p><a href="/offer-imports/${id}/reflection">最新版から反映プレビューを作り直す</a></p>`));
          }
        }
        const match = url.pathname.match(/^\/offer-imports\/([a-f0-9-]{36})(?:\/revisions\/([1-9]\d*)|\/candidates\/(candidate-[1-9]\d*)\/(review|verify))?$/);
        try {
          if (request.method === 'GET' && url.pathname === '/offer-imports') return send(200, page('候補レビュー', importViews.list(await importStore.list())));
          if (!match) throw requestError('記録が見つかりません。', 404);
          if (request.method === 'GET' && !match[3]) {
            const history = await importStore.history(match[1]);
            await importExecutionReady(match[1], history[0]);
            const draft = match[2] ? history.find(d => d.revision === Number(match[2])) : history.at(-1);
            if (!draft) throw requestError('記録が見つかりません。', 404);
            return send(200, page('候補レビュー', importViews.detail(draft, history, Boolean(match[2])))
              .replace('</head>', '<script src="/offer-import.js" defer></script></head>'));
          }
          if (request.method !== 'POST' || !match[3]) throw requestError('記録が見つかりません。', 404);
          if (request.headers.origin !== `http://${host}`) throw requestError('送信元が不正です。', 403);
          const form = await readForm(request, host, 100_000);
          await importExecutionReady(match[1], (await importStore.history(match[1]))[0]);
          const draft = await importStore.get(match[1]);
          const candidate = draft.candidates.find(c => c.id === match[3]);
          if (!candidate) throw requestError('候補が見つかりません。', 404);
          const parsed = parseReviewForm(form, candidate, match[4] === 'verify');
          if (parsed.revision !== draft.revision) throw requestError('古い確認です。', 409);
          await importStore.review(match[1], candidate.id, parsed.revision, parsed.action);
          response.writeHead(303, { Location: `/offer-imports/${match[1]}` });
          return response.end();
        } catch (error) {
          const status = [400, 403, 404, 409, 413, 415, 503].includes(error.status) ? error.status : 503;
          return send(status, page('レビュー停止', importViews.failure(status, match?.[1])));
        }
      }
      if (request.method === 'GET' && url.pathname === '/offers.js') return send(200, await readFile(path.join(projectDirectory, 'public/offers.js')), 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/offer-helpers.js') return send(200, await readFile(path.join(projectDirectory, 'public/offer-helpers.js')), 'text/javascript; charset=utf-8');
      if (url.pathname === '/offers' || url.pathname.startsWith('/offers/')) {
        let offerInput;
        try {
          const match = url.pathname.match(/^\/offers\/([a-f0-9-]{36})(?:\/(edit)|\/revisions\/([1-9]\d*))?$/);
          if (request.method === 'GET') {
            if (url.pathname === '/offers') return send(200, page('案件管理', offerViews.list(await offerStore.list())));
            if (url.pathname === '/offers/new') return send(200, page('案件登録', offerViews.form()).replace('</head>', '<script type="module" src="/offers.js"></script></head>'));
            if (match) {
              const history = await offerStore.history(match[1]);
              const offer = match[3] ? history.find(item => item.revision === Number(match[3])) : history.at(-1);
              if (!offer) throw requestError('案件が見つかりません。', 404);
              return send(200, page('案件管理', match[2] ? offerViews.form(offer) : offerViews.detail(offer, history, Boolean(match[3])))
                .replace('</head>', '<script type="module" src="/offers.js"></script></head>'));
            }
          }
          if (request.method === 'POST' && (url.pathname === '/offers' || match?.[2])) {
            if (request.headers.origin !== `http://${host}`) throw requestError('送信元が不正です。', 403);
            const form = await readForm(request, host, 2_000_000);
            const parsed = parseOfferForm(form, Boolean(match));
            offerInput = parsed.input;
            if (match && parsed.id !== match[1]) throw requestError('案件IDは変更できません。');
            const saved = match ? await offerStore.update(match[1], parsed.revision, parsed.input)
              : await offerStore.create(parsed.input, parsed.id ? { id: parsed.id } : {});
            response.writeHead(303, { Location: `/offers/${saved.id}` });
            return response.end();
          }
          throw requestError('ページが見つかりません。', 404);
        } catch (error) {
          const status = [400, 403, 404, 409, 413, 415, 503].includes(error.status) ? error.status : 500;
          const findings = status === 400 ? activeFindings(offerInput) : [];
          const message = ({ 400: '入力を確認してください。必須項目、IDの重複、出典参照、日時、確認状態、利用区分、秘密情報の混入がないか確認してください。activeには確認済みの条件・禁止表現・CTAとURLが必要です。',
            403: 'このアプリの案件入力画面から保存してください。', 404: '案件またはページが見つかりません。',
            409: 'IDの重複、古いrevision、または別の更新処理を検出しました。最新版を開き直してください。',
            413: '入力が大きすぎます。', 415: 'フォーム形式で送信してください。' })[status] || '案件情報を安全に読み書きできません。記録を削除せず確認してください。';
          // 例外や入力値は表示・ログ出力しない。秘密情報を含む可能性があるため再描画もしない。
          return send(status, page('案件の保存・表示エラー', `<section class="card"><h1>処理を完了できませんでした</h1><p class="error" role="alert">${message}</p>${findings.length ? `<h2>有効化に向けて確認する項目</h2><p>入力支援の案内です。これ以外の不正な入力も保存時に検証します。成果地点の番号は画面の並び順です。</p><ul>${findings.map(finding => `<li>${escapeHtml(finding)}</li>`).join('')}</ul>` : ''}<p>送信内容はこの画面に再表示しません。ブラウザで戻って修正するか、案件一覧から最新版を開いてください。</p><a href="/offers">案件一覧へ</a></section>`));
        }
      }
      if (request.method === 'GET' && url.pathname === '/style.css') {
        return send(200, await readFile(path.join(projectDirectory, 'public/style.css')), 'text/css; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/app.js') return send(200, await readFile(path.join(projectDirectory, 'public/app.js')), 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/') {
        return send(200, formPage(await listPlans(), {}, '', await offerStore.list()));
      }
      const editPlanMatch = url.pathname.match(/^\/plans\/([a-f0-9-]{36})\/edit$/);
      if (request.method === 'GET' && editPlanMatch) {
        return send(200, formPage(await listPlans(), await readPlan(editPlanMatch[1]), '', await offerStore.list()));
      }
      if (request.method === 'POST' && (url.pathname === '/plans' || editPlanMatch)) {
        const form = await readForm(request, host);
        const allowed = [...fields.map(([key]) => key), ...bindingFields, ...(editPlanMatch ? ['planRevision'] : [])];
        if ([...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1)) throw requestError('企画の入力項目が不正です。');
        const values = Object.fromEntries(fields.map(([key]) => [key, (form.get(key) || '').trim()]));
        let error = '';
        if (!values.theme) error = 'コンテンツのテーマを入力してください。';
        else if (!mediaOptions.includes(values.medium)) error = '媒体を選択肢から選んでください。';
        else if (fields.some(([key, , limit]) => values[key].length > limit)) error = '入力の文字数が上限を超えています。短くして再度保存してください。';
        if (error) throw requestError(error);
        const id = editPlanMatch?.[1] || randomUUID();
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        const lock = path.join(dataDirectory, `.plan-${id}.lock`);
        try { await mkdir(lock, { mode: 0o700 }); }
        catch (error) { if (error.code === 'EEXIST') throw requestError('企画を別の処理で保存中です。', 409); throw error; }
        const destination = path.join(dataDirectory, `${id}.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          const previous = editPlanMatch ? await readPlan(id) : null;
          if (previous && form.get('planRevision') !== String(previous.revision || 1)) throw requestError('企画が更新されています。編集画面を開き直してください。', 409);
          // 古いクライアントからの編集で紐付けを暗黙に削除しない。
          if (previous?.offerBinding && bindingFields.some(key => !form.has(key))) throw requestError('案件の選択内容を確認してください。');
          const binding = await resolvePlanOffer(form, previous?.offerBinding, offerStore);
          const plan = { ...(previous || { id, createdAt: new Date().toISOString() }), ...values,
            revision: previous ? (previous.revision || 1) + 1 : 1 };
          if (previous) plan.updatedAt = new Date().toISOString();
          if (binding) plan.offerBinding = binding; else delete plan.offerBinding;
          await writeFile(temporary, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          await rename(temporary, destination);
        } finally {
          await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await rmdir(lock);
        }
        response.writeHead(303, { Location: `/plans/${id}` });
        return response.end();
      }
      const generateMatch = url.pathname.match(/^\/plans\/([a-f0-9-]{36})\/generate$/);
if (generateMatch && ['GET', 'POST'].includes(request.method)) {
        const plan = await readPlan(generateMatch[1]);
        if (request.method === 'GET') {
          const prepared = await generation.prepareConfirmation(plan);
          return send(200, page('生成前確認', generationViews.confirmation(plan, prepared.token, await generation.summary(), generation.config, await generation.recent(plan.id), '', generationOptions.provider?.ready !== false, prepared.affiliate)));
        }
        // 有料操作へ拡張する入口はOrigin必須。署名済み確認トークンも検証。
        if (request.headers.origin !== `http://${host}`) throw requestError('このアプリの生成前確認から実行してください。', 403);
        const form = await readForm(request, host, 10000);
        if (form.get('confirm') !== 'yes' || [...form.keys()].some(k => !['token', 'confirm'].includes(k)) || form.getAll('token').length !== 1 || form.getAll('confirm').length !== 1) throw requestError('生成前確認の入力が不正です。');
        try {
          const run = await generation.execute(plan, form.get('token'));
          response.writeHead(303, { Location: `/generations/${run.id}` });
          return response.end();
        } catch (error) {
          // Providerや保存層の生エラーは表示・ログに出さない。
          const known = [400, 409, 503].includes(error.status);
          return send(known ? error.status : 503, page('生成エラー', `<section class="card detail"><h1>生成を完了できませんでした</h1><p role="alert">${escapeHtml(known ? error.message : '生成記録の保存に失敗しました。生成は再実行していません。記録を削除せず確認してください。')}</p><a href="/plans/${plan.id}/generate">生成前確認・実行履歴へ</a></section>`));
        }
      }
      const generationMatch = url.pathname.match(/^\/generations\/([a-f0-9-]{36})(\/save)?$/);
      if (generationMatch && ['GET', 'POST'].includes(request.method)) {
        if (request.method === 'POST') {
          if (!generationMatch[2] || request.headers.origin !== `http://${host}`) throw requestError('生成結果画面から操作してください。', 403);
          const form = await readForm(request, host, 10000);
          generation.verifyAction(generationMatch[1], form.get('token'));
          await generation.retrySave(generationMatch[1]);
          response.writeHead(303, { Location: `/generations/${generationMatch[1]}` });
          return response.end();
        }
        if (generationMatch[2]) throw requestError('ページが見つかりません。', 404);
        const run = await generation.get(generationMatch[1]);
        return send(200, page('AI生成結果', generationViews.result(run, await generation.summary(), generation.config, generation.actionToken(run.id))));
      }
      const importMatch = url.pathname.match(/^\/plans\/([a-f0-9-]{36})\/drafts$/);
      if (request.method === 'POST' && importMatch) {
        const plan = await readPlan(importMatch[1]);
        const form = await readForm(request, host, 4_000_000);
        const raw = form.get('result') || '';
        try {
          if (raw.length > 400000) throw requestError('生成結果は400,000文字以内にしてください。');
          const parsed = parseImport(raw, plan.id);
          if (parsed.normalization && form.get('confirmWrap') !== 'yes') {
            return send(200, page('取り込み前の確認', importPreview(plan, parsed, raw)));
          }
          const draft = await draftStore.create(plan, parsed, raw, buildPrompt(plan));
          response.writeHead(303, { Location: `/drafts/${draft.id}` });
          return response.end();
        } catch (error) {
          if (!error.status) throw error;
          return send(error.status, detailPage(plan, await draftStore.list(plan.id), raw, error.message, await currentOffer(plan)));
        }
      }
      const improveMatch = url.pathname.match(/^\/drafts\/([a-f0-9-]{36})\/improve$/);
      if (request.method === 'POST' && improveMatch) {
        const form = await readForm(request, host);
        const draft = await draftStore.get(improveMatch[1]);
        if ([...url.searchParams].length) throw requestError('改善依頼に未知の入力があります。');
        readImprovementFields(form, 'create');
        if (Number(form.get('revision')) !== draft.revision) throw requestError('別の画面で更新されています。最新の下書きを開き直して依頼文を作ってください。', 409);
        const settings = readImprovementSettings(form);
        const plan = hasAffiliateProvenance(draft) ? { id: draft.planId } : await readPlan(draft.planId);
        const improvement = await improvementStore.create(plan, draft, settings);
        response.writeHead(303, { Location: `/improvements/${improvement.id}` });
        return response.end();
      }
      const improvementMatch = url.pathname.match(/^\/improvements\/([a-f0-9-]{36})$/);
      if (improvementMatch && ['GET', 'POST'].includes(request.method)) {
        let improvement = await improvementStore.get(improvementMatch[1]);
        const parent = await draftStore.get(improvement.parentDraftId);
        if ([...url.searchParams].length) throw requestError('改善依頼に未知の入力があります。');
        improvement = validateImprovementWork(improvement, parent);
        if (request.method === 'GET') return send(200, page('改善依頼文', improvementPage(improvement)));
        const form = await readForm(request, host, 4_000_000);
        readImprovementFields(form, 'import');
        if (improvement.settings.mode !== 'rewrite') throw requestError('分析結果はドラフトとして取り込めません。');
        const raw = form.get('result') || '';
        try {
          if (raw.length > 400000) throw requestError('生成結果は400,000文字以内にしてください。');
          const plan = improvement.planSnapshot;
          const parsed = parseImprovementResult(improvement, raw);
          if (parsed.normalization && form.get('confirmWrap') !== 'yes') return send(200, page('取り込み前の確認', importPreview(plan, parsed, raw, improvement)));
          const draft = await draftStore.createImproved(improvement.id, raw);
          response.writeHead(303, { Location: `/drafts/${draft.id}` });
          return response.end();
        } catch (error) {
          if (!error.status) throw error;
          return send(error.status, page('改稿の取り込み', improvementPage(improvement, improvement.schemaVersion === 2 ? '' : raw, error.message)));
        }
      }
      const copyMatch = url.pathname.match(/^\/drafts\/([a-f0-9-]{36})\/copy$/);
      if (copyMatch && request.method === 'POST') {
        const json = body => send(body.result === 'pass' ? 200 : 409, JSON.stringify(body), 'application/json; charset=utf-8');
        if (request.headers.origin !== `http://${host}`) return send(403, JSON.stringify({ result: 'blocked', reasonCode: 'invalid-request', message: '公開準備画面からコピーしてください。' }), 'application/json; charset=utf-8');
        try {
          const form = await readForm(request, host, 2000);
          return json(await draftStore.copy(copyMatch[1], form));
        } catch (error) {
          // 入力・読取・保存エラーの生データをJSONやログへ転載しない。
          return send(error.status || 503, JSON.stringify({ result: 'blocked', reasonCode: 'copy-unavailable', message: 'コピー確認を完了できません。下書きと公開準備画面を開き直してください。' }), 'application/json; charset=utf-8');
        }
      }
      const publishMatch = url.pathname.match(/^\/drafts\/([a-f0-9-]{36})\/publish$/);
      if (publishMatch && ['GET', 'POST'].includes(request.method)) {
        const draft = await draftStore.get(publishMatch[1]);
        if (request.method === 'GET') return send(200, page('公開準備', publishPage(draft, escapeHtml)));
        const form = await readForm(request, host);
        try {
          await draftStore.update(draft.id, Number(form.get('revision')), form, 'publish');
          response.writeHead(303, { Location: `/drafts/${draft.id}/publish` });
          return response.end();
        } catch (error) {
          if (!error.status) throw error;
          return send(error.status, page('公開準備', publishPage(await draftStore.get(draft.id), escapeHtml, error.message)));
        }
      }
      const validationMatch = url.pathname.match(/^\/drafts\/([a-f0-9-]{36})\/affiliate-validation$/);
      if (validationMatch && request.method === 'POST') {
        const form = await readForm(request, host);
        if (request.headers.origin !== `http://${host}`) throw requestError('このアプリの入力画面から再検査してください。', 403);
        if ([...form.keys()].some(key => key !== 'revision') || form.getAll('revision').length !== 1) throw requestError('再検査の入力が不正です。');
        const draft = await draftStore.get(validationMatch[1]);
        try {
          await draftStore.update(draft.id, Number(form.get('revision')), null, 'revalidate');
          response.writeHead(303, { Location: `/drafts/${draft.id}` });
          return response.end();
        } catch (error) {
          if (!error.status) throw error;
          return send(error.status, page('下書きの再検査', editor(draft, draft.edited, error.message, draft.revision, await draftStore.list(draft.planId), await readPlan(draft.planId))));
        }
      }
      const draftMatch = url.pathname.match(/^\/drafts\/([a-f0-9-]{36})$/);
      if (draftMatch && (request.method === 'GET' || request.method === 'POST')) {
        const draft = await draftStore.get(draftMatch[1]);
        if (request.method === 'GET') return send(200, page('下書き', editor(draft, draft.edited, "", draft.revision, await draftStore.list(draft.planId), await readPlan(draft.planId))));
        const form = await readForm(request, host, 4_000_000);
        const values = Object.fromEntries(contentFields.map(([key]) => [key, key === 'titles' ? (form.get(key) || '').replace(/\r\n/g, '\n').split('\n') : (form.get(key) || '').replace(/\r\n/g, '\n')]));
        try {
          if (!['save', 'review'].includes(form.get('action'))) throw requestError('保存または確認済みを選択してください。');
          await draftStore.update(draft.id, Number(form.get('revision')), validateContent(values), form.get('action'));
          response.writeHead(303, { Location: `/drafts/${draft.id}` });
          return response.end();
        } catch (error) {
          if (!error.status) throw error;
          return send(error.status, page('下書きの保存エラー', editor(draft, values, error.message, form.get('revision'), await draftStore.list(draft.planId), await readPlan(draft.planId))));
        }
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
        return send(200, detailPage(JSON.parse(contents), await draftStore.list(match[1]), '', '', await currentOffer(JSON.parse(contents))));
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
  // dotenvは実行時だけ読み込み、server.jsをimportする自動テストでは読みません。
  await import('dotenv/config');
  const provider = createOpenAIProvider();
  const server = createApp({ generationOptions: { provider, config: openaiConfig },
    extractionOptions: { provider: createOpenAIExtractionProvider({ apiKey: process.env.OPENAI_API_KEY }) } });
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
