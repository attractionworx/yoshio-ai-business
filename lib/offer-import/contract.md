# レギュレーション取り込み契約 v1 — Step 1

このStepは独立したデータ契約、同期・純粋な検証／レビュー関数、架空fixtureだけを提供する。
store、HTTP/UI、Provider、API実行、予算予約、offerへの変換・保存、公開許可は実装しない。
既存offer v1、検証、保存、公開検証は変更しない。

## 境界と関数

- `validateExtraction(value, documents)`：AI応答形式と人間が指定した資料・根拠を検証し、複製を返す。
- `createOfferImport({ id, targetOffer, documents, extraction, createdAt })`：候補をすべて保留・未確認で作成する。
  ID・日時は呼出側が渡す。候補IDは配列順から取り込み内で決定する。
- `validateOfferImport(value)`：取り込み契約全体を検証し、複製を返す。
- `reviewCandidate(draft, candidateId, expectedRevision, action)`：純粋なレビュー遷移。
  actionは `decision / edited / sourceChecked / at / reason` の5項目だけ。
  現在revisionの一致を要求し、新しい複製のrevisionを1増やす。原本を変更しない。
- `approvedCandidatePreview(draft)`：採用候補だけのレビュー用一覧。
  **offer入力でも公開安全snapshotでもない**。未確認・内部専用も一覧には含まれる。
- `hashDocumentText(text)`：UTF-8本文のSHA-256。
- `reviewContentHash(payload, documents)`：内容と参照資料の変更検出。署名や真偽の証明ではない。

関数呼出しは日時取得、乱数、書込み、ネットワーク、環境変数参照をしない。
モジュール初期化時には固定JSON Schemaのみを読み、既存safeText／ID検証を読取依存として利用する。
返値のネストしたデータも入力から分離する。失敗は入力値を含まない固定文で返す。
検証／操作不正は400、古いレビューrevisionは409。

## AI応答と取り込みdraft

`schemas/regulation-extraction.schema.json` は `schemaVersion: 1` と `candidates` のみ。
各候補は `target / conversionKey / category / text / usage / purpose / evidence`。
AIは正式ID、提供元origin、確認日時、verification、承認状態、offer statusを指定できない。
usageはあくまで**提案**。publishableを提案しても、採用・確認済みにはならない。
全objectで追加プロパティを拒否し、APIの出力契約用にnullableをanyOfで表す。
このStepではAPIへの送信／対応モデルでの実動作確認を行っていない。

`schemas/offer-import.schema.json` は以下を必須とする。

| 項目 | 意味 |
| --- | --- |
| schemaVersion / id / revision | 独立した取り込み識別子・版 |
| createdAt / updatedAt | 呼出側指定のタイムゾーン付き日時 |
| targetOffer | nullなら新規、既存なら案件UUIDと基準revision。存在確認・保存競合検証は後続Step |
| documents | 人間が指定した資料メタデータと必要部分の本文 |
| candidates | AI originalと人間reviewを分離した候補 |

資料は `id / format / label / kind / versionLabel / text / textHash / blocks`。
formatは現段階ではtextだけ。kindは既存source.kindと同じ3種類。
提供元originは資料kindからasp／advertiser／editorへ導出する。
複数提供元の根拠があれば配列で残し、単一originを推測しない。
publicUrl、正式source ID、出典全体のcheckedAt、API実行状態、反映済み記録はこのStepでは持たない。

## 根拠と上限

evidenceは `documentId / blockId / start / end / quote`。
start/endは**資料本文の原文UTF-16位置、end exclusive**。
正規化した位置や推測した引用へ補正しない。block内の実在位置と完全一致する引用が必須。
blockは資料内で一意、配列順で隙間・重複なく本文全体を覆う。
文書hashは原文そのものをUTF-8で計算する。改行や文字表現の変更も検出する。

