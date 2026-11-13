# お店検索 API と共有利用上限

画面の静的資産と検索 API を同じ Cloudflare Worker から配信し、Google Places API (New) はサーバーからだけ呼び出します。1 つの SQLite Durable Object に全ユーザー共通の利用回数を保存し、**1 日 20 回・1 か月 600 回**で Google へのリクエストを止めます。現在のコードは検索を有効にする構成です。キー未登録、上限到達、カウンター保存障害の場合はGoogleを呼びません。

```toml
SEARCH_ENABLED = "true"
```

## 本人限定のアクセス設定

Worker単位のCloudflare Accessを「All traffic」で設定し、本人メール1件だけをAllowにします。本番URL、静的資産、検索APIをまとめて保護します。メールアドレスや認証方式はCloudflare側で管理し、コードには埋め込みません。不要なプレビューURLは設定ファイルで無効にします。アカウント全体や他のWorkerのAccess設定は変更しません。

旧GitHub Pagesの公開を停止し、新しいサイトのトップページ・静的資産・検索APIのすべてが未認証で拒否されることを確認してください。CORSのOrigin制限だけでは本人限定にはなりません。[公式のWorker向けAccess手順](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)を参照してください。

画面の公開先と検索API：

```text
https://lunch-gacha-search.choi-tool.workers.dev/
https://lunch-gacha-search.choi-tool.workers.dev/search
https://lunch-gacha-search.choi-tool.workers.dev/quota
```

静的資産はビルドスクリプトが13ファイルの許可リストから生成します。画面や設定の変更後、デプロイ前に次のコマンドを必ず実行してください。Wranglerは生成済みの資産だけをアップロードします。

```sh
node scripts/build-worker-assets.mjs
```

## 初回設定

新しい環境を準備する間はサーバーを次の設定にし、画面側の検索も無効にしておきます。既存環境で検索を停止する場合も、この設定へ戻して再デプロイします。Durable Objectと保存済みカウンターは維持してください。

```toml
SEARCH_ENABLED = "false"
```

