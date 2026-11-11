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
| `config.js` | Google Maps のブラウザ用キー・有効化設定 |
| `search-core.js` | 条件・距離判定・並び替え・リンク生成 |
| `places-search.js` | SDK の遅延読み込みと 1 回の店舗検索 |
| `search-ui.js` | ジャンル選択、ガチャ連携、結果・状態表示 |
| `privacy.html` / `terms.html` | 公開用の説明ページ |

## 無料枠を前提とする設計

Google Maps JavaScript API の Places ライブラリを使い、GitHub Pages の静的公開を維持します。店舗検索に必要なフィールドだけを取得し、地図の埋め込み・自動追加取得・自動再試行は行いません。

`config.js` は `googleMapsApiKey: ''`、`placesEnabled: false` を初期状態にします。未設定時に API 検索が成功したように見せず、通常の Google マップ検索を案内します。

評価・口コミ件数を含む検索は Text Search Enterprise の対象です。2026 年 11 月 11 日の公式料金表では月 1,000 リクエストが無料ですが、無料利用にも課金設定が必要です。同じ課金アカウント内の同じ料金区分の利用が合算されます。料金・無料枠は将来変更される可能性があります。

全利用者の検索上限はブラウザ内の回数記録だけでは保証できません。実際の Cloud Console の割り当て項目を確認し、対応する日次上限を 20 リクエストに設定する想定です。設定可否・適用範囲の確認までは連携を無効にしておきます。予算アラートだけでは利用は停止しません。

ブラウザ用キーは利用者から参照できるため、ウェブサイト制限と API 制限が必要です。サーバー用の無制限キーは使用しません。

## データと結果の扱い

現在地を使う検索はユーザー操作で実行し、料理・ジャンルと現在地を Google に送ります。店舗結果・現在地・検索条件は画面のメモリ内で扱い、localStorage など本アプリの永続保存先には記録しません。Google Maps と返された第三者提供元の帰属表示を結果欄に付けます。

Google の検索が返す候補数には上限があるため、周辺全店舗の完全なランキングではありません。半径による距離条件は直線距離で判断します。API 側の最低評価指定は 0.5 刻みのため、より細かい条件は取得後の判定で扱います。

## 検証状況

- `node --test tests/search.test.cjs`：13 件成功（しきい値、距離、欠落値、並び順、重複排除、リンク、未設定、SDK 読み込み・失敗復旧、上限・通信エラー）。
- デスクトップのブラウザーで API 未設定時の案内と通常検索リンクを確認。
- 390 px 幅の iframe プレビューで画面の折り返し・選択操作を確認。iPhone 実機の確認ではない。
- 実 API を呼ばないテストデータで、5 候補のうち条件を満たす 2 件だけの表示、評価順・口コミ順、0 件表示、上限到達の表示を確認。
- 条件変更だけでは検索が発生せず、古い結果が消えることを確認。ガチャ終了後のジャンル引き継ぎも確認。
- SDK 初回読み込み失敗で後続の検索が復旧しない問題を修正。再試行はユーザーが再度検索した場合のみ。
- Google Cloud の課金設定・API キー・割り当て設定：未確認。
- 実店舗 API 検索：未実施。
- 公開サイト・iPhone 実機での動作：この記録の作成時点では未確認。

## 参照した公式資料

- https://developers.google.com/maps/documentation/javascript/place-search
- https://developers.google.com/maps/documentation/javascript/reference/place
- https://developers.google.com/maps/documentation/javascript/load-maps-js-api
- https://developers.google.com/maps/documentation/javascript/policies
- https://developers.google.com/maps/api-security-best-practices
- https://developers.google.com/maps/billing-and-pricing/pricing
- https://developers.google.com/maps/billing-and-pricing/manage-costs
- https://developers.google.com/maps/documentation/urls/get-started