- 資料1〜20件、各本文100,000文字以下、block1〜1,000件。
- 候補0〜200件、候補本文・引用各5,000文字以下、根拠1〜20件。
- 候補ID・資料ID・block IDはそれぞれの範囲で一意。根拠の同一参照重複も拒否する。
- 後続Stepでは送信全体・トークン・解析範囲・費用の別上限が必要。

quoteの完全一致は対応関係だけを示す。候補textの意味・数字・否定条件がquoteと一致することは
自動保証しない。資料にない主張でも引用が実在すれば未確認候補に残り得るため、人間の照合が必須。

## 分類先

| target | 接続意図と制約 |
| --- | --- |
| name / conversion_name / disclosure_text | 出典欄のない既存項目への変更候補。後続Stepで個別承認・根拠記録が必要 |
| facts | 事実候補。価格・税区分・適用条件を含む本文を保持 |
| targetAudience / sellingPoints | audience / selling_point分類 |
| prohibitedExpressions | prohibition分類、constraint_only、restrictionまたはmarketing_goal |
| eligibility / approvalConditions / rejectionConditions | 対応category、conversion_condition、conversionKey必須 |
| ctaLabel | 成果地点グループを指定したCTA候補 |
| reward_evidence | reward分類、internal_only。金額や通貨の正式rewardは作成しない |
| unmapped | 未分類。purpose=unmapped、internal_only。分類修正前の採用は禁止 |

conversionKeyは資料内のグルーピング用であり、正式成果地点IDではない。
成果地点系targetにのみ必須。それ以外はnull。
marketing_goalは記事・CRの最終訴求目標であり、成果条件に昇格させない。
restriction／prohibitionを公開事実に変換しない。欠落条件、URL、報酬、CTA等を補完しない。
ただし意味解析で分類を保証するものではなく、AIがpurpose自体を誤分類した場合もレビュー対象となる。
一般制約の既存生成への接続可否やデザインの遵守は、この検証の対象外。

## 人間レビュー

reviewは `decision / edited / verification / reviewedAt / checkedAt / confirmedHash / reason`。

- 初期はpending、edited=null、unverified、各確認日時・hashはnull。
- acceptedは登録候補としての採用だけ。sourceChecked=falseならunverifiedのまま。
- sourceChecked=trueはacceptedのみ。候補を個別に照合し、checkedAt=reviewedAtを記録する。
- rejectedは非反映。pendingへ戻すと確認日時・hash・確認済みを解除する。
- editedはoriginalと同じ候補形式。originalを上書きせず、修正版を有効候補とする。
- 修正時にsourceChecked=falseを指定すれば以前の確認を引き継がない。
  trueを再指定する場合は修正版を新たに照合した操作として扱う。
- 確認hashは有効候補の全文・分類・利用区分・根拠と、参照資料の本文hash・提供元・資料名・版・blockを束縛する。
  確認済み内容を直接変更してhashが古くなれば検証を拒否する。
- 資料全体の確認を他候補へ伝播させない。採用・確認・usageはそれぞれ独立。

この純粋関数は人間の本人性や操作権限を認証しない。hashを再計算できる呼出者の偽造を防ぐ署名ではない。
後続HTTP/storeは人間操作の認可、原本・targetOfferの不変性、revision競合、操作履歴を守る必要がある。
previewをそのまま公開根拠に使用してはいけない。正式反映は後続Stepで既存validateOffer／offerStoreを通す。

## 秘密情報

全テキストに既存safeTextを適用し、既知APIキー・Cookie・パスワード・認証付きURL等を拒否する。
既知の管理画面HTML／ログアウト表示の組合せも拒否する。不正値を例外本文へ転載しない。
未知形式の秘密、管理画面全文、一般的な個人情報を完全検出する機能ではない。
資料の必要部分だけを渡し、管理画面全文を入力しない運用が必要。

## 次のStepとの境界

保存・レビューUI・反映差分・正式source/statement IDの対応表・原子的反映復旧・共通予算台帳は未実装。
PDF/OCR、長文分割、重複／矛盾検出、AI解析promptも未実装。
資料や採用済み根拠の保存・保持・削除方針はstore追加前に設計する。
