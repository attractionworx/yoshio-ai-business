const form = document.querySelector('[data-extraction-form]');
if (form) {
  const list = form.querySelector('[data-extraction-documents]');
  const add = form.querySelector('[data-add-document]');
  const renumber = () => {
    [...list.children].forEach((row,i) => row.querySelectorAll('[name]').forEach(el => { el.name = el.name.replace(/^documents\.[^.]+\./, `documents.${i}.`); }));
    add.disabled = list.children.length >= 20;
  };
  add.addEventListener('click', () => {
    if (list.children.length >= 20) return;
    list.append(form.querySelector('template').content.cloneNode(true)); renumber();
  });
  list.addEventListener('click', event => {
    if (event.target.matches('[data-remove-document]')) { event.target.closest('fieldset').remove(); renumber(); }
  });
  form.addEventListener('submit', renumber);
}
