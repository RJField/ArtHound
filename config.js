module.exports = {
  tables: {
    assets:    process.env.TABLE_ASSETS     || 'Assets',
    products:  process.env.TABLE_PRODUCTS   || 'Product',
    tasks:     process.env.TABLE_TASKS      || 'Tasking',
    templates: process.env.TABLE_TEMPLATES  || 'Task Templates',
    itemTypes: process.env.TABLE_ITEM_TYPES || 'Item Types',
    reviews:   process.env.TABLE_REVIEWS    || 'Asset Reviews',
  },
};
