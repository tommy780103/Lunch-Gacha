# きょうめし

まわして決める。選んで探す。

今日の食事をルーレットで選ぶ Web アプリです。画面と検索 API を同じ Cloudflare Worker から配信し、Cloudflare Access で本人のメールアドレスだけを許可する構成です。ジャンルを直接選び、評価・口コミ件数・現在地からの距離でお店を探すこともできます。

ガチャの初期選択は「ラーメン・うどん・定食・パスタ・中華」の5つです。他の候補もボタンで追加・解除できます。「コーヒー」はガチャとお店検索の両方にあり、ガチャでは最初は未選択です。

「ルーレット」タブでは、食事に限らない任意の項目を1行ずつ入力して抽選できます。このタブでは見出しとブラウザータイトルが「ルーレット」になり、きょうめしの副題、店舗検索への案内、検索利用回数は表示しません。「ガチャ」「お店検索」に戻ると食事選びの表示へ戻ります。

[本人用サイト](https://lunch-gacha-search.choi-tool.workers.dev/)

## 構成

- メイン画面・スタイル・ルーレット：ルートの HTML。
- 配信資産：専用スクリプトが画面に必要な13ファイルだけを生成先へコピーします。バックエンド・文書・秘密情報は配信対象に含めません。
- 店舗検索：ブラウザから Cloudflare Workers を経由して Google Places API (New) を呼び出します。
- 共通の利用上限：SQLite Durable Object で全利用者の合計を管理します。
- 公開設定：画面と同じWorkerの検索URLを設定し、店舗検索を有効にする構成です。API キーはサーバーの Secret にだけ保存します。
- アイコン：アイコン用フォルダー内の SVG が正本。PNG は iPhone ホーム画面用 180 px、汎用 192 / 512 px、favicon 用 48 px。
- 再生成：Python スクリプトから ImageMagick を呼び出します。
- 作業記録：実装記録フォルダーに保存します。

```text
index.html
config.js
search-core.js
places-search.js
search-ui.js
search.css
privacy.html
terms.html
backend/worker.mjs
backend/server.mjs
backend/domain.mjs
backend/wrangler.toml
backend/README.md
icons/app-icon.svg
icons/apple-touch-icon.png
icons/icon-192.png
icons/icon-512.png
icons/favicon.png
scripts/generate_icons.py
scripts/build-worker-assets.mjs
public/                  # 配信用の生成物。Gitには含めません
_docs/
```

## 起動・確認

プロジェクトのルートで実行します。

```sh
python3 -m http.server 8000
```

ブラウザーで次を開き、ルーレットが表示されることを確認します。

```text
http://localhost:8000/
```

アイコンの再生成には Python 3 と ImageMagick が必要です。

```sh
python3 scripts/generate_icons.py
```

PNG の寸法と透明度は次のコマンドで確認できます。

```sh
magick identify -format '%f: %wx%h %[opaque]\n' icons/*.png
```

iPhone では Safari で公開サイトを開き、「共有」から「ホーム画面に追加」を選びます。以前追加した文字だけのアイコンが残る場合は、既存のホーム画面アイコンを削除して追加し直します。角丸の切り抜きは iOS が行うため、元画像は四隅まで不透明です。

2026 年 10 月 17 日時点で PNG の寸法・不透明性・見た目と HTML の参照を確認済みです。iPhone 実機での再追加と表示は未確認です。

## テスト

```sh
node --test tests/*.test.cjs tests/backend.test.mjs
```

## 本人限定で配信する

Cloudflare Workers の対象 Worker で Access の保護範囲を「All traffic」にし、Allow ポリシーの Emails には本人のメールアドレス1件だけを登録します。メールドメイン全体・Everyone・Bypass は許可しません。メールアドレスや認証情報は公開コードに記載せず、Cloudflare側で管理します。[Worker単位のAccess設定](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)を参照してください。

トップページ・画像・JavaScript・検索 API のすべてがログインを要求することを確認します。以前の GitHub Pages はリポジトリの Pages 設定で公開を停止し、旧URLから画面を開けないことも確認してください。リポジトリのソース公開と、利用サイトのアクセス制限は別の設定です。

デプロイ前に次のコマンドで静的資産を生成します。画面や設定を変更した場合も、必ず再実行して生成物を更新してください。スクリプトは自身の配置場所を基準に入出力を解決します。

```sh
node scripts/build-worker-assets.mjs
```

生成後に同じ Worker をデプロイします。Worker や Durable Object を作り直さず、既存の共有カウンターを維持します。

```sh
npx wrangler@4.160.0 deploy --config backend/wrangler.toml
```

画面側の検索通信は同じオリジンにだけ認証Cookieを送信します。認証の有効期限が切れた場合はページを開き直して再ログインしてください。検索機能の有効化は、Access の設定とは別に下記の手順で行います。

## お店の検索

- ガチャで選ばれた料理から検索する方法と、ジャンルを直接選ぶ方法があります。ジャンルは複数選択でき、任意の料理・店名も1件追加できます。同じ検索語は重複して送信しません。ガチャの結果から進むと、その料理1件を選択した状態になります。
- 初期条件は「評価 4.0 以上・口コミ 100 件以上・現在地から 1 km 以内」です。条件と並び順を変更できます。
- 評価は「指定なし・3.5・4.0・4.2・4.5以上」、口コミは「指定なし・50・100・300・500・1,000・5,000件以上」、距離は「100m・500m・1km・3km・5km・10km以内」から選べます。「指定なし」ではその項目が未掲載の店舗も除外しません。
- 各条件の選択肢の末尾にある「自分で入力」を選ぶと、好きな数値を設定できます。評価は0〜5（小数可）、口コミは0〜1,000,000件の整数、距離は0.1〜50km（小数可）です。空欄・範囲外・口コミの小数は現在地取得や検索の前に止めます。評価と口コミの0は「指定なし」と同じ扱いです。既存の選択肢へ戻すと手入力値は検索に使いません。
- 「ガチャ」「お店検索」の画面下部に、全利用者合計の今月の検索回数・月の残り回数・本日の残り回数を表示します。「ルーレット」タブでは非表示です。回数の確認だけでは検索枠を消費せず、Googleへの通信や現在地の取得も行いません。取得に失敗した場合は回数を推測せず、確認できない旨を表示します。
- API による検索は検索ボタンを押したときだけ、選択したジャンルを1件ずつ順に実行します。1ジャンルにつき最大1回分の検索枠を使うため、実行前に使用予定の最大回数を表示します。位置情報の取得は1操作につき1回です。自動の追加ページ取得や自動再試行は行いません。
- Google への検索は、全利用者の合計で **1 日 20 回・1 か月 600 回**までです。いずれかの上限で停止します。日付・月は米国太平洋時間（`America/Los_Angeles`）で切り替わります。
- Googleがジャンルごとに返す最大20候補を条件で絞り、同じ店舗を統合して、選んだ並び順で全体の最大10店舗を表示します。カードには見つかった検索ジャンルを付け、複数ジャンルで見つかった店舗には複数のラベルを表示します。ラベルは検索語であり、Googleの公式カテゴリではありません。周辺の全店舗を網羅した順位ではなく、距離は直線距離です。
- 上限や通信エラーで途中停止した場合、先に取得できた結果を残し、検索できなかったジャンルを案内します。消費回数は成功したジャンル数から推測せず、サーバーが返した共有回数を表示します。
- 条件に合う候補がない場合、条件を自動で緩めず、その旨を表示します。
- API 未設定・利用上限・接続エラーなどの場合にも、通常の Google マップ検索を利用できます。通常検索には評価・口コミ件数の条件は適用されません。

## Google Places 連携の設定

画面とサーバーの検索設定を有効にしています。Cloudflare Accessで本人認証した後、検索ボタンを押したときだけ共有上限を確認してGoogleへ問い合わせます。キーが未登録の場合や上限に達した場合はGoogleを呼びません。

```js
window.LUNCH_GACHA_CONFIG = Object.freeze({
  searchEndpoint: 'https://lunch-gacha-search.choi-tool.workers.dev/search',
  placesEnabled: true
});
```

新しい環境で初回設定をする場合は、画面とサーバーをいったん無効にし、次の準備が完了してから有効化してください。利用を停止する場合も同じ設定に戻して再デプロイします。共有カウンターやAccessポリシーは削除しません。

```javascript
placesEnabled: false
```

```toml
SEARCH_ENABLED = "false"
```

1. [Google Cloud Console](https://console.cloud.google.com/)でこのアプリ用のプロジェクトを用意し、[課金アカウント](https://console.cloud.google.com/billing)を設定して [**Places API (New)**](https://console.cloud.google.com/apis/library/places.googleapis.com) を有効にします。各画面で選択中のプロジェクトを確認してください。
2. [認証情報](https://console.cloud.google.com/apis/credentials)からサーバー用 API キーを作成し、API の制限を **Places API (New) だけ**に限定します。Cloudflare のサーバーから呼び出すため、ブラウザ用のウェブサイト制限は使用しません。API キーを `config.js`、HTML、GitHub に書かないでください。
3. Google の料金と同じ課金アカウントの利用を確認します。評価・口コミ件数を含む検索は **Text Search Enterprise** に該当し、2026 年 11 月 11 日に確認した無料枠は月 1,000 リクエストです。このアプリは月 600 回で止めますが、他のアプリ・プロジェクトの同じ料金区分の利用も合算されます。[割り当てとシステム上限](https://console.cloud.google.com/iam-admin/quotas)で設定可能な上限も確認してください。
4. [Cloudflare ダッシュボード](https://dash.cloudflare.com/)で **Workers Free プラン**を用意し、[サーバー設定手順](./backend/README.md)に従ってログインします。画面と検索 API を同じ Worker から配信し、許可OriginをそのHTTPSオリジンに合わせます。本人限定の Access 設定と、旧 GitHub Pages の公開停止を先に確認してください。
5. Google のキーを Cloudflare の Secret `GOOGLE_PLACES_API_KEY` に登録し、Worker をデプロイします。キー・無料枠・設定を確認後、`SEARCH_ENABLED` を `"true"` にして再デプロイします。
6. 同じ Worker の検索 URL を画面側の設定に登録して有効化し、資産を再生成してから再デプロイします。実際の検索・利用数・上限時の案内を確認します。

```text
https://lunch-gacha-search.choi-tool.workers.dev/search
```

リポジトリのルートで使う主なコマンドは次のとおりです。Secret の入力欄にキーを入力します。

```sh
npx wrangler@4.160.0 login
```

```sh
npx wrangler@4.160.0 deploy --config backend/wrangler.toml
```

```sh
npx wrangler@4.160.0 secret put GOOGLE_PLACES_API_KEY --config backend/wrangler.toml
```

### 上限の仕組みと適用範囲

回数は端末ごとではなく、サーバーの共通カウンターで管理します。同時リクエストでも上限を超えないよう、Google へ送る前に日次・月次の両方を一括で確認して 1 回分を確保します。送信後のエラーやタイムアウトも 1 回として扱い、払い戻しません。カウンターを読み書きできないときも検索を止めます。月次の区切りは、[Google の無料枠が米国太平洋時間の毎月 1 日午前 0 時に更新される](https://developers.google.com/maps/billing-and-pricing/overview)ことに合わせています。

同じ Durable Object を継続使用してください。保存データの削除や別の Worker／名前空間への作り直しは、利用数の連続性を失わせます。この上限は、このサーバーを経由する検索にだけ適用されます。Google のキーを他の用途に使う場合や、同じ課金アカウントの別サービスの費用まで止めるものではありません。**予算アラートは通知機能であり、利用を自動停止しません。**

Cloudflare Workers と SQLite Durable Objects は Free プランの範囲で利用する想定です。Free の利用枠を超えるとリクエストが失敗します。有料プランへ変更すると料金条件が変わります。Google・Cloudflare の無料枠や料金は将来変更される可能性があるため、有効化時に公式資料を確認してください。

サーバーが永続保存するのは日次・月次の集計回数です。店舗結果・現在地・ジャンルは永続保存しません。検索結果には Google Maps と第三者提供元の帰属表示を付けます。通信事業者側の処理も含め、[プライバシーポリシー](privacy.html)・[利用規約](terms.html)を確認してください。

### 設定・検証の状況

画面側とサーバー側の検索設定は有効化する構成へ変更しました。本番反映と実店舗検索の結果は[有効化の実装記録](./_docs/2026-11-12_google-search-enabled.md)で区別して記録します。Cloudflare Access、Google側のキー制限・請求先の利用量・割り当てはリポジトリ外の設定なので、コードのデプロイだけで確認済みとは判断しません。共有上限の設計とモック検証は[店舗検索の実装記録](./_docs/2026-11-11_restaurant-search.md)を参照してください。

### 公式資料

- [Places API (New) のテキスト検索](https://developers.google.com/maps/documentation/places/web-service/text-search)
- [API キーの制限](https://developers.google.com/maps/api-security-best-practices)
- [料金表](https://developers.google.com/maps/billing-and-pricing/pricing)
- [無料枠の更新時刻](https://developers.google.com/maps/billing-and-pricing/overview)
- [利用上限と費用管理](https://developers.google.com/maps/billing-and-pricing/manage-costs)
- [Google Maps URL と候補リスト](https://developers.google.com/maps/documentation/urls/get-started)
- [表示・帰属のポリシー](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Cloudflare Durable Objects の料金・無料枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Workers の利用上限](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare の Secret 設定](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Worker 単位の Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

