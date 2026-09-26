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
