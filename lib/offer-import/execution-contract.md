# Step 6-0A：抽出execution v1（fake専用）

## 対象と境界

抽出execution、固定artifact、共通予算、maintenance v2だけを追加する。
資料入力UI・実Provider・記事生成への制約適用はない。
offer v1 / offer-import v1 / regulation extraction v1 / generation ledger v1 / commit audit v1の保存形式は変更しない。
候補は常にpending/unverifiedで作成し、採用・個別出典照合・formal reflection・公開許可をexecution成功と混同しない。
正式案件・成果地点を作らず、active化・公開・投稿・auto mergeを行わない。

## 契約

- `schemas/extraction-execution.schema.json`：ledger v1、executionの全revisionを保存する。未知フィールド拒否。
- `execution-contract.js`：日時・金額・hash・immutable情報・遷移を全履歴で再生検証する。schemaだけでは実行を許可しない。
- `schemas/extraction-artifact.schema.json`：input / validated_extraction v1。UUID、execution ID、時刻、内容hash、UTF-8 byte sizeを照合する。
- `extraction-artifacts.js`：既存documentsとextraction検証を再利用。引用位置はUTF-16、end exclusive、原文完全一致。
- `schemas/ai-budget-activation.schema.json`：policy v1を埋め込むactivation v1。schemaVersion / revision / policy hashを固定する。

executionには対象offer ID/revision、資料metadata・本文hash、artifact参照、request hash、資料/target fingerprint、Provider/model識別metadata、config/prompt/schemaのversion/hash、入力見積・最大予約、承認、開始/終了、外部attempt、response hash、planned/saved import、固定分類のerror、unknown/recovery、予算状態を保持する。
Provider/modelは将来の記録・会計分類用metadataを持てるが、実接続の許可ではない。Step 6-0Aの実行serviceはfakeだけを作成・承認・送信できる。モデル登録や実接続は別Step。
監査は連続revisionのfull snapshotとして保持する。本文をexecution履歴へ重複保存しない。
inputとvalidated extractionはそれぞれ一つのimmutable artifact。自動削除・圧縮・統合はない。

## 状態遷移

```text
prepared → approved → sending → response_received → validated → import_saving → succeeded
prepared / approved → failed_before_request
sending → unknown
response_received → failed_after_request / recovery_required
validated → recovery_required
import_saving → import_save_failed / recovery_required
import_save_failed → import_saving / recovery_required
recovery_required → import_saving / succeeded（人間の明示的なローカル復旧だけ）
```

terminal状態からsendingへ戻る経路はない。approvedでもProvider再送はなく、sendingへの保存成功を確認した処理だけが一度呼ぶ。
同じexecutionの二重操作はexpected revisionと状態で拒否する。メモリロックだけには依存しない。
request hashと、再発行されたdocument IDを除いたtarget+資料fingerprintは重複拒否する。
Step 6-0Aでは失敗後を含め同一資料の再解析を許可する例外はない。将来は新execution＋新承認の専用契約が必要。

## 保存の完了と不明

新基盤とgeneration ledgerの書込みは`.write-intent`を先に保存し、temp/file・directoryのfsync、read-back、intent除去を確認する。
確認できない書込みからProviderを呼ばない。`.write-intent`やtempが残る場合は読み取り・実行・完全バックアップを安全側で停止する。
残存ロックやintentは勝手に削除しない。既存offer/import/commitの原子的保存契約は変更しない。
fsyncは対象OS/filesystemが成功を返すことを前提とする。ハードウェア故障、OS外からのファイル書換え、全領域消失、外部Providerとの原子的処理を保証しない。

sendingの再起動・送信中切断・timeoutは、未送信と推測しない。status/UI/integrityはhuman review required、予約は全月を通じ保持。
明示的なmark_interruptedはsendingをunknownにするだけで、再送しない。
unknownを人間の推測で解除する操作も今回はない。両AI経路の新実行を停止する。
response_received以降は判定可能な使用量を整数単位で計上する。検証失敗でも費用を消さない。
response全文は保存・ログ出力しないため、受信後停止でvalidated artifactがない場合は結果を再現できず停止する。

## import保存と人間復旧

validation成功 → immutable validated artifact → validated revision（planned ID/hashを一度固定）
→ import_saving intent → 既存import store.create → 初期revision照合 → succeeded result。
全体をトランザクションとは呼ばない。

