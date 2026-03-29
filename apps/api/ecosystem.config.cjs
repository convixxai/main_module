/** PM2: from apps/api run `pm2 start ecosystem.config.cjs` then `pm2 save` */
module.exports = {
  apps: [
    {
      name: "convixx-api",
      cwd: __dirname,
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
    },
  ],
};
