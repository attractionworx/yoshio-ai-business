// 入力支援用。保存可否の判定には使わず、Step 1の検証が拒否した後の案内に使用する。
// 戻り値は固定文と配列の位置だけ。案件名・ID・本文・URLなどは含めない。
export function activeFindings(offer) {
  if (!offer) return [];
  const findings = [];
  function conditions(items, label) {
    if (!items?.length) { findings.push(`${label}が未登録です。`); return; }
    if (items.some(s => s.verification !== 'source_checked')) findings.push(`${label}に未確認の情報があります。`);
    if (items.some(s => s.usage === 'internal_only')) findings.push(`${label}は内部管理専用のままでは有効化できません。`);
    if (items.some(s => !s.sourceIds.length || s.sourceIds.some(id => !offer.sources.some(source => source.id === id && source.checkedAt)))) findings.push(`${label}の出典参照・資料の確認日時を確認してください。`);
  }
  if (offer.status === 'active') {
    conditions(offer.prohibitedExpressions, '禁止表現');
    if (!offer.conversions.some(c => c.status === 'active')) findings.push('有効な成果地点がありません。成果地点の状態も「有効」にしてください。');
  }
  offer.conversions.forEach((c, index) => {
    if (c.status !== 'active' && offer.status !== 'active') return;
    if (c.status !== 'active' && offer.conversions.some(item => item.status === 'active')) return;
    const prefix = `成果地点${index + 1}${c.status === 'active' ? '' : '（有効にする場合）'}：`;
    for (const [key, label] of [['eligibility', '対象条件'], ['approvalConditions', '成果条件'], ['rejectionConditions', '否認条件']]) conditions(c[key], prefix + label);
    if (!c.ctaLabel) findings.push(`${prefix}CTAが未登録です。`);
    else {
      conditions([c.ctaLabel], prefix + 'CTA');
      if (c.ctaLabel.usage !== 'publishable') findings.push(`${prefix}CTAは公開用の利用区分にしてください。`);
    }
    if (!c.affiliateUrl) findings.push(`${prefix}アフィリエイトURLが未登録です。`);
  });
  return findings.slice(0, 100);
}

export function toJapanInput(value) {
  if (!value) return '';
  return new Date(Date.parse(value) + 9 * 60 * 60 * 1000).toISOString().slice(0, -1);
}

export function fromJapanInput(value) {
  // カレンダー上の正しさは既存validationへ渡す。Dateによる日付の繰り上げ補正はしない。
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) return value;
  return `${value.length === 16 ? value + ':00' : value}+09:00`;
}
