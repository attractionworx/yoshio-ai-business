# 正式案件への反映 — Step 4

Step 1〜3の取り込みSchema、純粋レビュー契約、保存形式、store APIは変更しない。
既存offer v1、offerStore、案件・公開検証は変更せず、正式保存はofferStore.updateだけを通す。
既存の実API／生成設定には接続しない。

## 反映対象とプレビュー

projection.jsは採用・個別source_checkedの候補だけを投影する純粋関数。
unverified、保留、却下、反映済みを理由付きで除外する。
候補のusage、category、提供元と出典参照を保持し、制約や内部専用情報を公開用に変えない。
事実・読者・訴求点・禁止事項・成果条件等の配列は追加だけ。既存項目の自動削除・意味的統合はしない。
名称・広告明示文・CTAの置換は変更前後を表示する。名称・広告明示文はpublishable候補に限定する。
status、有効期間、ASP、報酬額、URL、広告明示の必須設定・位置は自動変更しない。
最終inputを既存validateOfferで検証する。active要件に反する追加は停止し、自動でdraftへ降格しない。

反映先は既存offerのみ。targetOffer=nullでも人間が反映先を選ぶ。
targetOfferがある場合はそのIDだけを許す。取り込み作成時のtargetOffer.revisionは履歴情報として保持し、
新しいプレビューは現在の正式案件revisionを使う。古い承認を新しい版へ自動で引き継がない。
成果地点はグループと既存conversion IDを人間が明示対応させる。名称から推測・新規作成しない。
構造化したrewardを安全に作れない報酬根拠、未分類、複数originを推測する必要がある候補は除外する。

GETプレビューは読取のみ。候補ID、field、正式ID、前後値、usage、source IDs、citation、除外理由を表示する。
反映後input全体も確認できる。意味の重複／矛盾は機械的に保証しないため、既存情報も人間が照合する。
全候補が除外された場合は承認フォームを表示しない。

## 承認と競合

サービスが15分有効のHMAC署名付きトークンを発行する。署名鍵はメモリ内だけで、再起動後は再プレビューする。
トークンはimport ID/revision、offer ID/revision、成果地点対応、プレビューhash、実行UUIDに束縛する。
planには取り込み・正式案件の全文snapshot hashを含む。承認時に再投影し、内容hashの一致を要求する。
ブラウザからinput、確認状態、ID対応、出典を受け取らず、署名トークンと明示チェックだけを受け取る。
未保存のレビュー画面編集は使わない。GETや確認欄の初期状態では保存しない。

ロック順は反映監査台帳 → 既存取り込み.lock → 既存offerStoreのロック。
importロックを正式保存と結果記録の間も保持し、レビュー競合を拒否する。
offer revisionは承認直前とofferStore.update内部で照合する。
別の手入力更新がその間に入った場合も自動マージせず、intentを未解決として止める。
未解決intentが1件でもある場合、新しい反映は全案件について停止する。
ロック・破損記録の削除、上書き、API再実行などの自動復旧は行わない。

## IDと監査

source IDは `imp-<import UUID>-d<文書番号>`、statement IDは `imp-<import UUID>-candidate-<番号>`。
取り込み原本の文書順・候補IDはStep 2で不変。既存IDは変更しない。
scalar項目はIDなし、成果地点名称には既存conversion IDを対応づけ、正確なfield pathを記録する。
既存の同一IDが別用途で使われていれば停止する。
同じ資料のsource再利用は、過去の完了記録と既存sourceの一致が確認できる場合だけ許す。
同一import内の候補は、取り込みrevisionや本文が後で変わっても一度だけ反映する。
訂正は既存案件の手入力等で行い、同じ候補の再反映を自動許可しない。

`<dataDirectory>/offer-import-commits/ledger.json` は独立した監査envelope：
`{ schemaVersion: 1, events: [...] }`。取り込み履歴へ反映フラグを追加しない。
eventsは以下のみで、追加保存する。以前のevent・案件・取り込みrevisionを書き換えない。

| event | 内容 |
| --- | --- |
| intent | commit UUID、時刻、preview hash、import/offer snapshot、対応選択、投影plan |
| recovery_required | offer保存処理が失敗／結果不明になったこと。保存できない場合も未解決intent自体が復旧要求 |
| result | committedまたはnot_applied、予定offer revision、時刻、save/recoveryの区別 |

plan.mappingsにcandidate ID、field、正式ID、source IDs、usage、個別照合日時、citationを保持する。
完全な元資料はintent.importSnapshotに残る。正式offerのsource.labelにもimport/文書IDを記載する。
台帳読取時は未知項目・ID重複・不正状態遷移を拒否し、snapshotからplanを再投影して一致を検証する。
台帳も一時ファイル0600からrenameで置換し、ディレクトリ0700、別プロセスロックを使う。
初期化マーカー後の台帳消失では空の台帳にリセットしない。

## 保存途中の失敗・復旧

1. 承認・revision・hashを検証する。
2. intentを永続保存する。失敗した場合は正式offerを更新しない。
3. 既存offerStore.updateで新revisionを作る。
4. 保存された業務項目と予定revisionの一致を確認し、resultを記録する。

3での失敗は結果不明として停止し、可能ならrecovery_requiredを記録する。
4の保存失敗は既にrename済みかもしれないため、古いメモリ状態を使った追加書込みを行わない。
結果記録がないintentは復旧要求として表示する。resultが既に保存されていた場合は再読込で確認できる。
どちらの場合も正式offerを自動再保存しない。

復旧GETはintentと現在のoffer履歴を読んで、以下の厳密な照合結果だけを表示する。

- 予定revisionの業務項目がplan.inputと完全一致：committedの記録を確定可能。
- 最新revisionが承認前のsnapshotと完全一致：not_appliedの記録を確定可能。
- それ以外／履歴不明：判定不可。確認ボタンなし。バックアップ・履歴の人間確認が必要。

POSTの明示承認時にも再照合する。復旧はresult追加のみで、offer保存・巻戻し・候補再反映はしない。
未解決intentや残存ロックは一般の案件編集／公開検証を改変するものではない。
正式案件への保存自体は公開許可ではなく、既存記事はrevision不一致による最終コピー停止を維持する。

この方式は複数ファイルの完全トランザクションではない。電源断に対するfsync保証、履歴全体の悪意ある
再構成・切詰めを防ぐ電子署名、監査ディレクトリ全体の外部削除の検知は提供しない。
バックアップはoffers・offer-imports・offer-import-commitsを一緒に扱う。
判定不能な不整合や初期化途中の台帳消失を推測で修復しない。

## UI・検証

レビュー画面からreflectionへ進み、明示POST commitで保存する。commitsは監査／復旧確認、recoverは結果確定。
localhost、同一Origin、cross-site拒否、CSP、no-store、HTMLエスケープを維持する。
承認フォームはtoken/confirmだけ、欠落・重複・未知項目は拒否。30,000 bytes上限。
エラー画面は送信値・fs例外を表示／ログへ転載せず、再読込・再プレビュー・復旧確認を案内する。

架空デモ：`node scripts/demo-offer-reflection.mjs`（ポート3003、毎回OS一時フォルダ）。
専用Chrome検証：`node scripts/browser-offer-reflection.mjs`。
どちらも実案件・.env・実APIを使わず、network guardとブラウザ側の外部要求遮断を使用する。

Step 5前に、監査の保持・バックアップ／手動復旧、長い履歴の容量・性能、報酬の構造化、複数提供元、
新規案件・成果地点、意味的な重複／矛盾の扱いを確認する。
AI接続時の料金・共通予算・明示実行は別Stepであり、この反映機能に実API呼出しは追加しない。
