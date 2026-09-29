// 架空の案件。外部URLへアクセスしない。
const timestamp = '2026-09-28T00:00:00.000Z';
function statement(id, overrides = {}) {
  return { id, category: 'feature', text: '架空の検証資料の記載', origin: 'advertiser', sourceIds: ['source-1'], verification: 'source_checked', usage: 'publishable', ...overrides };
}
function conversion(id) {
  return { id, name: '架空の無料相談', status: 'active', reward: {
    kind: 'fixed', value: 100, currency: 'JPY', evidence: statement(`${id}-reward`, { category: 'reward', usage: 'internal_only' }),
  }, eligibility: [statement(`${id}-eligibility`, { category: 'eligibility', usage: 'constraint_only' })],
  approvalConditions: [statement(`${id}-approval`, { category: 'approval', usage: 'constraint_only' })],
  rejectionConditions: [statement(`${id}-rejection`, { category: 'rejection', usage: 'constraint_only' })],
  affiliateUrl: 'https://affiliate.example.test/visit?program=demo', ctaLabel: statement(`${id}-cta`, { text: '架空の相談を申し込む' }) };
}
export function offerInput() {
  return { name: '架空案件・実際の案件ではありません', advertiserName: null, asp: { code: 'test-asp', programId: null }, status: 'active',
    validFrom: null, validUntil: null, reviewDueAt: null,
    sources: [{ id: 'source-1', kind: 'advertiser_material', label: '架空の条件資料', publicUrl: null, checkedAt: timestamp }],
    facts: [statement('fact-1'), statement('fact-unverified', { verification: 'unverified', text: '未確認の料金' }), statement('fact-internal', { usage: 'internal_only' })],
    targetAudience: [statement('audience', { category: 'audience' })], sellingPoints: [],
    prohibitedExpressions: [statement('prohibition', { category: 'prohibition', usage: 'constraint_only', text: '必ず成功するとの表現は禁止' })],
    conversions: [conversion('consultation'), conversion('contract')],
    disclosure: { required: true, text: '広告：アフィリエイトリンクを含みます。', placements: ['bodyStart', 'social'] } };
}
