# Step 5 / Step 6-0A：ローカルデータ保全（実復元なし）

## 範囲と既存契約

案件編集・候補レビューとは別の `/maintenance` 管理画面を追加する。
Step 1〜4のschema、offer/import保存API、公開検証、intent → offer保存 → resultは変更しない。
復元・巻戻し・自動修復・自動マージ・履歴削除・公開・active化の経路はない。
バックアップは企画や生成結果を含むアプリ全体のバックアップではない。
v1対象は案件・取り込み・反映監査の三領域。Step 6-0Aのv2はAI実行・固定artifact・共通予算を含む。`.env` や任意のルートファイル、独立した企画・draftファイルは取得しない。generation ledgerに含まれる既存のstaged content・planSnapshotは原本の一部として保全する。

## 一貫バックアップ

`maintenance-backups/<UUID>/` は以下の単位で保存する。

- `manifest.json`：固定契約（下記）。
- `manifest.sha256`：manifestの実バイト列のSHA-256＋改行。
- `payload/offers/<UUID>.json`：全offer revisionを含む既存の原本。
- `payload/offer-imports/<UUID>.json`：全import revisionを含む既存の原本。
- `payload/offer-import-commits/{ledger.json,initialized}`：全intent/resultと初期化記録。

存在しない領域はmanifestに明示する。空の既存領域は空ディレクトリとして保存する。
正常な空データも扱える。source側の存在しないディレクトリは作成しない。
既存ファイルのバイト列とIDをそのまま保全し、履歴を圧縮・削除・統合しない。

バックアップ専用 `.lock` に加え、既存領域の `.lock` を
`offer-import-commits → offer-imports → offers` の順で取得する。
Step 4と同じ取得順であり、他の保存処理を変更せず競合時は409で停止する。
存在しなかった領域が処理途中で出現した場合も停止する。
全ファイルを二回取得して一覧・hash・ディレクトリ状態の変化を検出する。
バックアップ処理だけは取得したロックを保持したままコピー完了まで進める。
ロックは自分が取得したものだけ逆順で解放する。残存ロックは勝手に消さない。

一旦 `.incomplete-<UUID>` 内へ保存し、コピーのhash、manifest・digestの保存を検証後、
最終UUIDディレクトリへrenameする。コピー・保存・検証が失敗したものは一覧の完全バックアップに載せない。
未完了領域は人間確認のため残す。自動削除・再試行・推測による再実行はしない。
破損schema・秘密情報検出・参照不一致等のerrorがある原本はバックアップ作成を停止する。
契約上有効な未解決intentは保全可能だが、正常性とコピー完了を混同せず人間確認必須と表示する。

### Manifest v1

全項目必須、未知項目拒否。

| 項目 | 固定した意味 |
| --- | --- |
| schemaVersion | `1` |
| kind | `offer-operations-backup` |
| id | 保存先と一致するUUID |
| createdAt | UTCミリ秒ISO日時 |
| contracts | 厳密に `{offer:1, import:1, commit:1}` |
| directories | 上記ロック順の3件。各 `{path, present:boolean}` |
| files | 各 `{path, size, sha256}`。重複禁止、取得元の許可パスだけ |
| totalBytes | 全対象ファイルのsizeの合計 |
| snapshotHash | directoriesと、path順に並べたファイルのpath/size/SHA-256をJSON化したSHA-256 |
| integrityStatus | コピー時の `normal / warning / error / human_review_required` |

全体manifestに加えファイル別hashとsnapshotHashを確認する。
hashは破損検出用であり、同じOSユーザーによるmanifestとdigest両方の再生成に対する署名ではない。
バックアップはローカルの平文で、保存先0700・新規ファイル0600。
他ディスクへの保全、暗号化、真正性証明は今回の対象外。
renameは完全トランザクションや停電時の永続性保証を意味しない。
起動後の利用前にもdry-runで検証する。offer/import/commit保存層のfsync契約は変更しない。Step 6-0AのAI記録ではfile/directory fsyncと未完了write intentの検出を行う。

## Manifest v2（Step 6-0A）

既存v1の読み取り・厳密検証をそのまま残し、書換えない。
v1は旧範囲として正常でも、AI実行・共通予算の有効化を保証しない。dry-runでcoverageと注意を表示する。
AI領域が存在する場合、新規バックアップはv2を作る。全く存在しない旧環境ではv1を維持する。

v2は同じmanifest項目を持ち、schemaVersion=2、contractsは
`{offer:1, import:1, commit:1, generation:1, extractionExecution:1, extractionArtifact:1, budgetActivation:1, budgetPolicy:1}`。
directoriesの固定順は `ai-budget → generations → extraction-executions → extraction-artifacts → offer-import-commits → offer-imports → offers`。
これが新しい共通lock順であり、既存三領域の相対順は変えない。
新たに許可するファイルは、ai-budgetのactivation.json/initialized、generation/extractionのledger.json/initialized、artifactのUUID.jsonだけ。
activation内にpolicyを固定保存する。未知パス・write intent・temp・残存lockは停止する。

検査ではgeneration会計、execution全遷移、artifact hash/byte size/対応、既存target offer revision、
validated extractionのquote、planned import内容hash、saved import初期revision/hash、
activation policy hashと初期generation会計を照合する。未解決execution・unknownは人間確認必須。
v2内に必要なtask anchorがない場合も停止し、欠落を空台帳と解釈しない。
AI領域を含むbackup/dry-runでも実restore・自動修復・履歴削除は行わない。

