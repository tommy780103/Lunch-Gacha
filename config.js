// 本人用サイトと同じWorkerの検索サーバーを利用します。
// 全利用者共通の1日20回・月600回の上限はサーバー側で管理します。
// Google API キーはサーバーのシークレットに保存し、このファイルに記載しません。
// 詳しい設定と有効化手順は README.md を参照してください。
window.LUNCH_GACHA_CONFIG = Object.freeze({
  searchEndpoint: 'https://lunch-gacha-search.choi-tool.workers.dev/search',
  placesEnabled: true
});

