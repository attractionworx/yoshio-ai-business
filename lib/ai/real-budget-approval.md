# Step 6-1A: 限定real枠承認 v1

既存activation v1のrealStopMilliYenがnullの場合だけ、明示承認した正の停止額を一度追加する。
元activation、baseline、generation/extraction ledger、費用・予約を変更しない。
real枠は記事生成と案件抽出で共有するアプリ内停止額であり、API残高ではない。
実Provider、資料入力、API呼出し、unknown解除、再解析、一般policy更新、実restoreは追加しない。

## 永続契約

`schemas/ai-real-budget-approval.schema.json`と`schemas/ai-real-budget-approval-anchor.schema.json`。
`ai-budget/real-approval.json`と`ai-budget/real-approval-anchor.json`をそれぞれimmutableで保存する。
schemaVersion/revision=1、expectedRevision=0。元activation全体hash/revision、元policy version/hash、
金額、承認日時、human_explicit、effective policy/version/hash、承認時snapshot hash、record hashを束縛する。
effective policyは元policyからrealStopMilliYenだけをnull→正値へ変え、versionをlimited-real-v1にする。
simulation枠は維持。既存real枠が正なら追加承認は拒否。二度目・変更・無効化のAPIはない。

元activationとpolicyのvalidatorは変更しない。coordinatorは元activationと承認pairを検証した
effectivePolicyを両AI経路に共通適用する。pairがなければ元policyを使う。pair不整合は全新規AI実行を停止する。
未知・重複ファイル、symlink、部分保存、欠落したtask storeも停止。startup migrationや領域切替はない。

## 確認と競合

GETは金額入力フォームを表示するだけ。POST real-previewで金額を十進文字列から整数milliYenに変換し、
全store lockを既存順序で取得してsnapshot・履歴・参照関係を検証する。unknown、処理中、ローカル保存未確定、
破損、分類不能、残存intent/lock、未参照artifact等の人間確認事項があれば拒否する。
予算合計が新停止額を超えても拒否する。

15分のメモリ内HMAC署名tokenはexpectedRevision、元activation hash、全snapshot hash、金額、有効期限に束縛。
最終POSTはtokenと未チェックの明示確認だけを受け付ける。金額のブラウザ再注入は認めない。
再起動でtokenは無効。最終保存時にlockと全検査を再実行し、snapshot変更・競合は拒否する。
localhost/Origin/cross-site拒否、CSP、no-store、上限付きURL encoded form、固定エラーを維持する。

## 保存不明

同じai-budget lockの下でanchorを先にdurableWriteし、その後recordをdurableWriteする。
両方が有効で一致して初めて許可する。anchorだけ、recordだけ、残存write-intent/tempは停止。
保存失敗をUIは成功と表示せず、自動再試行・削除・補完はしない。再起動は保存されたpairとintentを検証する。
fsync/read-backの既存保証に依存し、OS外の全ファイル消去や全領域巻戻しは検出保証の対象外。

## maintenance互換性

同じai-budget領域に保存するため既存7領域・lock順・manifest schemaVersion 2を維持する。
新v2 manifestはcontracts.realBudgetApproval=1を明記し、pairをallowlistでbackup/integrity/dry-run対象にする。
旧v1/旧v2のcontractsをそのまま受け入れ、旧backupは限定承認の保全対象外と明記する。
旧contractのbackupへ承認ファイルが混入していれば拒否。存在しない承認を推測しない。
実restoreはない。