Step 6-1Aでは同じv2の7領域を維持し、新しいmanifestのcontractsに`realBudgetApproval:1`を追加する。
`ai-budget/real-approval.json`と`real-approval-anchor.json`を保全し、元activationとのhash束縛とpairを検証する。
旧contractsのv2もそのまま読み取り、限定real承認の保全対象外とdry-runで明示する。
旧contractsへ承認ファイルが混入したbackupは拒否する。新contractでも承認pairがなければ追加承認なしと表示する。
片方だけ・hash不一致はerror。write intent/temp等の未知ファイルは従来どおり完全backupを停止する。
限定real承認の契約は`../ai/real-budget-approval.md`を参照。

## 読み取り専用integrity check

ソースにロック・ディレクトリ・記録を作成しない。
二回取得したデータのhash・一覧が一致しない、更新ロックがある、読み取りが不完全なら停止する。
これは保存処理と協調する保守検査であり、OSユーザーの直接ファイル編集に対する完全なトランザクションではない。

既存validateOfferと同じoffer履歴条件を検証する。
import履歴は既存Step 2ストア、監査は既存Step 4ストアへメモリFSを渡して検証する。
それらの書込みAPIを呼ばず、既存の厳密な履歴再生・preview hash照合を再利用する。
その上で以下の実ファイル間参照を照合する。

- import.targetOfferのID/revisionが存在する。
- intentのimportSnapshotと当該import revisionが完全一致する。
- intentのofferSnapshotと反映前offer revisionが完全一致する。
- committed resultの予定revisionが存在し、business内容が承認planと完全一致する。
- 未解決intentは「予定revisionと一致」または「現在も反映前snapshotと完全一致」なら復旧可能性あり。
  ただし人間確認必須であり、この検査ではresultを追加しない。
- それ以外の未解決intentは判定不能として停止する。
- not_appliedのresult以前に同内容の予定revisionがある場合は判定不能として停止する。
- `imp-<import UUID>-d<N>` の生成出典IDに対応する資料・intentも検証する。
  監査領域丸ごとの欠落や生成IDの手動模倣を正常と判定しない。
  任意ファイル群が丸ごと削除され、参照・外部証跡も一切残らない事象は検出できない。

表示状態は正常・warning・error・human review requiredを区別する。
復旧分類は正常・復旧可能性あり・人間確認必須を区別する。
errorと判定不能状態は停止。勝手なロック削除・履歴修復・result追記はしない。
既存の個別監査復旧画面への読み取り導線だけを提供する。
出典の実世界での正しさや、公開許可を新たに認定する機能ではない。

件数、全履歴revision数、監査イベント数、実バイト数、検査時間を返す。
途中で検査できない場合、未確定の件数を正常な測定値として表示しない。
メモリ処理の安全上限はファイル10,000件、1ファイル64MiB、対象全体256MiB。
上限超過は停止して人間確認とし、切り詰め・削除・圧縮で解決しない。

## 復元dry-run

バックアップIDのUUIDだけ受け付け、任意パス、未知フィールド、重複フォーム項目を拒否する。
未知version、manifest改変、ファイル欠落・追加、サイズ/hash不一致、重複パス、
path traversal、シンボリックリンクを拒否する。
manifestと実内容を照合後、同じメモリ上の全履歴・参照検査を行う。
現在データとのsnapshotHashの違いは古いバックアップの可能性としてwarningを表示し、停止する。
バックアップの正常性と現在データの一致は別の判定であり、古いだけでバックアップを破損とは断定しない。
未来日時もwarningにする。

dry-runは何回実行しても正式offer/import/commitやバックアップに書き込まない。
`restored:false` を返し、「復元済み」を保存しない。revision・履歴は増えない。
実復元メソッド・HTTPエンドポイントは存在せず、restore要求は404。
GET表示だけでバックアップを作成しない。作成は明示checkboxを確認したPOSTだけ。
全管理POSTは既存localhost・厳密Origin・cross-site拒否・CSP・HTML escapeを維持する。
エラーにはFS例外や入力値を表示・ログ転載しない。

## Fixtureによる実行

全テスト：`npm test`（既存network guardで外向き通信を拒否）。
専用デモ：`node scripts/demo-maintenance.mjs` → `http://127.0.0.1:3004/maintenance`。
Chrome確認：`node scripts/browser-maintenance.mjs`。
両スクリプトはOS一時領域の架空fixtureだけを使用し、server.jsのmain起動を通さない。
実案件、`.env`、OpenAI/ASP実APIを使用しない。
Chromeは専用プロフィール、背景通信無効化、外部DNS拒否、ページリクエスト遮断を使う。
375px/1280pxの画像と検証結果は一時領域へ保存する。

## 将来の別Stepに残すもの

実復元は、人間の明示承認、現在revision競合、対象選択、復元前バックアップ、
途中失敗、再実行・二重復元防止、復元監査の専用契約を設計してから実装する。
バックアップの外部媒体保全・暗号化・署名、停電耐性、256MiB超のストリーミング検査、
履歴保持方針と複数端末対応は未実装。Step 6以降には進まない。
