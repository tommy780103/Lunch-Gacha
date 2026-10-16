# ランチガチャ

今日の食事をルーレットで選ぶ、単一 HTML の Web アプリです。

[公開サイト](https://tommy780103.github.io/Lunch-Gacha/)

## 構成

- メイン画面・スタイル・動作：ルートの HTML。
- アイコン：アイコン用フォルダー内の SVG が正本。PNG は iPhone ホーム画面用 180 px、汎用 192 / 512 px、favicon 用 48 px。
- 再生成：Python スクリプトから ImageMagick を呼び出します。
- 作業記録：実装記録フォルダーに保存します。

```text
index.html
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
