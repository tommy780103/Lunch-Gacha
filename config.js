// 全利用者共通の上限を管理する検索サーバーを設定してから有効にします。
// searchEndpoint は https://<検索サーバー>/search の形式です。
// Google API キーはサーバーのシークレットに保存し、このファイルに記載しません。
// 詳しい設定と有効化手順は README.md を参照してください。
window.LUNCH_GACHA_CONFIG = Object.freeze({
  searchEndpoint: '',
  placesEnabled: false
});
