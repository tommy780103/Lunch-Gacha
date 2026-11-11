# ランチガチャ

今日の食事をルーレットで選ぶ、ビルド不要の静的 Web アプリです。ジャンルを直接選び、評価・口コミ件数・現在地からの距離でお店を探すこともできます。

[公開サイト](https://tommy780103.github.io/Lunch-Gacha/)

## 構成

- メイン画面・スタイル・ルーレット：ルートの HTML。
- 店舗検索：条件判定、Google Places 連携、画面操作を JavaScript ファイルに分離。
- API 設定：`config.js`。初期状態は API キー未設定・店舗検索無効です。
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
icons/app-icon.svg
icons/apple-touch-icon.png
icons/icon-192.png
icons/icon-512.png
icons/favicon.png
scripts/generate_icons.py
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
node --test tests/search.test.cjs
```

## お店の検索

- ガチャで選ばれた料理から検索する方法と、ジャンルを直接選ぶ方法があります。既存の 13 ジャンルに加えて、任意の料理・ジャンル名も入力できます。
- 初期条件は「評価 4.0 以上・口コミ 100 件以上・現在地から 5 km 以内」です。条件と並び順を変更できます。
- API による検索は検索ボタンを押したときだけ実行し、1 回の操作につき 1 リクエストに制限します。自動の追加ページ取得や自動再試行は行いません。
- Google が返す最大 20 候補を条件で絞り、最大 10 店舗を表示します。周辺の全店舗を網羅した順位ではありません。距離は直線距離です。
- 条件に合う候補がない場合、条件を自動で緩めず、その旨を表示します。
- API 未設定・利用上限・接続エラーなどの場合にも、通常の Google マップ検索を利用できます。通常検索には評価・口コミ件数の条件は適用されません。

## Google Places 連携を有効にする

コードの初期設定は `googleMapsApiKey: ''`、`placesEnabled: false` です。設定完了までは Google Places への店舗検索リクエストを送信しません。キーなしで評価や口コミ件数を取得することはできません。

```js
window.LUNCH_GACHA_CONFIG = Object.freeze({
  googleMapsApiKey: '',
  placesEnabled: false
});
```

1. このアプリ用の Google Cloud プロジェクトを用意し、課金アカウントを設定します。
2. **Maps JavaScript API** と **Places API (New)** を有効にします。
3. ブラウザ専用 API キーを作成します。アプリケーションの制限を「ウェブサイト」にし、公開サイト用に `https://tommy780103.github.io/*` を指定します。ローカル検証用の `http://localhost:8000/*` は必要な期間だけ追加します。
4. API の制限を上記の必要な API に限定します。ブラウザ用キーはページの利用者から見える前提です。サーバー用の無制限キーやサービスアカウント秘密鍵を使わないでください。
5. Cloud Console の「割り当てとシステム上限」で、この検索に対応する実際の割り当て項目を確認し、可能な日次上限を **20 リクエスト**に設定します。表示される項目・変更可否・制限対象を確認するまで、全利用者の合計が制限されるとは判断しないでください。対応する日次上限が設定できなければ、全体の上限を管理するサーバー側処理を用意するか、連携を無効のままにします。
6. 課金アカウント内の他プロジェクトを含め、同じ料金区分の利用状況を確認します。検索の評価・口コミ件数フィールドは **Text Search Enterprise** に該当し、2026 年 11 月 11 日に確認した無料枠は月 1,000 リクエストです。無料枠は同じ課金アカウントの対象利用で共有され、将来変わる可能性があります。
7. キー制限と利用上限を確認した後で、`config.js` の `googleMapsApiKey` にブラウザ用キーを設定し、`placesEnabled` を `true` に変更します。公開後に実際の検索・利用数・エラー時の通常検索への導線を確認します。

**予算アラートは通知機能であり、利用を自動停止しません。** ブラウザ内だけの回数カウントも、端末変更やデータ削除でリセットできるため、全利用者の課金上限には使えません。Google 側の実際の割り当て設定と利用状況の確認が必要です。

店舗結果は画面表示中だけ保持し、評価情報を永続保存しません。検索結果には Google Maps と第三者提供元の帰属表示を付けます。[プライバシーポリシー](privacy.html)・[利用規約](terms.html)も公開します。

### 設定・検証の状況

Google Cloud の課金設定・API キー・割り当て設定は、この実装時点では未確認です。実店舗データによる検索も未実施です。API を利用しない検証結果は [実装記録](./_docs/2026-11-11_restaurant-search.md) に記載します。

### 公式資料

- [Maps JavaScript API のテキスト検索](https://developers.google.com/maps/documentation/javascript/place-search)
- [Place / SearchByTextRequest リファレンス](https://developers.google.com/maps/documentation/javascript/reference/place)
- [API キーの制限](https://developers.google.com/maps/api-security-best-practices)
- [料金表](https://developers.google.com/maps/billing-and-pricing/pricing)
- [利用上限と費用管理](https://developers.google.com/maps/billing-and-pricing/manage-costs)
- [Google Maps URL と候補リスト](https://developers.google.com/maps/documentation/urls/get-started)
- [表示・帰属のポリシー](https://developers.google.com/maps/documentation/javascript/policies)
