// 完全な架空の固定文章。ファイル・環境変数・ネットワークを読みません。
export const fakeContent = Object.freeze({
  summary: '動作確認のための架空の紙工作記事です。',
  titles: Object.freeze(['紙の森を作る', '架空の工作時間', '色紙を並べる楽しみ', '小さな紙の風景', '紙で想像する森']),
  readerNeeds: '仮の読者像として、紙工作を楽しみたい人を想定します。',
  outline: '材料を用意する\n色と形を考える\n並べて楽しむ',
  body: 'これはFake AIが返す架空のサンプルです。\n\n仮の例として、色紙を木の形に切り、机の上に並べて紙の森を作ります。色や配置を自由に考えてみましょう。本人の経験や実績を示す記事ではありません。',
  cta: '好きな色の組み合わせを考えてみてください。',
  social: '架空の紙工作サンプル。色紙で小さな森を想像してみましょう。',
});
export class FakeProviderError extends Error {
  constructor(outcome = 'unknown') { super('Fake Providerの検証用エラー'); this.outcome = outcome; }
}
// scenarioはサーバー／テストからだけ指定。ブラウザ入力には公開しません。
export function createFakeProvider({ scenario = 'success', delayMs = 30 } = {}) {
  return {
    kind: 'fake',
    async generate({ signal }) {
      await new Promise((resolve, reject) => {
        let timer;
        const abort = () => { clearTimeout(timer); reject(new FakeProviderError('unknown')); };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, scenario === 'timeout' ? 60_000 : delayMs);
      });
      if (scenario === 'error') throw new FakeProviderError('not-billed');
      if (scenario === 'unknown') throw new FakeProviderError('unknown');
      const content = structuredClone(fakeContent);
      if (scenario === 'missing') delete content.cta;
      if (scenario === 'violation') content.body = '私は月収100万円を達成しました。';
      return { status: scenario === 'incomplete' ? 'incomplete' : 'completed',
        text: scenario === 'invalid-json' ? '{invalid' : JSON.stringify(content),
        usage: { inputTokens: 1000, outputTokens: 2000 } };
    },
  };
}
