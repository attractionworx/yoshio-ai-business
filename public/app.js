const copyButton = document.querySelector('[data-copy]');
copyButton?.addEventListener('click', async () => {
  const field = document.getElementById(copyButton.dataset.copy);
  const message = document.getElementById('copy-message');
  try {
    await navigator.clipboard.writeText(field.value);
    message.textContent = 'コピーしました。Codexに貼り付けてください。';
  } catch {
    field.focus(); field.select();
    message.textContent = '依頼文を選択しました。Command+C（WindowsではCtrl+C）でコピーしてください。';
  }
});
const editor = document.querySelector('[data-editor]');
editor?.addEventListener('input', () => {
  document.getElementById('draft-status').textContent = '編集中（未保存）';
  document.getElementById('edit-message').textContent = '変更を保存した後、内容を読み直して確認済みにしてください。';
  editor.querySelector('[data-review]').disabled = true;
});
// 改善依頼は保存済みの版を使用。編集中の文章を置き去りにしないよう誘導します。
editor?.addEventListener('input', () => {
  const button = document.querySelector('[data-improve] button');
  if (button) { button.disabled = true; button.textContent = '編集内容を保存してから改善依頼文を作る'; }
});
if (editor && document.querySelector('.error')) {
  const button = document.querySelector('[data-improve] button');
  if (button) { button.disabled = true; button.textContent = '保存エラーを解決してから改善依頼文を作る'; }
}

function blockPublishLink() {
  const section = document.querySelector('[data-publish-link]');
  if (section) {
    section.querySelector('a')?.remove();
    section.querySelector('p').textContent = '編集内容を保存し、確認済みにしてから公開準備へ進んでください。';
  }
}
editor?.addEventListener('input', blockPublishLink);
if (editor && document.querySelector('.error')) blockPublishLink();

document.querySelector('[data-publish]')?.addEventListener('change', () => {
  document.getElementById('publish-change').textContent = '変更は未保存です。公開前チェックまたは公開準備OKボタンで保存してください。';
  document.getElementById('publish-status').textContent = '未チェック（変更は未保存）';
  document.querySelectorAll('[data-publication-copy]').forEach(button => { button.disabled = true; });
});
document.querySelectorAll('[data-publication-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const field = document.getElementById(button.dataset.publicationCopy);
    const message = document.getElementById(`${field.id}-message`);
    try {
      await navigator.clipboard.writeText(field.value);
      message.textContent = 'コピーしました。公開先で最終確認してください。';
    } catch {
      field.focus(); field.select();
      message.textContent = 'コピーに失敗しました。選択した文章をCommand+C（WindowsではCtrl+C）でコピーしてください。';
    }
  });
});

// サーバーの実行IDによる重複防止に加え、画面でも送信中を明示します。
document.querySelector('[data-generate]')?.addEventListener('submit', event => {
  event.currentTarget.querySelector('button').disabled = true;
  event.currentTarget.querySelector('[data-generation-message]').textContent = 'AIで生成しています。完了までこの画面を閉じずにお待ちください。';
});

// 選択肢は表示用の最小データだけ。保存時はサーバーで履歴・所属を再検証する。
const planOffer = document.querySelector('[data-plan-offer]');
if (planOffer) {
  const offer = planOffer.querySelector('[name=offerId]');
  const conversion = planOffer.querySelector('[name=conversionId]');
  const revision = planOffer.querySelector('[name=offerRevision]');
  const reason = planOffer.querySelector('[name=selectionReason]');
  const choices = [...conversion.options].slice(1).map(option => option.cloneNode(true));
  function updateRevision() {
    const saved = offer.value === planOffer.dataset.savedOffer && conversion.value === planOffer.dataset.savedConversion;
    revision.value = offer.value ? (saved ? planOffer.dataset.savedRevision : offer.selectedOptions[0].dataset.revision) : '';
    planOffer.querySelector('[data-binding-revision]').textContent = revision.value ? `使用する案件 revision ${revision.value}（保存時に再確認）` : '';
    conversion.required = Boolean(offer.value);
    conversion.disabled = !offer.value;
    reason.disabled = !offer.value;
  }
  function filterConversions(selected = '') {
    conversion.replaceChildren(new Option('成果地点を選択してください', ''));
    for (const option of choices.filter(option => option.dataset.offer === offer.value)) {
      const copy = option.cloneNode(true);
      copy.selected = copy.value === selected;
      conversion.append(copy);
    }
    conversion.value = selected;
    updateRevision();
  }
  offer.addEventListener('change', () => {
    if (!offer.value) reason.value = '';
    filterConversions(); // 成果地点は自動選択しない。
  });
  conversion.addEventListener('change', updateRevision);
  filterConversions(conversion.value);
  planOffer.dataset.ready = 'true';
  document.querySelector('[data-plan-form]').addEventListener('submit', () => {
    // disabledの空欄も明示送信し、既存紐付けの解除と欠落を区別する。
    conversion.disabled = false;
    reason.disabled = false;
  });
}
