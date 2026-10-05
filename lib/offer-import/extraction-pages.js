import { hashDocumentText } from './validation.js';
import { exact, rejectSecrets, safetyError } from '../ai/safety-storage.js';
import { fixedJSON } from '../ai/extraction-payload.js';

const kinds = { asp_material: 'ASP資料', advertiser_material: '広告主レギュレーション', user_provided: '人間提供資料' };
export function makeDocuments(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 20) throw safetyError('documents_required', 400);
  const documents = rows.map((row, i) => {
    exact(row, ['label', 'kind', 'versionLabel', 'text']); rejectSecrets(row);
    if (typeof row.text !== 'string' || !row.text.trim() || typeof row.label !== 'string' || !row.label.trim()
        || !Object.hasOwn(kinds, row.kind) || (row.versionLabel !== null && typeof row.versionLabel !== 'string')) throw safetyError('document_invalid', 400);
    return { id: `document-${i + 1}`, format: 'text', label: row.label, kind: row.kind, versionLabel: row.versionLabel,
      text: row.text, textHash: hashDocumentText(row.text), blocks: [{ id: 'block-1', start: 0, end: row.text.length }] };
  });
  return documents;
}
export function parseExtractionForm(form) {
  const names = [...form.keys()];
  if (names.some(k => form.getAll(k).length !== 1 || !/^(?:offerId|offerRevision|documents\.(?:0|[1-9]\d?)\.(?:label|kind|versionLabel|text))$/.test(k))
      || !/^[a-f0-9-]{36}$/.test(form.get('offerId') || '') || !/^[1-9]\d*$/.test(form.get('offerRevision') || '')) throw safetyError('extraction_form_invalid', 400);
  const indexes = [...new Set(names.filter(k => k.startsWith('documents.')).map(k => Number(k.split('.')[1])))].sort((a,b) => a-b);
  if (!indexes.length || indexes.length > 20 || indexes.some((v,i) => v !== i)) throw safetyError('extraction_form_invalid', 400);
  const rows = indexes.map(i => {
    const fields = ['label','kind','versionLabel','text'];
    if (fields.some(k => !form.has(`documents.${i}.${k}`))) throw safetyError('extraction_form_invalid', 400);
    return Object.fromEntries(fields.map(k => [k, form.get(`documents.${i}.${k}`)]));
  }).filter(row => row.label !== '' || row.text !== '' || row.versionLabel !== '');
  return { targetOffer: { id: form.get('offerId'), revision: Number(form.get('offerRevision')) },
    documents: makeDocuments(rows.map(row => ({ ...row, versionLabel: row.versionLabel === '' ? null : row.versionLabel }))) };
}
export function parseExtractionApproval(form) {
  if (form.size !== 2 || form.getAll('confirm').length !== 1 || form.getAll('token').length !== 1 || form.get('confirm') !== 'yes'
      || [...form.keys()].some(k => !['confirm','token'].includes(k))) throw safetyError('approval_required', 400);
  return form.get('token');
}
const privacy = '<p class="notice">選んだ資料の全文・metadata・instructions・schemaをOpenAIへ外部送信します。送信権限と必要部分を人間が確認してください。API key、Cookie、パスワード、認証付きURL、管理画面全文、不要な個人情報は貼り付けないでください。既知形式は検査しますが、秘密・個人情報を完全検出する保証はありません。原本と検証済み候補はローカルに保持され、backupにも含まれます。store:falseは外部での保持が一切ない保証ではありません。</p>';
export function extractionPages(e) {
  function documentRow(i, kind = 'asp_material') {
    return `<fieldset data-extraction-document><legend>テキスト資料</legend><label>資料名<input name="documents.${i}.label" maxlength="500"></label>
      <label>type<select name="documents.${i}.kind">${Object.entries(kinds).map(([value,label]) => `<option value="${value}"${value === kind ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>版（不明なら空欄）<input name="documents.${i}.versionLabel" maxlength="200"></label>
      <label>外部送信する本文<textarea name="documents.${i}.text" rows="7" maxlength="100000"></textarea></label>
      <button type="button" data-remove-document class="secondary">この資料欄を削除</button></fieldset>`;
  }
  function intake(offers, offer) {
    return `<h1>資料から登録候補を作る</h1><p>正式案件がない場合は、先に<a href="/offers/new">人間がdraft案件を登録</a>してください。AIは案件・成果地点を作成しません。</p>
      <form method="get" action="/offer-extractions/new"><label>対象案件<select name="offerId">${offers.map(o => `<option value="${e(o.id)}"${offer?.id === o.id ? ' selected' : ''}>${e(o.name)}（${e(o.status)} / revision ${o.revision}）</option>`).join('')}</select></label><button>対象案件を選ぶ</button></form>
      ${offer ? `<section class="card"><h2>${e(offer.name)}</h2><p>ID ${e(offer.id)} / revision ${offer.revision} / status ${e(offer.status)}</p>${privacy}
      <p>テキスト貼り付けのみ、最大20資料です。必要な資料を別欄に入力してください。改行を含む受け取った本文を保持します。長文を自動分割・切り捨てしません。</p>
      <form method="post" action="/offer-extractions/prepare" data-extraction-form autocomplete="off"><input type="hidden" name="offerId" value="${e(offer.id)}"><input type="hidden" name="offerRevision" value="${offer.revision}">
      <div data-extraction-documents>${documentRow(0)}${documentRow(1,'advertiser_material')}</div><template data-extraction-template>${documentRow('__INDEX__')}</template>
      <button type="button" data-add-document class="secondary">資料欄を追加</button><p>空の資料欄は保存しません。資料入力の保存だけでは外部送信しません。</p>
      <noscript><p>JavaScriptなしでも上の2資料を貼り付けて確認できます。</p></noscript><button>固定資料を保存し、送信前確認へ進む</button></form></section>` : '<p>先にdraft案件を登録してください。</p>'}<a href="/offer-extractions">抽出実行一覧</a>`;
  }
  function list(records) {
    return `<h1>資料抽出の実行記録</h1><a href="/offer-extractions/new">資料から登録候補を作る</a><p>再送・再解析・自動復旧は行いません。成功は採用・出典照合・正式反映とは別です。</p><ul>${records.filter(r => r.provider === 'openai').map(r => `<li><a href="/offer-extractions/${e(r.id)}">${e(r.id)}</a>：${e(r.state)} / revision ${r.revision}</li>`).join('') || '<li>実抽出記録はありません。</li>'}</ul>`;
  }
  function detail(v) {
    const r = v.record; const p = v.profile; const budget = v.budget;
    const projected = budget ? budget.totals.real.bookedMilliYen + budget.totals.real.reservedMilliYen + r.estimate.maximumReservedMilliYen : null;
    return `<h1>資料抽出の送信前確認・実行状態</h1><section class="card"><h2>対象案件</h2><p>${e(v.offer.name)} / ID ${e(r.targetOffer.id)} / revision ${r.targetOffer.revision} / status ${e(v.offer.status)}</p>
      <p>execution ${e(r.id)} / revision ${r.revision} / state ${e(r.state)}</p>${privacy}
      <h2>固定した資料</h2>${v.input.documents.map(d => `<section><h3>${e(d.label)}</h3><p>type ${e(d.kind)}（${e(kinds[d.kind])}） / version ${e(d.versionLabel || '未指定')} / ID ${e(d.id)}</p>
        <p>本文 ${Buffer.byteLength(d.text)} UTF-8 bytes / 本文hash</p><pre>${e(d.textHash)}</pre><pre>${e(d.text)}</pre></section>`).join('')}
      <h2>実際に外部へ送る全文・metadata</h2><p>inputの全文です。本文とdocument/block ID、hash、UTF-16位置情報、対象offer ID/revisionを含みます。</p><pre>${e(v.payload.input)}</pre>
      <h2>extraction instructions</h2><pre>${e(v.payload.instructions)}</pre><h2>output schema</h2><pre>${e(JSON.stringify(v.payload.text.format.schema,null,2))}</pre>
      <details><summary>全request body（同じbuilderから生成）</summary><pre>${e(fixedJSON(v.payload))}</pre></details>
      <h2>model・費用・設定</h2><p>provider ${e(r.provider)} / model ${e(r.model)} / Standard processing / store:false / retries:0 / timeout ${r.configuration.timeoutMs}ms</p>
      <p>推定input tokens：${r.estimate.inputTokens}（全request ${v.requestBytes} UTF-8 bytes × 2 + 8192。保守的見積で、実usageとは異なります）</p>
      <p>最大input tokens：${r.configuration.maxInputTokens} / 最大output tokens：${r.configuration.maxOutputTokens}</p><p>概算費用：${r.estimate.estimatedMilliYen / 1000}円（推定input＋最大output） / 最大予約額：${r.estimate.maximumReservedMilliYen / 1000}円</p>
      <p>価格：input $${e(p.pricing.inputUsdPerMillion)} / output $${e(p.pricing.outputUsdPerMillion)} per 1M tokens / pricing version ${e(p.pricing.version)}</p>
      <p>固定為替：1 USD = ${p.exchange.jpyPerUsd} JPY / 為替version ${e(p.exchange.version)}</p><p>profile / configuration version</p><pre>${e(r.configuration.version)}</pre><p>configuration hash</p><pre>${e(r.configuration.hash)}</pre>
      <p>request hash</p><pre>${e(r.requestHash)}</pre><p>immutable input artifact ${e(r.inputArtifact.id)} / ${r.inputArtifact.bytes} bytes</p><pre>${e(r.inputArtifact.hash)}</pre>
      <h2>共通real budget</h2><p>記事生成と案件抽出で共有するアプリ内停止額です。API残高そのものではありません。</p>
      ${budget ? `<p>集計月 ${e(budget.totals.month)}（UTC） / effective real停止額 ${budget.effectivePolicy.realStopMilliYen === null ? '無効（null）' : `${budget.effectivePolicy.realStopMilliYen / 1000}円`}</p>
        <p>当月計上 ${budget.totals.real.bookedMilliYen / 1000}円 / 全月未解放予約 ${budget.totals.real.reservedMilliYen / 1000}円 / 今回予約を加えた合計 ${projected / 1000}円</p><p>今回予約後の判定：${budget.allowed ? '予算内' : '送信停止'}</p>` : '<p role="alert">共通予算を確認できないため送信停止です。</p>'}
      <p><a href="/maintenance/ai-budget">共通budget状態を確認する</a></p>
      ${r.budget.usage ? `<h2>応答の実usage（見積とは別）</h2><p>input ${r.budget.usage.inputTokens} / output ${r.budget.usage.outputTokens} tokens / 計上 ${r.budget.bookedMilliYen / 1000}円</p>` : '<p>実usageはまだ確定していません。</p>'}
      ${r.state === 'succeeded' ? `<p>抽出候補はpending / unverifiedです。</p><a href="/offer-imports/${e(r.savedImport.id)}">候補をレビューする</a>` : v.token ? `<form method="post" action="/offer-extractions/${e(r.id)}/approve"><input type="hidden" name="token" value="${e(v.token)}">
        <label><input type="checkbox" name="confirm" value="yes" required> 外部へ送る全文・metadata・instructions・schema・model・費用・privacyを確認し、今回一度だけの送信を承認します</label><button>確認した資料をOpenAIへ送信する</button></form>` : '<p role="alert">送信を許可できません。予算・Provider設定・実行状態を人間が確認してください。結果不明時は予約を保持し、両AI経路を停止します。再送・自動復旧はしません。</p>'}
      </section><a href="/offer-extractions">実行一覧へ戻る</a>`;
  }
  function failure() { return '<h1>資料抽出を停止しました</h1><p role="alert">入力・確認・予算・競合・保存状態を安全に検証できません。自動再送・上書き・修復は行いません。保存または送信済みの可能性があるため、実行記録を人間が確認してください。</p><a href="/offer-extractions">実行記録を確認する</a>'; }
  return { intake, list, detail, failure };
}
