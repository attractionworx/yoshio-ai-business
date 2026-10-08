import { reflectionV2ChoiceGuidance } from '/reflection-v2-guidance.js';
// UX only. Never change mode, checked state, draft revision/hash, or send requests.
for (const form of document.querySelectorAll('[data-reflection-v2-form]')) {
  const rows = [...form.querySelectorAll('[data-mapping-candidate]')];
  function state(row) {
    const id = row.dataset.mappingCandidate;
    return { mode: form.elements.namedItem(id + '.mode').value,
      conversionIds: [...row.querySelectorAll('[data-mapping-target]:checked')].map(x => x.value).filter(Boolean),
      commonConfirmed: Boolean(row.querySelector('[data-mapping-common]')?.checked),
      reason: form.elements.namedItem(id + '.reason').value };
  }
  function update() {
    let complete = 0;
    for (const row of rows) {
      const choice = state(row), guidance = reflectionV2ChoiceGuidance(choice);
      const common = row.querySelector('[data-mapping-common]');
      // Keep a checked but inapplicable confirmation enabled so the human can remove it.
      if (common) common.disabled = !common.checked && (choice.conversionIds.length < 2 || ['none', 'offer'].includes(choice.mode));
      row.querySelector('[data-mapping-status]').textContent = guidance.message;
      row.querySelector('[data-mapping-status]').dataset.status = guidance.status;
      row.querySelector('[data-mapping-summary]').textContent = guidance.status === 'complete' ? '入力完了' : guidance.status === 'invalid' ? '不整合・停止' : '未完了';
      if (guidance.status === 'complete') complete++;
    }
    form.querySelector('[data-mapping-input-progress]').textContent = `表示中の入力：入力完了 ${complete}件 ／ 未入力・未完了 ${rows.length - complete}件（変更分は未保存）。mode未選択は地点選択済みでも未完了です。`;
  }
  form.addEventListener('change', update);
  form.addEventListener('input', update);
  form.addEventListener('submit', event => {
    update();
    const row = rows.find(r => reflectionV2ChoiceGuidance(state(r)).status === 'invalid');
    if (!row) return;
    event.preventDefault(); row.open = true;
    const target = row.querySelector('[data-mapping-common]:checked') || row.querySelector('[data-mapping-status]');
    target.focus(); target.scrollIntoView({ block: 'center' });
  });
  update();
}
