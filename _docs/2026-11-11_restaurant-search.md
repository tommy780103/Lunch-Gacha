# ジャンル指定・ガチャ結果からの店舗検索

## 目的と仕様

ガチャ結果の料理、または直接選んだジャンルで、口コミ件数が多く評価の高い店舗を検索する機能を追加します。既存のルーレット・食事候補・カスタム入力・通常の Google マップ検索は維持します。ジャンルは既存の 13 候補と任意入力に対応します。

- 初期条件：評価 4.0 以上、口コミ 100 件以上、現在地から 5 km 以内。
- 条件変更：評価・口コミ件数・距離。評価順・口コミ件数順・距離順で並べ替え。
- 検索ボタンを押したときだけ API を 1 回呼び出し、最大 20 候補を取得。絞り込み後に最大 10 店舗を表示。
- 店舗を個別に Google マップで開く導線と、候補リストへのリンクを用意。
- 該当ゼロの場合に条件を勝手に緩めない。API を使わない通常検索は条件未適用と区別する。

## 実装の分担

| ファイル | 役割 |
| --- | --- |
| `index.html` | 既存ルーレットと店舗検索の画面 |
| `config.js` | 検索サーバーの URL・画面側の有効化設定 |
| `search-core.js` | 条件・距離判定・並び替え・リンク生成 |
| `places-search.js` | 検索サーバーへの 1 回のリクエスト・エラー処理 |
| `search-ui.js` | ジャンル選択、ガチャ連携、結果・状態表示 |
| `backend/worker.mjs` | Cloudflare Worker・SQLite Durable Object |
| `backend/server.mjs` / `backend/domain.mjs` | リクエスト検証、共通上限、Google Places REST 呼び出し |
| `backend/wrangler.toml` | Worker 設定・Durable Object のバインディング |
| `privacy.html` / `terms.html` | 公開用の説明ページ |

## 無料枠を前提とする設計

画面は GitHub Pages で静的公開し、検索時は Cloudflare Worker の `POST /search` を経由して Google Places API (New) の Text Search を 1 回呼び出します。店舗検索に必要なフィールドだけを取得し、地図の埋め込み・自動追加取得・自動再試行は行いません。

`config.js` は `searchEndpoint: ''`、`placesEnabled: false` を初期状態にします。サーバーも `SEARCH_ENABLED="false"` にしてあります。未設定時に API 検索が成功したように見せず、通常の Google マップ検索を案内します。Google の API キーは `GOOGLE_PLACES_API_KEY` という Worker Secret にだけ登録し、公開ファイルやブラウザには渡しません。

評価・口コミ件数を含む検索は Text Search Enterprise の対象です。2026 年 11 月 11 日の公式料金表では月 1,000 リクエストが無料ですが、無料利用にも課金設定が必要です。同じ課金アカウント内の同じ料金区分の利用が合算されます。料金・無料枠は将来変更される可能性があります。

