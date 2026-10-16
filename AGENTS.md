# ランチガチャの開発案内

## 最初に読む

未読の[ワークスペース案内](/Users/tommy/my-workspace/AGENTS.md)、[開発ルール](/Users/tommy/my-workspace/dev/AGENTS.md)、[ツール分類の案内](/Users/tommy/my-workspace/dev/tools/AGENTS.md)を次の順で読みます。

```text
/Users/tommy/my-workspace/AGENTS.md
/Users/tommy/my-workspace/dev/AGENTS.md
/Users/tommy/my-workspace/dev/tools/AGENTS.md
```

README と、関連する直近の実装記録も確認します。

## この案件

- 目的：ルーレットで食事を選ぶ静的 Web アプリ。GitHub Pages で公開します。
- 入口：メイン HTML に画面・CSS・JavaScript がまとまっています。既存の食事データや操作を維持します。
- アイコン：SVG を正本とし、Python スクリプトで PNG を再生成します。ホーム画面画像は正方形・不透明とし、iOS の角丸処理に余白を残します。
- 起動・確認：README のローカルサーバー、画像再生成・寸法確認の手順を使います。公開サイトの確認と実機確認は区別して記録します。
- 作業記録：重要な決定と検証結果を日付付き Markdown へ記録します。

```text
index.html
icons/
scripts/generate_icons.py
_docs/YYYY-MM-DD_内容.md
```
