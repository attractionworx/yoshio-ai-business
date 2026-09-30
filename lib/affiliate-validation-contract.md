# Affiliate validation v1（Step 5.1）

この契約は機械的な検出結果であり、事実の真偽、公開許可、署名ではない。
純粋validator自身は保存・編集・公開処理を行わない。Step 5.2の接続は末尾を参照。

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

## Step 5.2: draftライフサイクル

affiliateContextを持つ直接AI生成draftは、保存予定のedited 7項目と固定revisionで検査し、
affiliateValidationを本文と同じ原子的保存に含める。記事のblock/warningでも保存成功とする。
内部エラー、根拠読取失敗、不整合では古い結果を削除し、代わりに次を保存する：

`affiliateValidationFailure: { schemaVersion: 1, code: 'validation-unavailable', attemptedAt, contentHash, affiliateContextHash }`

この状態は検査済みではない。本文・生成原文・固定contextを保持し、明示再検査で回復できる。
validationFailureはファイル保存失敗ではないため生成台帳はsucceededとする。
ファイル保存失敗は従来どおりsave-failedとなり、保存retryはAPIを再実行しない。
executionIdが既に保存済みなら、そのdraftを返し、編集済み本文・検査結果を上書きしない。

共通のaffiliateValidationStateはnot-applicable / unvalidated / current / stale / invalid / failedを返す。
本文hash・context hash・validationVersionの一致に加え、既知のschema/code/severity/参照/IDを検証する。
checkedAtが新しいだけでは有効にしない。未知の診断値をUIへ返さない。
人間確認や未知フィールドを含む古い結果は再利用せず、再検査時に確認データを破棄する。

本文変更で再検査し、従来の確認済み・publication解除を維持する。
同じ本文・context・検査versionの安全な結果は再利用し、状態変更だけでは再検査しない。
GET・get/list・UI状態計算は読取専用。旧draftは操作時に検査する。
明示再検査はPOST /drafts/:id/affiliate-validation。Origin、単一revision、競合を検証し、
draft自身のcontextだけを使用する。本文・確認済みは変更しない。
Step 5.3以降、検査に束縛されたpublicationは再検査で失効する。

## Step 5.3: 人間確認と公開前チェック

公開準備OKには従来の条件に加え、current、全7項目のblockなし、全warningの個別確認、
案件事実・条件／禁止表現／広告明示／CTAの4確認を必要とする。infoも真偽承認ではない。
検出ゼロでも4確認は必須。純粋validatorのseverityを変更しない。
結果契約はゼロfindingsにも対応し、finding IDの重複は不正とする。

新規検査にはサーバーがaffiliateValidationRunId（UUID）を付ける。既存データは未設定でも読める。
validationFingerprintはschemaVersion、contentHash、affiliateContextHash、validationVersion、
findings全体、checkedAt、runIdをcanonical SHA-256でhash化する。
同じ日時・内容の明示再検査でもrunIdが変わるため、古いフォームの確認を使えない。
hashは署名ではなく変更検出用。

publication.affiliateにschemaVersion、validationState、validationFingerprint、missing、
humanConfirmationを保存する。humanConfirmationは次の契約：

- schemaVersion: 1
- validationFingerprint
- confirmedAt: 全4確認と全warning確認完了時の日時。それまではnull
- requiredChecks: affiliateFacts / affiliateProhibited / affiliateDisclosure / affiliateCtaのboolean
- warningResolutions: findingId、固定reasonCode human-reviewedのみ

公開準備OKは人間の明示ready操作で成立し、check保存の確認完了とは区別する。
warning確認は個別のcheckboxで送信し、一括確認・未知ID・info/block承認・直接データ注入は拒否する。
URLSearchParamsの重複は変換前に拒否し、保存処理内で現在のdraft・fingerprintを再評価する。
診断説明は固定日本語辞書とfield・原文位置のみ。内部情報・URL・本文抜粋は追加しない。

本文編集・再検査では確認を含むpublicationを失効させる。
読取時もfingerprint・保存確認の契約を照合し、古い確認・公開準備OKを表示上で再利用しない。
GETではファイルを書き換えない。旧Step 4 draftは下書きの明示再検査へ誘導する。
案件なしは従来条件を維持する。旧Step 5.2の案件付き公開準備OKは再確認が必要。
現在案件status・期限・conversion・最新revisionの公開判定、コピー直前のサーバー確認、
改善版の根拠継承、投稿は後続Stepに残す。

## Step 5.4: ローカル現在案件チェック

`publication.affiliate.currentOfferCheck` は機械的な記事検査から分離した、公開判定POST時点のローカルstore観測結果です。

- `schemaVersion: 1`, `checkedAt`（ISO日時）
- `offerId`, `fixedRevision`, `currentRevision`（読取不可ならnull）, `conversionId`
- `status`: active / paused / ended / draft / unknown（自由文字列を保存しない）
- `result`: pass / blocked
- `reasonCode`: `lib/current-offer-check.js` の固定辞書のみ

毎回サーバーで最新storeを読み、active・固定revision一致・固定conversion active・期間内・再確認期限内を要求します。validFrom / validUntil / reviewDueAtのnullは既存契約の「期間による制限なし」を維持し、永久有効を保証しません。読取失敗や不正状態はblockします。ASP等への通信は行いません。

ready要求でも現在案件チェックがblockなら、その診断と従来条件の不足を`要修正`として保存し、`readyAt`をnullにします。本文・固定context・validationは変更しません。入力の重複・未知キー・古いfingerprint等は従来どおり拒否し、保存しません。成功したチェックがあっても従来のpreflight・人間確認を省略できません。

GETは過去の保存結果を表示するだけでstore再判定・永続更新を行いません。チェック未保存の旧公開準備OKは再利用しません。コピー直前再確認・store変更時の自動失効は未実装です。チェック直後にstoreが更新される競合も、この段階では防止しません。
