// Progressive enhancement only. Server validation remains authoritative; no storage or API calls.
for (const form of document.querySelectorAll('[data-candidate-review]')) {
  let hasUnsavedChanges = false;
  function dirty() {
    hasUnsavedChanges = true;
    form.querySelector('[data-review-message]').textContent = '未保存の修正があります。候補を保存してから出典照合してください。';
    const button = form.closest('.import-candidate').querySelector('.import-verification button');
    if (button) button.disabled = true;
  }
  form.addEventListener('input', dirty);
  form.addEventListener('change', dirty);
  window.addEventListener('beforeunload', event => {
    if (hasUnsavedChanges) { event.preventDefault(); event.returnValue = ''; }
  });
  form.addEventListener('submit', () => {
    hasUnsavedChanges = false;
    form.querySelector('[data-review-message]').textContent = '保存結果を待っています。再送せず、結果を確認してください。';
  });
}

// Focus follows the server-rendered selection; no state transitions or revision updates.
const focusTarget = document.getElementById(location.hash.slice(1));
const focusElement = focusTarget?.matches('[tabindex="-1"]') ? focusTarget
  : focusTarget?.querySelector('[data-review-focus]') || document.querySelector('[data-review-focus]');
focusElement?.focus({ preventScroll: !location.hash });
