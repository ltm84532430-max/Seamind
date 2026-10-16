module.exports = {
  plugins: [
    require('autoprefixer'),
    require('postcss-calc'),
    require('postcss-nested'),
    (() => {
      try {
        const p = require('@unocss/postcss');
        return (p && p.default) ? p.default() : (typeof p === 'function' ? p() : null);
      } catch {
        return null;
      }
    })(),
  ].filter(Boolean),
};
