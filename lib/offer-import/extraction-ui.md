# Step 6-1: 複数テキスト資料からの候補抽出

既存offerまたは人間が`/offers/new`で作成したdraft shellを対象とする。
offer、conversion、active化、source_checked、採用、reflectionをAIで自動作成・実行しない。
offer v1 / offer-import v1 / regulation extraction v1 / extraction execution/artifact v1の保存schemaを変更しない。
価格・modelは今回の人間指定設定であり、この実装検証で実APIや公式価格照合は行わない。

## 導線

- 案件一覧・最新案件詳細 → `/offer-extractions/new?offerId=...`。
- POST `/offer-extractions/prepare`: revisionを固定した対象と1〜20資料を保存。APIを呼ばない。
- GET `/offer-extractions/:id`: immutable input、metadata、instructions、wire schema、全request、設定、見積、共通予算、privacyを表示。
- POST `/offer-extractions/:id/approve`: 未チェックからの明示確認＋署名tokenのみ。
- GET `/offer-extractions`: 実抽出の状態一覧。succeededだけ既存reviewへリンク。

資料はlabel/kind/versionLabel/textだけをフォームから受け取る。IDはdocument番号、blockは原文全体を覆う一つのblock。
hashは原文UTF-8、位置はUTF-16/end exclusive。受信した改行・文字列を正規化しない。
ブラウザのnative formによる改行変換後にサーバーが受け取った文字列を原本とする。
秘密検出・原文引用検証を維持。既知形式の拒否は完全なprivacy検査ではない。
2資料はJavaScriptなしでも入力可能。JSは欄追加/削除/番号付けのみで外部通信・localStorageは使わない。
URL encoded入力ルートだけ2MiB上限を持ち、既存の256KiB artifact上限と64k見積を追加検査する。
既存レビュー等のHTTP上限は変更しない。アップロード、PDF/OCR、URL/認証取得、長文分割はない。

## immutable profileとrequest

`lib/ai/extraction-profile.js`: gpt-6-luna、Responses、Structured Outputs、Standard、store:false、retries:0、120秒。
価格input $0.10/output $0.50 per million、固定160 JPY/USD、16000/80000 milliYen per million。
maxInputTokens=64000、maxOutputTokens=10000。pricing/exchange/estimator/instructions/builderは個別versionを持つ。
profileは深くfreezeし、builder/Provider/profileコード/schemaのSHA-256と全設定をprofile digestへ含める。
configuration.version=`openai-extraction-v1:<profile digest>`。configuration/hashとrequestHashに既存形式で束縛する。
sourceファイル変更はロード済みprofileとのhash照合で停止。未知profileの履歴を自動移行しない。

wire schemaは保存schemaから説明metadataを省き、enumがすでに意味的に指定する型を明示するだけ。
required、追加field拒否、enum、nullable、文字数/件数/数値上限、引用形式は維持する。
意味的分類・引用の対応は既存validateExtractionが必ず再検証する。実API側のschema受理は未検証。

確認画面、見積、Providerは同じ`buildExtractionPayload`とcanonical JSONを使う。
inputには選択したtargetOfferとdocumentsだけを含む。正式案件の他の業務情報は自動追加しない。
実request全体のUTF-8 bytesをBとして`2 * B + 8192`。これは保守的な運用見積であり、厳密token上界ではない。
上限超過は保存/送信前に拒否。切り捨て・部分成功・自動分割はない。
最大予約は`64000 * 16000 / 1M + 10000 * 80000 / 1M = 1824 milliYen`。
概算は推定input＋最大outputで計算。実usageと区別し、usage判明後は既存整数切上げ会計を使う。

## 承認・送信・結果

15分のメモリ内HMAC tokenはexecution ID/revision、request hash、configuration version/hash、
artifact ID/hash/bytes、決定的payload hash、estimate hashに束縛する。再起動で無効。
承認時とsending直前にinput/target revision/config/profile/予算を検証し、sending保存成功者だけ一度Providerを呼ぶ。
provider identityだけで実接続は許可しない。登録済みprofile対応Providerに限定し、fakeサービスの拒否は維持する。

OpenAI Providerは明示注入のSDK clientまたはapiKeyだけを受け、環境変数を自動参照しない。
server直接起動時だけ既存の認証読込導線から供給する。import/testは.envやkeyを読まない。
client生成は送信時だけ。SDK constructorとrequest optionsの両方でretries:0/timeoutを指定する。
toolsは空、web検索なし、Provider自動再送なし。raw response/本文/key/SDK例外はログ・保存へ出さない。
JSON不正・拒否・incompleteでも判定可能なusageを返し、費用計上後に検証失敗とする。
usage不明/上限外、異なるprocessing tier、送信後例外はunknownで予約保持。両AI経路停止。
応答が異なるtierの場合は指定価格で課金を判定できないためunknownとする。
import保存失敗後の復旧は既存save_only/finalize_result契約のみで、Providerを再呼出ししない。
通常画面に再送・再解析・unknown解除・自動復旧ボタンは提供しない。

共通予算はStep 6-1AのeffectivePolicyを使う。nullなら送信不可。実API残高とは別のアプリ内停止額。
候補はpending/unverifiedのみ。succeeded結果照合後に既存review→source_checked→reflectionを使用する。
mixed origin等のreflection除外は変更しない。記事生成への規約適用、Step 7、実restoreには進まない。

## 検証

SDK stub・OS一時fixture・network guardのみ。実データ領域のreal枠有効化、実API、.env、認証ページは使わない。
`test/openai-extraction.test.js`、`test/extraction-http.test.js`、`scripts/browser-offer-extraction.mjs`。
maintenanceは既存v2に追加schemaなしで実抽出のprofile/input/estimate/usage/import対応を検証する。
