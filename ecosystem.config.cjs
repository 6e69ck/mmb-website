module.exports = {
  apps: [{
    name: 'mmb-discord-bot',
    cwd: __dirname,
    script: 'apps/discord-bot/dist/index.js',
    interpreter: process.execPath,
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    autorestart: true,
    kill_timeout: 120000,
    min_uptime: 10000,
    max_restarts: 10,
    exp_backoff_restart_delay: 1000,
    time: true,
    env: { NODE_ENV: 'production' },
  }],
};