1. Google Cloud で Places API (New) と請求先を設定します。検索に評価・口コミ件数を含めるため、Text Search Enterprise の無料利用枠が対象です。利用前に[最新料金](https://developers.google.com/maps/billing-and-pricing/pricing)と同じ請求先アカウントの他プロジェクトの使用量を確認してください。
2. このバックエンド専用の API キーを用意し、API の制限を Places API (New) のみにします。ブラウザー向け HTTP リファラー制限はサーバーからのリクエストには使いません。キーを HTML、GitHub、チャットに記載しないでください。
3. Cloudflare の **Workers Free** アカウントで作業します。この構成は Free で利用できる SQLite Durable Objects を使います。Paid プランへの変更は不要です。Free プランの上限超過はエラーになりますが、Paid プランは従量課金の対象です。[公式の制限と料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)を確認してください。
4. リポジトリのルートでログイン、無効状態でのデプロイ、秘密情報の登録を行います。

```sh
npx wrangler@4.160.0 login
```

```sh
npx wrangler@4.160.0 deploy --config backend/wrangler.toml
```

```sh
npx wrangler@4.160.0 secret put GOOGLE_PLACES_API_KEY --config backend/wrangler.toml
```

秘密情報は `secret put` の対話入力で登録します。`.dev.vars` や `.env` は Git に含めません。コマンド引数にキーを直接書かないでください。

5. Google Cloud の割り当てもこのアプリ専用プロジェクトで可能な範囲まで絞ります。請求予算のアラートだけではリクエストは止まりません。Google 側の割り当ては追加の防御であり、この API の共有カウンターがアプリ単位の上限を担当します。
6. 上記を確認後、`backend/wrangler.toml` の `SEARCH_ENABLED` を `"true"` に変更して再デプロイします。

```sh
npx wrangler@4.160.0 deploy --config backend/wrangler.toml
```

7. 同じWorkerの検索APIの絶対HTTPS URLを画面側の設定に登録して有効化し、再デプロイします。許可OriginもそのWorkerのHTTPSオリジンに合わせます。画面からの検索では同じオリジンにだけAccessの認証Cookieを送信し、別オリジンへのCookie送信は許可しません。

## 上限の保証範囲

- 全ブラウザー、全ユーザー、ガチャとジャンル検索を合算します。ブラウザーの保存内容を消しても回数は戻りません。
- 日・月の更新は Google の請求基準に合わせた `America/Los_Angeles` の暦です。日本時間の 0 時には更新されません。夏時間も考慮します。
- 永続ストレージのトランザクションで日・月を同時に 1 回分予約し、保存完了後に Google を 1 回だけ呼びます。失敗・タイムアウトも消費し、再試行・追加ページ取得・払い戻しは行いません。
- 状態が不正、ストレージが利用不能、キー未登録、検索無効の場合は Google を呼びません。検索結果は保存・キャッシュしません。
- 日 20 回と月 600 回はサーバーコードに固定してあります。クライアントから変更できません。回数をリセットする API もありません。
- **600 回はこのアプリからの呼び出しだけの上限です。** Google の無料枠は請求先アカウントの他プロジェクトと合算されるため、他での利用や将来の料金改定まで含めた請求額 0 円を保証するものではありません。
- Originの照合はブラウザーの CORS 制限であり、認証ではありません。本人限定の認証はWorker単位のCloudflare Accessで実施します。認証後のリクエストにも、共有上限を適用します。

**同じ月の途中で Durable Object の名前・クラス・バインディング・Worker を作り直したり、保存済み状態を削除したりしないでください。** 初回の未作成状態と管理者によるデータ削除は区別できません。新しいオブジェクトを作ると使用済み回数を引き継げないため、無効にしたまま次の請求月を待つか、使用済み回数を保つ管理用移行が必要です。通常のコード更新では既存のオブジェクトを維持します。別環境で有効にすると別カウンターになるため、このキーで並行稼働させないでください。

## API

`POST /search`。`Content-Type: application/json`、本文は最大 4 KiB です。

```json
{
  "genre": "ラーメン",
  "origin": { "lat": 35.68, "lng": 139.76 },
  "criteria": { "minRating": 4.2, "minReviews": 100, "radiusKm": 5, "sort": "rating" }
}
```

Google では最小評価を 0.5 刻みに切り下げて検索し、最大 20 件を返します。口コミ件数、正確な評価閾値、現在地からの円形距離の絞り込みはフロントエンドの `search-core.js` が行います。Google の全店舗を取得・比較するものではありません。

距離の省略時既定値は1kmです。明示した5kmなどの値はそのまま使用します。複数ジャンルは画面側でこのAPIをジャンルごとに直列で呼び、各リクエストに既存の共有上限を適用します。1操作を1回と数えるのではなく、Googleへの1検索を1回として管理します。

評価・口コミの「指定なし」はそれぞれ0で指定します。評価0の場合はGoogleへの最小評価指定を省略します。評価3.5、口コミ1,000件、距離0.1km・0.5kmにも対応します。未掲載の評価や口コミ件数は、その項目が「指定なし」の場合だけ画面の絞り込み対象に残します。

成功時は `places` と `quota` を返します。店舗の `displayName` は文字列、`location` は `{lat,lng}`、出典は `{provider,providerURI}` に変換します。

```json
{
  "places": [],
  "quota": { "dayUsed": 1, "dayLimit": 20, "monthUsed": 1, "monthLimit": 600 }
}
```

エラーは `{ "error": { "code": "...", "message": "..." }, "quota": { ... } }` です。`quota` は値が分かる場合だけ付けます。

### 使用回数の読み取り

```text
GET /quota
```

同じ共有カウンターから日・月の使用回数を取得します。Google呼び出し、回数の加算、保存データの更新・削除は行いません。検索の停止中やキー未登録でも読み取り可能です。Cloudflare Accessによる認証は必要です。

```json
{
  "quota": { "dayUsed": 2, "dayLimit": 20, "monthUsed": 2, "monthLimit": 600 }
}
```

現在の米国太平洋時間の期間に合わせた値を返します。未作成状態だけを0として扱い、不正な保存値・未来の期間・ストレージ障害では503を返します。日月の切替判定で保存値を書き換えることはありません。応答はキャッシュしません。同一オリジンのGETで省略されるOriginヘッダーはこの経路だけ許容し、明示されたOriginは許可オリジンとの完全一致を要求します。検索POSTのOrigin検証は従来どおりです。

画面は月の使用回数、月の残り回数、日の残り回数を表示します。古い読み取り応答が検索後の新しい使用回数を上書きしないよう管理します。回数取得の失敗は未確認として表示し、利用枠が満杯に戻ったようには表示しません。

| code | HTTP | 意味 |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | 条件・本文が不正 |
| `FORBIDDEN` | 403 | 許可した Origin 以外 |
| `NOT_CONFIGURED` | 503 | 無効または未設定 |
| `QUOTA_EXCEEDED` | 429 | アプリまたは Google の上限に到達 |
| `NETWORK` | 503 | 接続失敗・タイムアウト |
| `REQUEST_FAILED` | 502 / 503 | Google のエラー、応答不正、状態・保存の問題 |

## 検証

```sh
node --test tests/backend.test.mjs
```

```sh
npx wrangler@4.160.0 deploy --dry-run --config backend/wrangler.toml
```

テストはモックの Google 応答とトランザクションストレージを使い、実 API を呼びません。並列リクエスト、日・月上限、夏時間を含む期間更新、再起動後の回数、失敗時の消費、保存失敗時の停止、クライアントによる設定上書き拒否、サイズ不明のストリーム本文の制限を確認します。実際のキーによる疎通は初回設定後に必要で、1 回分を消費します。

参照: [Text Search (New)](https://developers.google.com/maps/documentation/places/web-service/text-search)、[SQLite Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Google Maps 利用上限管理](https://developers.google.com/maps/billing-and-pricing/manage-costs)

