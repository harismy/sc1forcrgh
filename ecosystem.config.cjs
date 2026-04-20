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
<<<<<<< HEAD
=======
    },
    {
      name: 'sc1forcr-license-api',
      script: 'license-api.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M'
>>>>>>> 12d9022 (update)
    }
  ]
};
