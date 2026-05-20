module.exports = {
  apps: [
    {
      name: 'sc1forcr-nexus-bot',
      script: 'app3.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M'
    },
    {
      name: 'sc1forcr-license-api',
      script: 'license-api.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M'
    }
  ]
};
