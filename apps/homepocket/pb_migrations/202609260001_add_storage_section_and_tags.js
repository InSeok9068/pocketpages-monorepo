migrate((app) => {
  const collection = app.findCollectionByNameOrId('homeItems')
  const sectionField = collection.fields.getByName('section')
  const channelField = collection.fields.getByName('channel')

  if (sectionField.values.indexOf('storage') < 0) sectionField.values.push('storage')
  if (channelField.values.indexOf('fridge') < 0) channelField.values.push('fridge')
  if (channelField.values.indexOf('freezer') < 0) channelField.values.push('freezer')

  app.save(collection)
}, (app) => {
  const storageItems = app.findRecordsByFilter(
    'homeItems',
    'section = {:storage} || channel = {:fridge} || channel = {:freezer}',
    '',
    1,
    0,
    { storage: 'storage', fridge: 'fridge', freezer: 'freezer' }
  )

  if (storageItems.length) throw new Error('보관 항목이 남아 있어 스키마를 되돌릴 수 없습니다.')

  const collection = app.findCollectionByNameOrId('homeItems')
  const sectionField = collection.fields.getByName('section')
  const channelField = collection.fields.getByName('channel')
  sectionField.values = sectionField.values.filter((value) => value !== 'storage')
  channelField.values = channelField.values.filter((value) => value !== 'fridge' && value !== 'freezer')

  app.save(collection)
})
