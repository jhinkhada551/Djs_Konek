module.exports = {
  apps: [
    {
      name: 'djs-konek',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000
      }
    },
    {
      name: 'keepalive',
      script: 'keepalive.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        // Set KEEPALIVE_TARGET to the full /health URL you want pinged.
        KEEPALIVE_TARGET: process.env.KEEPALIVE_TARGET || `http://localhost:${process.env.PORT || 3000}/health`,
        KEEPALIVE_INTERVAL_MS: process.env.KEEPALIVE_INTERVAL_MS || 300000
      }
    }
  ]
};
