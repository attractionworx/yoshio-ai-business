// Static diagnostic vocabulary only. Never include payload, paths, quotes, or raw exceptions.
export const validationReasons = Object.freeze({
  validation_failed: '抽出結果の検証に失敗しました。詳細理由の記録はありません。過去の失敗理由は推測しません。',
  validation_response: 'Provider応答の内部形式が一致しません。',
  validation_input: '固定入力資料の形式・hash・block構成を検証できません。',
  validation_schema: '抽出結果が既存schemaの形式・必須項目・値の制約を満たしていません。',
  validation_candidate: '候補の対象・分類・用途・成果地点の対応が既存契約と一致しません。',
  validation_evidence_reference: '根拠のdocument IDまたはblock IDが固定資料に存在しません。',
  validation_evidence_range: '根拠の位置範囲がblockの範囲内に収まっていない、または開始・終了の順序が不正です。',
  validation_quote: '根拠のquoteが指定位置の原文と完全一致しません。',
  validation_evidence_duplicate: '同じ候補内で同一の根拠が重複しています。',
  validation_secret: '秘密情報または許可しない管理画面形式の安全検査で拒否しました。',
});
export const validationReasonCode = code => Object.hasOwn(validationReasons, code) ? code : 'validation_failed';
