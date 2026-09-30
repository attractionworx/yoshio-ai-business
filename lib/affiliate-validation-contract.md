# Affiliate validation v1（Step 5.1）

この契約は機械的な検出結果であり、事実の真偽、公開許可、署名ではない。
現在の保存・生成・編集・改善・公開フローには接続しない。

## 呼出し

`validateAffiliateContent({ content, affiliateContext, fixedOffer, checkedAt })`
は同期・純粋な関数。日時は呼出側が指定する。同じ入力には同じ結果を返す。
案件なしではcontext hashはnull、findingsは空。案件ありでは固定offerの照合が必須。
不正なcontent/context/日時は安全な例外。固定根拠の欠落・不整合はblock finding。
`loadAffiliateEvidence(context, store)`は既存のローカルstore.historyを読むadapter。
固定根拠を安全に読めない場合は値を含まない例外を返す。

## 結果

- schemaVersion: 1
- validationVersion: affiliate-local-v1
- contentHash: 7項目だけをvalidateContentで抽出し、オブジェクトキーを再帰的にsortしたJSONのSHA-256
- affiliateContextHash: schemaVersion、offerId、offerRevision、conversionId、snapshotの同方式hash。selectionReasonは対象外
- checkedAt: タイムゾーン付き日時文字列
- findings: 下記の配列

配列順・原文・改行はhashに影響する。オブジェクトキー順は影響しない。
既存contextHashはsnapshotの整合性検証として変更しない。

findingはid（内容のcanonical SHA-256）、固定code、severity、field、必要時のtitleIndex、
必要時のlocation、evidenceRefs、固定messageKeyを持つ。
locationは原文UTF-16のstart/end（endはexclusive）。正規化後の位置は保存しない。
evidenceRefsは固定snapshotの配列キー:index、cta、disclosureのみ。
fieldは7項目名のほか、根拠不整合にはcontext、全体確認にはallを使う。
タイトル候補はtitleIndex 0〜4で識別する。

## severityと人間確認

- block: 禁止表現一致、広告明示欠落・位置不一致、固定根拠不整合
- warning: 未登録数値候補、限定条件確認、事実表現確認、CTA不一致、禁止表現回避候補、全体の事実確認
- info: 数値を正規化した文の一致、事実文の一致、CTA文字列一致

infoは文字列一致のみを意味する。正常な案件記事にもhuman-fact-review-requiredを付ける。
このStepではhumanConfirmationを保存・適用するAPIやblock解除機能を設けない。
後続の確認データはvalidationVersion/contentHash/affiliateContextHash/findingsに束縛し、
warningの確認とblockの修正を区別する。blockはチェックボックスで解除しない。

## 検査の限界

数値単位は円、%、日、週、週間、月（か月/ヶ月/カ月を含む）、年、時間、分、人、名。
算用数字とNFKCに対応。万・億・千の単一倍率と桁区切りを同一値候補にする。
単位なしの構成数字は対象外。漢数字、複合倍率、通貨記号、複雑な条件の意味解析は未対応。
文脈を捨てた数値一致でinfoにしない。根拠文全体の一致がない数値はwarning。
実績・効果・対象等の非数値検査は限定語彙の候補検出で、網羅的な意味検査ではない。
広告明示は登録文言のNFKC/大小文字正規化一致。bodyStartは先頭空白後の冒頭。
CTAは欄全体の正規化一致のみinfo。自由文の不一致はwarningで、行動種別を推測しない。
本文を書き換えず、secret/URL/管理情報/記事抜粋を診断へ複製しない。
現在status・期限・最新revisionの公開制御は後続Stepで扱う。
