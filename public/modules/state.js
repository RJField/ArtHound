export const state = {
  products:          [],
  selectedProductId: null,
  assets:            [],
  selectedAssetIds:  new Set(),
  focusedAssetId:    null,
  focusedAsset:      null,
  homeView:          'home',
  taskView:          'list',
  taskSource:        'airtable',  // 'airtable' | 'arthound'
  lastTasks:         null,
};