planned content hashは、storeが生成するcreatedAt/updatedAtだけを除いた初期revision全内容のcanonical SHA-256。
確定resultには初期revision全体のhashを別に保存する。最新review revisionを初期revisionの代用にしない。
保存済み候補はpending/unverifiedのまま。AI original / human editedは既存レビュー契約のまま。

- 保存不存在を確認できる場合：confirm＋expected revision付きsave_only。planned IDを変えず、Providerを呼ばない。
- 保存済み初期revision完全一致：confirm付きfinalize_resultだけ。importを再保存しない。
- 不一致・破損・読取不能：停止。上書き・自動修復・根拠削除・mergeをしない。
- intent前に停止：validated artifact/planned情報が確定していれば、明示的にローカル保存のみ再試行可能。
- 書込み結果自体が不明で`.write-intent`が残存：通常の復旧APIも停止。専用の人間調査が必要。

execution結果が未確定のimportは既存レビューとreflection入口で停止する。既存のexecutionを持たないimportの契約は維持する。
これらの復旧APIは内部serviceの契約のみ。管理画面で自動復旧・再送ボタンは提供しない。

## 共通予算の明示有効化

activationがない・破損・部分保存・task store欠落なら、新しい記事生成・抽出を停止する。旧経路へフォールバックしない。
`/maintenance/ai-budget`のGETは読み取りだけ。明示checkbox・revision 0のPOSTで一度だけ有効化する。
既存generation記録は削除・初期化・書換えず、既存費用を引き継ぐ。結果不明・未完了・分類不能なら有効化を拒否する。
存在しないtask storeは、この明示操作に限りempty ledgerとinitializedを作成して欠落検出のanchorにする。
初期費用は当月、予約は全月の合算。既存generationの未解放予約はrunning/unknownに属するため、それがあれば有効化自体を拒否する。
初期generation IDごとの会計hashと集計を保持し、欠落・費用書換えを検査する。
activation途中失敗は再有効化で上書きしない。policy変更・再有効化・migration・残高リセットの経路はない。

Step 6-1Aでは元activationを変更しない限定real承認だけを別記録で追加する。
既存real枠null→正値の一度だけの承認契約は`../ai/real-budget-approval.md`を参照。
一般policy更新・再有効化・migration・残高リセットは引き続きない。

```text
当月generation＋extraction計上済み金額
＋全月generation＋extraction未解放予約
＋今回の最大予約 ≤ 共通停止額
```

新しい残高台帳は作らない。共通lockの下で二つのtask ledgerを集計・予約する。
整数milliyen（0.001円）とBigIntで計算し、legacy decimalは十進文字列から切上げ変換する。
simulationとrealは別bucket。各bucket内で記事生成・抽出を合算する。実費単価・為替は新たにハードコードしない。
fake/mock testsの専用policyは一時fixtureだけで明示有効化する。実運用へ持ち出す価格表ではない。
既存記事生成の個別per-run等の安全制限は追加で維持する。既存生成画面のsummaryは記事生成台帳の情報であり、共通予算の許可判定の代用ではない。
全Providerを合わせ外部実行同時1件。unknown・in-progressは両経路を停止する。外部通信中はfile lockを保持しない。

## lock order

`ai-budget（common） → generations → extraction-executions → extraction-artifacts → offer-import-commits → offer-imports → offers`。
必要なlockだけ、この相対順で取得し、逆順で解放する。既存Step 4のaudit → import → offer順は維持する。
artifact lockは独立immutableファイルの作成に用いる。maintenanceは全既存領域をこの順で固定する。
ロックの競合は拒否し、stale lockを自動消去しない。snapshot inspectionはロックを新設しない。
旧serverを並行稼働させると共通coordinatorを迂回するため、有効化前に旧processを停止する運用が必要。

## privacyと上限

inputは最大256KiB、artifactは最大2MiB（content JSONのUTF-8 bytes）。既存20資料・200候補・20引用の契約は維持。
maxInputTokensはUTF-8 bytesとprompt overheadによる保守的事前検査、response usageも上限検証する。
切り捨て・自動分割・部分候補の完全扱いはしない。秘密形式検出、schema、quote/hash一致が必要。
未知の秘密形式・意味・数値の真実性を機械判定できる保証はない。Step 6-1で送信対象の人間確認が必要。
通常ログへ資料・response・key・cookie・password・token・認証header・raw例外を出さない。
fixtureは架空のみ。real API、.env、実案件、認証ページ、外向き通信は検証で使わない。
実Provider、送信UI、unknown解除、同一資料の明示再解析、policy更新、実restoreは将来の別契約。
