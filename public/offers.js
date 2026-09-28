import { nextInternalId, sourceChoices } from './offer-helpers.js';

const form = document.querySelector('[data-offer-form]');
function fillNewIds(container) {
  const used = new Set([...form.querySelectorAll('[data-internal-id]')].map(field => field.value).filter(Boolean));
  for (const field of container.querySelectorAll('[data-internal-id]')) {
    if (!field.value) field.value = nextInternalId(field.name, used);
  }
}
function refreshSources() {
  const sources = [...form.querySelectorAll('[data-internal-id]')].filter(field => /^offer\.sources\.\d+\.id$/.test(field.name)).map(field => ({
    id: field.value, label: form.elements.namedItem(field.name.replace(/\.id$/, '.label'))?.value || '',
  }));
  for (const select of form.querySelectorAll('[data-source-ref]')) {
    const current = select.value;
    select.replaceChildren(...sourceChoices(sources, current).map(choice => {
      const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; return option;
    }));
    select.value = current;
  }
}
function optionalVisibility(container) {
  for (const select of container.querySelectorAll('[data-optional-select]')) select.closest('[data-optional]').querySelector('[data-optional-fields]').hidden = select.value === 'null';
}
form?.addEventListener('click', event => {
  const add = event.target.closest('[data-add-item]');
  const remove = event.target.closest('[data-remove-item]');
  if (add) {
    const group = add.closest('[data-array]');
    const items = group.querySelector(':scope > [data-items]');
    if (items.children.length >= Number(group.dataset.max)) {
      form.querySelector('[data-offer-message]').textContent = '追加できる項目数の上限です。';
      return;
    }
    const template = document.createElement('template');
    const index = Number(group.dataset.next);
    // HTMLはサーバーのエスケープ済みテンプレート。置換するのは整数の添字のみ。
    template.innerHTML = group.querySelector(':scope > template').innerHTML.split(group.dataset.token).join(String(index));
    group.dataset.next = index + 1;
    const fragment = template.content.cloneNode(true);
    fillNewIds(fragment);
    optionalVisibility(fragment);
    const first = fragment.querySelector('input:not([type=hidden]), textarea, select');
    items.append(fragment);
    refreshSources();
    first?.focus();
  }
  if (remove) { remove.closest('[data-array-item]').remove(); refreshSources(); }
  if (add || remove) form.querySelector('[data-offer-message]').textContent = '変更はまだ保存されていません。';
});
form?.addEventListener('change', event => {
  if (event.target.matches('[data-optional-select]')) {
    event.target.closest('[data-optional]').querySelector('[data-optional-fields]').hidden = event.target.value === 'null';
    if (event.target.value === 'value') fillNewIds(event.target.closest('[data-optional]'));
  }
});
form?.addEventListener('input', event => {
  form.querySelector('[data-offer-message]').textContent = '変更はまだ保存されていません。';
  if (/^offer\.sources\.\d+\.(?:id|label)$/.test(event.target.name || '')) refreshSources();
});
form?.querySelector('nav')?.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (link) document.querySelector(link.getAttribute('href')).open = true;
});
if (form) { optionalVisibility(form); refreshSources(); form.dataset.offerReady = 'true'; }
