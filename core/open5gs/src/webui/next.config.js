var path = require('path');

module.exports = {
  webpack: function(config) {
    /*
     * vis-network: Use the pre-built dist bundle instead of the
     * ESM standalone bundle, which is too large for babel transpilation.
     */
    config.resolve = config.resolve || {};
    config.resolve.alias = config.resolve.alias || {};
    config.resolve.alias['vis-network/standalone'] = path.join(
      __dirname, 'node_modules/vis-network/dist/vis-network.min.js'
    );

    /*
     * recharts: Force CJS (lib/) instead of ES6 (es6/) which webpack
     * resolves via the "module" field.  The CJS build is already ES5.
     */
    config.resolve.alias['recharts'] = path.join(
      __dirname, 'node_modules/recharts/lib/index.js'
    );

    /*
     * Remove UglifyJS (ES5 only) — vis-network 9.x, d3 sub-packages,
     * react-smooth, and recharts-scale all ship ES6+ code that
     * UglifyJS cannot parse.  Next.js 3.x / webpack 3 has no built-in
     * Terser support, so we skip minification.  The WebUI is served
     * locally so bundle size is not a concern.
     */
    config.plugins = config.plugins.filter(function(plugin) {
      return plugin.constructor.name !== 'UglifyJsPlugin';
    });

    return config;
  }
};
