// Progressive enhancement only. Server validation remains authoritative; no storage or API calls.
for (const form of document.querySelectorAll('[data-candidate-review]')) {
  function dirty() {
    form.querySelector('[data-review-message]').textContent = '未保存の修正があります。候補を保存してから出典照合してください。';
    const button = form.closest('.import-candidate').querySelector('.import-verification button');
    if (button) button.disabled = true;
  }
  form.addEventListener('input', dirty);
  form.addEventListener('change', dirty);
  form.addEventListener('submit', () => {
    form.querySelector('[data-review-message]').textContent = '保存結果を待っています。再送せず、結果を確認してください。';
  });
}
