// ブラウザの入力支援。保存時の検証は必ずサーバー側で行う。
export function nextInternalId(path, used, uuid = () => crypto.randomUUID()) {
  const prefix = /^offer\.sources\.\d+\.id$/.test(path) ? 'source'
    : /^offer\.conversions\.\d+\.id$/.test(path) ? 'conversion' : 'statement';
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = `${prefix}-${uuid()}`;
    if (!used.has(id)) { used.add(id); return id; }
  }
  throw new Error('IDを自動入力できませんでした。再度追加してください。');
}

export function sourceChoices(sources, selected = '') {
  const choices = [{ value: '', label: '出典を選択してください' }];
  for (const source of sources) if (source.id && !choices.some(c => c.value === source.id)) {
    choices.push({ value: source.id, label: `${source.label || '資料名未入力'}（${source.id}）` });
  }
  // 出典削除時に他の出典へ自動で付け替えない。
  if (selected && !choices.some(c => c.value === selected)) choices.push({ value: selected, label: `参照先がありません（${selected}）` });
  return choices;
}
