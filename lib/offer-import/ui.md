# 候補レビューUI — Step 3

Step 1・2のSchema、純粋関数、保存形式、store APIは変更しない。
`server.js`の専用ルートと`ui.js`、`public/offer-import.js`で、保存済み候補だけを人間がレビューする。
このStepには資料入力、AI解析、正式offerへの差分生成・反映、公開許可の操作はない。

## 画面と操作

- `GET /offer-imports`：記録一覧。空の場合も自動fixture投入はしない。
- `GET /offer-imports/:id`：候補、変更しないAI原文、引用・元資料、レビュー状態と版履歴。
- `GET /offer-imports/:id/revisions/:revision`：過去版の閲覧だけ。操作フォームなし。
- `POST /offer-imports/:id/candidates/:candidateId/review`：本文・分類・利用区分の修正と採用／保留／却下。
- `POST /offer-imports/:id/candidates/:candidateId/verify`：保存済み採用候補を人間が照合した記録。

reviewは常にsourceChecked=false。採用も公開用の選択も出典照合済みにはしない。
修正はAI originalを上書きせずreview.editedに保存する。
verifyはacceptedだけに限定し、未チェックの確認欄を明示チェックしてから送信する。
verifyで本文や根拠をブラウザから受け取らず、保存済み候補だけを使う。
個別照合は他候補へ伝播せず、採用済み候補も正式offer／公開許可へ昇格しない。

根拠参照・資料・AI原文・対象案件はUIから変更できない。
分類修正もStep 1検証を通す。成果地点グループは正式成果地点IDではない。
根拠参照の変更が必要なら保留／却下にし、後続の設計で扱う。
JSは入力変更時の案内と照合ボタン無効化だけ。fetch、ローカルストレージ、API接続は使わない。
JSなしでもnativeフォームが使える。照合は常に保存済み候補だけであり、未保存編集は対象外と画面に明記する。

## 安全境界と失敗

既存localhost Host制限、同一Origin必須、cross-site拒否、CSP、no-storeを維持する。
URLエンコードフォームのみ、100,000 bytes上限、必須フィールドの欠落・重複・未知項目を拒否する。
revisionは画面の版を照合し、storeのロック内でも競合確認する。
提供元・確認日時・verification・sourceChecked・original等のブラウザ注入を許可しない。
照合時刻はstoreが付与する。URLや資料中のHTMLは実行・外部参照せずエスケープして表示する。

400/403/404/409/413/415/503は固定の停止画面。送信内容・Providerやfs例外はログ／HTMLへ転載しない。
停止画面には再送／上書きフォームを出さず、最新版再読込を求める。
保存済みで応答だけ失敗した可能性もあるため、503後は失敗と断定して自動再試行しない。
既存の破損記録・残存ロックは自動修復・削除しない。

## 架空デモ・ブラウザ確認

`node scripts/demo-offer-import.mjs`：OS一時フォルダの架空候補をポート3002でレビューできる。
既存data、.env、実APIは使わず、外向き通信をnetwork guardで遮断する。
終了はControl+C。再実行時は別の一時フォルダになる。

`node scripts/browser-offer-import.mjs`：隔離Chromeプロフィールと架空資料で、採用・修正・個別照合・確認解除・
競合停止・履歴・JSなし操作・375/1280pxを検証する。外部ページ要求も遮断する。

Step 4前に、正式source/statement等のID対応、採用済み根拠の保持、反映準備記録とoffer保存の復旧、
追加／置換差分と人間承認、基準offer revision競合を設計・確認する。
このUIのsource_checkedは資料との人間照合であり、広告効果や内容の真実性の証明ではない。
