/** @type {import('pocketpages').PageDataLoaderFunc} */
module.exports = ({ meta }) => {
  meta('title', 'About Us')
  meta('description', 'Learn more about our company and mission')
  meta('image', 'https://example.com/about-preview.jpg')

  return {
    // ... other loaded data
  }
}