全利用者の合計で **1 日 20 回・1 か月 600 回**の上限をサーバー側に設定します。日付・月の境界には `America/Los_Angeles` を使用します。[Google の月次無料枠が米国太平洋時間の毎月 1 日午前 0 時に更新される](https://developers.google.com/maps/billing-and-pricing/overview)ことに合わせたものです。ブラウザの保存データを削除したり、別の端末で利用したりしても、共通カウンターの回数は増え続けます。

- 固定の SQLite Durable Object で日次・月次の回数を保持します。
- Google への送信前に、トランザクション内で両方の上限を確認して 1 回分を確保します。同時アクセスでも上限を超えて確保しません。
- 送信後のエラーやタイムアウトでも回数を戻しません。Google 側で処理・課金されたか判別できない場合を含めて数えます。
- 保存先に接続できない、回数を安全に読み書きできない、上限に達した場合は Google に送信せずに停止します。
- サーバーは自動再試行せず、利用者がもう一度検索した場合だけ新しい回数を確保します。
- 集計データを削除したり、Worker／Durable Object の名前空間を作り直したりすると連続した管理ができなくなるため、運用中は同じ保存先を使い続けます。

Cloudflare は Workers Free プランと SQLite Durable Objects の無料枠を使う想定です。Free の上限を超えると検索を含むリクエストが失敗します。Google の無料枠を他アプリも消費する場合、このアプリの上限だけでは課金アカウント全体の費用は制限できません。予算アラートだけでも利用は停止しません。

有効化には Google Cloud の課金設定、Places API (New) の有効化と API 制限付きサーバーキー、Cloudflare Free アカウントへのログイン・Secret 登録・デプロイが必要です。その後、サーバーを有効化し、画面に `/search` を含む絶対 HTTPS URL を設定します。具体的な手順は [README](../README.md) と [サーバー設定手順](../backend/README.md) にまとめます。サイトのオリジン制限は一般的なブラウザからの利用を制限するもので、API の認証ではありません。外部から上限まで使われた場合も、Google への送信数は共通上限で止まります。

## データと結果の扱い

現在地を使う検索はユーザー操作で実行し、料理・ジャンル、現在地、検索条件を Cloudflare のサーバーへ送り、Google に必要な情報を中継します。店舗結果・現在地・検索条件は処理中のメモリ内で扱い、localStorage やサーバーのデータベースには記録しません。サーバーが永続保存するのは、個人・端末に紐付かない日次・月次の集計回数です。配信・通信事業者は IP アドレス等の通信情報やログを扱うことがあるため、その点もプライバシーポリシーに記載します。Google Maps と返された第三者提供元の帰属表示を結果欄に付けます。

Google の検索が返す候補数には上限があるため、周辺全店舗の完全なランキングではありません。半径による距離条件は直線距離で判断します。API 側の最低評価指定は 0.5 刻みのため、より細かい条件は取得後の判定で扱います。

## 検証状況

テストは `node --test tests/*.test.cjs tests/backend.test.mjs` で実行します。検索条件・通信処理に加え、日次／月次上限、同時要求、日付切り替え、失敗時も回数を戻さない動作、保存先の障害時に停止する動作を対象とします。テストでは Google に実リクエストを送りません。

2026 年 11 月 11 日、サーバー経由への変更後に以下を確認しました。

- 自動テスト 33 件が成功（フロントエンド 18 件、バックエンド 15 件）。
- Wrangler 4.160.0 の `deploy --dry-run` で Worker と Durable Object のバンドルが成功。Cloudflare への公開は実行していません。
- Miniflare 5.20261110.0-beta の実 workerd・SQLite Durable Object で、30 件の同時要求のうち 20 件だけ成功し、10 件を HTTP 429 で拒否。ランタイムを終了・再生成しても保存された 20 回が維持され、追加要求を拒否しました。Google 通信部分だけを架空応答に置き換えたローカル検証です。
- 390 px 幅のプレビューで、架空の 4 候補から条件を満たす 2 件だけを表示。サーバー応答の回数表示と、次の検索で上限エラーになったときの結果非表示・通常検索への案内を確認。
- API 未設定の公開設定は維持。検証用データ・画面・キーは公開対象に含めません。

初回の検索画面実装時には、デスクトップと 390 px 幅の iframe プレビューで次を確認しました。今回のサーバー経由への変更後の検証結果とは区別します。

- API 未設定時の案内と通常検索リンク、狭い画面での折り返し・選択操作。
- テストデータ 5 候補のうち条件を満たす 2 件だけを表示、評価順・口コミ順への変更、0 件表示、上限到達の表示。
- 条件変更だけでは検索せず古い結果が消えること、ガチャ終了後にジャンルが引き継がれること。

Google Cloud の課金設定・API キー・割り当て設定と Cloudflare のデプロイは、この記録の更新時点では未完了または未確認です。実店舗 API 検索と iPhone 実機の動作は未検証です。画面の公開と、設定が必要な店舗検索 API の有効化は別々に行います。

## 参照した公式資料

- https://developers.google.com/maps/documentation/places/web-service/text-search
- https://developers.google.com/maps/documentation/places/web-service/policies
- https://developers.google.com/maps/api-security-best-practices
- https://developers.google.com/maps/billing-and-pricing/pricing
- https://developers.google.com/maps/billing-and-pricing/manage-costs
- https://developers.google.com/maps/documentation/urls/get-started
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/configuration/secrets/
